-- Payroll for accountants, and paying payroll tax from HR. Owners and admins can let accountants
-- see pay and run payroll. Changing people and the payroll rates stays with owners and admins.
-- What approved pay runs owe the tax office (2400 Payroll Liabilities) can be paid from a bank account.

ALTER TABLE hr.settings ADD COLUMN IF NOT EXISTS accountants_run_payroll BOOLEAN NOT NULL DEFAULT false;

-- Paying payroll tax gets its own journal source, so it isn't mixed up with wages paid
ALTER TABLE accounting.journal_entries DROP CONSTRAINT journal_entries_source_type_check;
ALTER TABLE accounting.journal_entries ADD CONSTRAINT journal_entries_source_type_check CHECK (source_type IN (
  'manual', 'invoice', 'invoice_payment', 'expense', 'bill', 'payment', 'credit_note', 'bank', 'closing', 'asset',
  'depreciation', 'vendor_credit', 'revenue', 'intercompany', 'invoice_cost', 'stock_adjustment',
  'payroll', 'payroll_payment', 'payroll_tax'));

-- Role checks
CREATE FUNCTION hr.can_run_payroll(p_tenant UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT hr.is_manager(p_tenant) OR EXISTS (
    SELECT 1 FROM public.tenant_members m JOIN hr.settings s ON s.tenant_id = m.tenant_id
    WHERE m.tenant_id = p_tenant AND m.user_id = auth.uid() AND m.role = 'accountant' AND s.accountants_run_payroll);
$$;

CREATE FUNCTION hr.require_payroll(p_tenant UUID)
RETURNS VOID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT hr.can_run_payroll(p_tenant) THEN
    IF EXISTS (SELECT 1 FROM hr.settings WHERE tenant_id = p_tenant AND accountants_run_payroll) THEN
      RAISE EXCEPTION 'Only owners, admins and accountants can do that';
    END IF;
    RAISE EXCEPTION 'Only owners and admins can do that';
  END IF;
END;
$$;

-- Pay and payroll can be read by whoever can run payroll
DROP POLICY tenant_rows ON hr.pay_runs;
CREATE POLICY tenant_rows ON hr.pay_runs FOR SELECT TO authenticated USING (hr.can_run_payroll(tenant_id));
DROP POLICY tenant_rows ON hr.pay_lines;
CREATE POLICY tenant_rows ON hr.pay_lines FOR SELECT TO authenticated USING (hr.can_run_payroll(tenant_id));
DROP POLICY tenant_rows ON hr.compensation;
CREATE POLICY tenant_rows ON hr.compensation FOR SELECT TO authenticated USING (hr.can_run_payroll(tenant_id));

-- Only owners and admins choose who runs payroll
CREATE FUNCTION hr.set_accountant_payroll(p_tenant UUID, p_on BOOLEAN)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  INSERT INTO hr.settings (tenant_id, accountants_run_payroll) VALUES (p_tenant, coalesce(p_on, false))
    ON CONFLICT (tenant_id) DO UPDATE SET accountants_run_payroll = EXCLUDED.accountants_run_payroll, updated_at = now();
  RETURN (SELECT row_to_json(s) FROM hr.settings s WHERE tenant_id = p_tenant);
END;
$$;

CREATE OR REPLACE FUNCTION hr.create_pay_run(p_tenant UUID, p_month DATE, p_pay_date DATE)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_start DATE := date_trunc('month', p_month)::date;
  v_end DATE := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  next_number INT;
  new_id UUID;
BEGIN
  PERFORM hr.require_payroll(p_tenant);
  IF p_month IS NULL OR p_pay_date IS NULL THEN
    RAISE EXCEPTION 'Choose a month and a pay date';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 24));
  IF EXISTS (SELECT 1 FROM hr.pay_runs WHERE tenant_id = p_tenant AND status <> 'void' AND period_start = v_start) THEN
    RAISE EXCEPTION 'There''s already a pay run for %', to_char(v_start, 'FMMonth YYYY');
  END IF;
  SELECT coalesce(max(run_number), 0) + 1 INTO next_number FROM hr.pay_runs WHERE tenant_id = p_tenant;
  INSERT INTO hr.pay_runs (tenant_id, run_number, period_start, period_end, pay_date, created_by)
    VALUES (p_tenant, next_number, v_start, v_end, p_pay_date, auth.uid())
    RETURNING id INTO new_id;
  PERFORM hr.fill_run(new_id);
  IF NOT EXISTS (SELECT 1 FROM hr.pay_lines WHERE run_id = new_id) THEN
    RAISE EXCEPTION 'No one is employed in %. Add employees with a start date first.', to_char(v_start, 'FMMonth YYYY');
  END IF;
  RETURN (SELECT row_to_json(r) FROM hr.pay_runs r WHERE id = new_id);
END;
$$;

CREATE OR REPLACE FUNCTION hr.draft_run(p_tenant UUID, p_run UUID)
RETURNS hr.pay_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  run hr.pay_runs;
BEGIN
  PERFORM hr.require_payroll(p_tenant);
  SELECT * INTO run FROM hr.pay_runs WHERE id = p_run AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pay run not found';
  END IF;
  IF run.status <> 'draft' THEN
    RAISE EXCEPTION 'This pay run is % and can''t be changed', run.status;
  END IF;
  RETURN run;
END;
$$;

-- approve_pay_run checks access through draft_run; it is redone so the check is plain to see
CREATE OR REPLACE FUNCTION hr.approve_pay_run(p_tenant UUID, p_run UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  run hr.pay_runs;
  lines JSONB;
BEGIN
  PERFORM hr.require_payroll(p_tenant);
  run := hr.draft_run(p_tenant, p_run);
  IF NOT EXISTS (SELECT 1 FROM hr.pay_lines WHERE run_id = p_run) THEN
    RAISE EXCEPTION 'Add at least one person to the pay run';
  END IF;
  IF run.gross = 0 THEN
    RAISE EXCEPTION 'This pay run has nothing to pay';
  END IF;

  SELECT jsonb_agg(l) INTO lines FROM (
    SELECT jsonb_build_object('account_id', accounting.account_by_code(p_tenant, '6200'), 'debit', sum(gross),
        'cost_center_id', cost_center_id) AS l
      FROM hr.pay_lines WHERE run_id = p_run GROUP BY cost_center_id HAVING sum(gross) > 0
    UNION ALL
    SELECT jsonb_build_object('account_id', accounting.account_by_code(p_tenant, '6210'), 'debit', sum(employer_contributions),
        'cost_center_id', cost_center_id)
      FROM hr.pay_lines WHERE run_id = p_run GROUP BY cost_center_id HAVING sum(employer_contributions) > 0
    UNION ALL
    SELECT jsonb_build_object('account_id', accounting.account_by_code(p_tenant, '2400'),
        'credit', sum(income_tax + employee_contributions + other_deductions + employer_contributions))
      FROM hr.pay_lines WHERE run_id = p_run HAVING sum(income_tax + employee_contributions + other_deductions + employer_contributions) > 0
    UNION ALL
    SELECT jsonb_build_object('account_id', accounting.account_by_code(p_tenant, '2500'), 'credit', sum(net))
      FROM hr.pay_lines WHERE run_id = p_run HAVING sum(net) > 0
  ) t;

  PERFORM accounting.insert_entry(p_tenant, run.pay_date, 'Payroll ' || to_char(run.period_start, 'FMMonth YYYY'),
    'payroll', p_run, NULL, lines);
  UPDATE hr.pay_runs SET status = 'approved', approved_by = auth.uid(), approved_at = now() WHERE id = p_run;
  RETURN (SELECT row_to_json(r) FROM hr.pay_runs r WHERE id = p_run);
END;
$$;

CREATE OR REPLACE FUNCTION hr.pay_pay_run(p_tenant UUID, p_run UUID, p_account UUID, p_date DATE)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  run hr.pay_runs;
BEGIN
  PERFORM hr.require_payroll(p_tenant);
  SELECT * INTO run FROM hr.pay_runs WHERE id = p_run AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pay run not found';
  END IF;
  IF run.status <> 'approved' THEN
    RAISE EXCEPTION 'Approve the pay run before paying it';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM accounting.accounts WHERE id = p_account AND tenant_id = p_tenant AND is_cash AND is_active) THEN
    RAISE EXCEPTION 'Choose a bank or cash account';
  END IF;
  IF p_date IS NULL THEN
    RAISE EXCEPTION 'Choose the date it was paid';
  END IF;
  IF run.net > 0 THEN
    PERFORM accounting.insert_entry(p_tenant, p_date, 'Wages paid ' || to_char(run.period_start, 'FMMonth YYYY'),
      'payroll_payment', p_run, NULL, jsonb_build_array(
        jsonb_build_object('account_id', accounting.account_by_code(p_tenant, '2500'), 'debit', run.net),
        jsonb_build_object('account_id', p_account, 'credit', run.net)));
  END IF;
  UPDATE hr.pay_runs SET status = 'paid', paid_from = p_account, paid_on = p_date WHERE id = p_run;
  RETURN (SELECT row_to_json(r) FROM hr.pay_runs r WHERE id = p_run);
END;
$$;

CREATE OR REPLACE FUNCTION hr.void_pay_run(p_tenant UUID, p_run UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  run hr.pay_runs;
BEGIN
  PERFORM hr.require_payroll(p_tenant);
  SELECT * INTO run FROM hr.pay_runs WHERE id = p_run AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pay run not found';
  END IF;
  IF run.status NOT IN ('approved', 'paid') THEN
    RAISE EXCEPTION 'Only an approved or paid run can be voided. Delete a draft instead.';
  END IF;
  PERFORM accounting.sync_entry(p_tenant, 'payroll_payment', p_run, NULL, NULL, NULL);
  PERFORM accounting.sync_entry(p_tenant, 'payroll', p_run, NULL, NULL, NULL);
  UPDATE hr.pay_runs SET status = 'void' WHERE id = p_run;
  RETURN (SELECT row_to_json(r) FROM hr.pay_runs r WHERE id = p_run);
END;
$$;

CREATE OR REPLACE FUNCTION hr.payslip(p_tenant UUID, p_line UUID)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  line hr.pay_lines;
  run hr.pay_runs;
  person hr.employees;
BEGIN
  SELECT * INTO line FROM hr.pay_lines WHERE id = p_line AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payslip not found';
  END IF;
  SELECT * INTO run FROM hr.pay_runs WHERE id = line.run_id;
  SELECT * INTO person FROM hr.employees WHERE id = line.employee_id;
  IF NOT hr.can_run_payroll(p_tenant) AND (person.user_id IS DISTINCT FROM auth.uid() OR run.status NOT IN ('approved', 'paid')) THEN
    RAISE EXCEPTION 'Payslip not found';
  END IF;
  RETURN json_build_object(
    'line', row_to_json(line),
    'run', json_build_object('id', run.id, 'run_number', run.run_number, 'period_start', run.period_start,
      'period_end', run.period_end, 'pay_date', run.pay_date, 'status', run.status),
    'employee', json_build_object('id', person.id, 'employee_number', person.employee_number,
      'name', btrim(person.first_name || ' ' || person.last_name), 'job_title', person.job_title),
    'company', (SELECT name FROM public.tenants WHERE id = p_tenant),
    'currency', (SELECT base_currency FROM accounting.settings WHERE tenant_id = p_tenant)
  );
END;
$$;

CREATE OR REPLACE FUNCTION hr.overview(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  manager BOOLEAN := hr.is_manager(p_tenant);
  payroll BOOLEAN := hr.can_run_payroll(p_tenant);
BEGIN
  IF NOT hr.is_member(p_tenant) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  RETURN json_build_object(
    'headcount', (SELECT count(*) FROM hr.employees WHERE tenant_id = p_tenant
      AND start_date <= current_date AND (end_date IS NULL OR end_date >= current_date)),
    'starting_soon', (SELECT count(*) FROM hr.employees WHERE tenant_id = p_tenant AND start_date > current_date),
    'out_today', (SELECT count(DISTINCT employee_id) FROM hr.leave_requests WHERE tenant_id = p_tenant
      AND status = 'approved' AND current_date BETWEEN start_date AND end_date),
    -- Requests this person can decide
    'to_decide', (SELECT count(*) FROM hr.leave_requests r JOIN hr.employees e ON e.id = r.employee_id
      LEFT JOIN hr.employees m ON m.id = e.manager_id
      WHERE r.tenant_id = p_tenant AND r.status = 'pending' AND e.user_id IS DISTINCT FROM auth.uid()
        AND (manager OR m.user_id = auth.uid())),
    'by_department', coalesce((
      SELECT json_agg(json_build_object('name', coalesce(d.name, 'No department'), 'count', c.n) ORDER BY c.n DESC)
      FROM (SELECT department_id, count(*) AS n FROM hr.employees WHERE tenant_id = p_tenant
            AND start_date <= current_date AND (end_date IS NULL OR end_date >= current_date) GROUP BY department_id) c
      LEFT JOIN hr.departments d ON d.id = c.department_id
    ), '[]'::json),
    'monthly_pay', CASE WHEN payroll THEN (
      SELECT coalesce(sum(CASE WHEN c.pay_type = 'salary' THEN c.amount / 12 ELSE c.amount * c.hours_per_week * 52 / 12 END), 0)
      FROM hr.compensation c JOIN hr.employees e ON e.id = c.employee_id
      WHERE c.tenant_id = p_tenant AND e.employment_type <> 'contractor'
        AND e.start_date <= current_date AND (e.end_date IS NULL OR e.end_date >= current_date)) END,
    'last_run', CASE WHEN payroll THEN (
      SELECT row_to_json(r) FROM (SELECT id, run_number, period_start, pay_date, status, gross, net FROM hr.pay_runs
        WHERE tenant_id = p_tenant AND status <> 'void' ORDER BY period_start DESC LIMIT 1) r) END,
    'is_manager', manager,
    'is_payroll', payroll
  );
END;
$$;

-- Tax and contributions owed is what approved pay runs put into 2400 Payroll Liabilities, less what has been paid
CREATE FUNCTION hr.liabilities_owed(p_tenant UUID)
RETURNS NUMERIC
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce(sum(l.credit - l.debit), 0) FROM accounting.journal_lines l
  WHERE l.tenant_id = p_tenant AND l.account_id = accounting.account_by_code(p_tenant, '2400');
$$;

CREATE FUNCTION hr.pay_liabilities(p_tenant UUID, p_account UUID, p_date DATE, p_amount NUMERIC, p_memo TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  owed NUMERIC;
  v_amount NUMERIC := round(p_amount, 2);
  new_id UUID;
BEGIN
  PERFORM hr.require_payroll(p_tenant);
  IF NOT EXISTS (SELECT 1 FROM accounting.accounts WHERE id = p_account AND tenant_id = p_tenant AND is_cash AND is_active) THEN
    RAISE EXCEPTION 'Choose a bank or cash account';
  END IF;
  IF p_date IS NULL THEN
    RAISE EXCEPTION 'Choose the date it was paid';
  END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'Enter an amount more than zero';
  END IF;
  IF length(p_memo) > 200 THEN
    RAISE EXCEPTION 'Keep the note under 200 characters';
  END IF;
  -- Two payments at once can't both pay the same amount owed
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 26));
  owed := hr.liabilities_owed(p_tenant);
  IF v_amount > owed THEN
    RAISE EXCEPTION 'That''s more than the % owed', trim_scale(greatest(owed, 0));
  END IF;
  new_id := accounting.insert_entry(p_tenant, p_date, coalesce(nullif(btrim(p_memo), ''), 'Payroll tax and contributions paid'),
    'payroll_tax', NULL, NULL, jsonb_build_array(
      jsonb_build_object('account_id', accounting.account_by_code(p_tenant, '2400'), 'debit', v_amount),
      jsonb_build_object('account_id', p_account, 'credit', v_amount)));
  RETURN json_build_object('entry_id', new_id, 'amount', v_amount, 'owed', hr.liabilities_owed(p_tenant));
END;
$$;

CREATE FUNCTION hr.payroll_liabilities(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM hr.require_payroll(p_tenant);
  RETURN json_build_object(
    'owed', hr.liabilities_owed(p_tenant),
    'payments', coalesce((
      SELECT json_agg(p ORDER BY p.entry_date DESC, p.entry_number DESC) FROM (
        SELECT e.id, e.entry_number, e.entry_date, e.memo,
          (SELECT sum(l.debit) FROM accounting.journal_lines l
            WHERE l.entry_id = e.id AND l.account_id = accounting.account_by_code(p_tenant, '2400')) AS amount,
          (SELECT a.name FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id = l.account_id
            WHERE l.entry_id = e.id AND l.credit > 0 LIMIT 1) AS paid_from,
          EXISTS (SELECT 1 FROM accounting.journal_entries r WHERE r.reversal_of = e.id) AS reversed
        FROM accounting.journal_entries e
        WHERE e.tenant_id = p_tenant AND e.source_type = 'payroll_tax' AND e.reversal_of IS NULL
        ORDER BY e.entry_date DESC, e.entry_number DESC
        LIMIT 20) p
    ), '[]'::json)
  );
END;
$$;

DO $$
DECLARE
  fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY['hr.require_payroll(uuid)', 'hr.liabilities_owed(uuid)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
  END LOOP;
  -- can_run_payroll is used by table policies, so the signed-in user needs it, like is_manager
  FOREACH fn IN ARRAY ARRAY['hr.can_run_payroll(uuid)', 'hr.set_accountant_payroll(uuid, boolean)',
      'hr.pay_liabilities(uuid, uuid, date, numeric, text)', 'hr.payroll_liabilities(uuid)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
