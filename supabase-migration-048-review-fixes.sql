-- Fixes from the database review: payroll voids that would leave paid tax owing back, hand-entered
-- payroll tax that survives later edits, invoice numbers handed out by the database, locked invoice
-- columns, the lock-date race, protection for the ledger's audit trail, tighter grants, same-company
-- links between records, faster HR / scheduler / chat / social row checks, and a year's retention
-- for closed chats.

-- 1. Voiding a pay run whose tax and contributions were already paid would leave the company owed
--    money on Payroll Liabilities. Refuse that.
CREATE OR REPLACE FUNCTION hr.void_pay_run(p_tenant uuid, p_run uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  run hr.pay_runs;
  run_owes NUMERIC;
BEGIN
  PERFORM hr.require_payroll(p_tenant);
  SELECT * INTO run FROM hr.pay_runs WHERE id = p_run AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pay run not found';
  END IF;
  IF run.status NOT IN ('approved', 'paid') THEN
    RAISE EXCEPTION 'Only an approved or paid run can be voided. Delete a draft instead.';
  END IF;
  -- Same lock as paying the liabilities, so a payment can't land between the check and the void
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 26));
  SELECT coalesce(sum(income_tax + employee_contributions + other_deductions + employer_contributions), 0)
    INTO run_owes FROM hr.pay_lines WHERE run_id = p_run;
  IF hr.liabilities_owed(p_tenant) - run_owes < 0 THEN
    RAISE EXCEPTION 'This run''s tax and contributions have already been paid, so it can''t be voided';
  END IF;
  PERFORM accounting.sync_entry(p_tenant, 'payroll_payment', p_run, NULL, NULL, NULL);
  PERFORM accounting.sync_entry(p_tenant, 'payroll', p_run, NULL, NULL, NULL);
  UPDATE hr.pay_runs SET status = 'void' WHERE id = p_run;
  RETURN (SELECT row_to_json(r) FROM hr.pay_runs r WHERE id = p_run);
END;
$function$;

-- 2. Hand-entered tax and deductions stay put on later edits until cleared with an empty value
ALTER TABLE hr.pay_lines
  ADD COLUMN IF NOT EXISTS income_tax_set BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS employee_set BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS employer_set BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS other_set BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION hr.update_pay_line(p_tenant uuid, p_line uuid, p_data jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  line hr.pay_lines;
  rates hr.settings;
  v_hours NUMERIC;
  v_additions NUMERIC;
  v_base NUMERIC;
  v_gross NUMERIC;
  v_tax NUMERIC;
  v_employee NUMERIC;
  v_other NUMERIC;
  v_employer NUMERIC;
  v_tax_set BOOLEAN;
  v_employee_set BOOLEAN;
  v_other_set BOOLEAN;
  v_employer_set BOOLEAN;
  amount_of CONSTANT TEXT := 'Amounts must be zero or more';
BEGIN
  SELECT * INTO line FROM hr.pay_lines WHERE id = p_line AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pay line not found';
  END IF;
  PERFORM hr.draft_run(p_tenant, line.run_id);
  SELECT * INTO rates FROM hr.settings WHERE tenant_id = p_tenant;

  v_hours := CASE WHEN line.pay_type = 'hourly' THEN coalesce(nullif(p_data->>'hours', '')::numeric, line.hours) END;
  v_additions := coalesce(nullif(p_data->>'additions', '')::numeric, line.additions);
  IF v_additions < 0 OR v_additions >= 1e10 OR (v_hours IS NOT NULL AND (v_hours < 0 OR v_hours > 744)) THEN
    RAISE EXCEPTION '%', amount_of;
  END IF;
  v_base := CASE WHEN line.pay_type = 'hourly' THEN round(v_hours * line.rate, 2) ELSE line.base_pay END;
  v_gross := greatest(v_base - line.unpaid_deduction, 0) + round(v_additions, 2);

  -- A value sent is kept as typed; an empty value goes back to the company rate; a field left out
  -- keeps a typed value, otherwise follows the rate
  IF nullif(p_data->>'income_tax', '') IS NOT NULL THEN
    v_tax := round((p_data->>'income_tax')::numeric, 2); v_tax_set := true;
  ELSIF NOT (p_data ? 'income_tax') AND line.income_tax_set THEN
    v_tax := line.income_tax; v_tax_set := true;
  ELSE
    v_tax := round(v_gross * rates.income_tax_rate / 100, 2); v_tax_set := false;
  END IF;

  IF nullif(p_data->>'employee_contributions', '') IS NOT NULL THEN
    v_employee := round((p_data->>'employee_contributions')::numeric, 2); v_employee_set := true;
  ELSIF NOT (p_data ? 'employee_contributions') AND line.employee_set THEN
    v_employee := line.employee_contributions; v_employee_set := true;
  ELSE
    v_employee := round(v_gross * rates.employee_rate / 100, 2); v_employee_set := false;
  END IF;

  IF nullif(p_data->>'other_deductions', '') IS NOT NULL THEN
    v_other := round((p_data->>'other_deductions')::numeric, 2); v_other_set := true;
  ELSIF p_data ? 'other_deductions' THEN
    v_other := 0; v_other_set := false;
  ELSE
    v_other := round(line.other_deductions, 2); v_other_set := line.other_set;
  END IF;

  IF nullif(p_data->>'employer_contributions', '') IS NOT NULL THEN
    v_employer := round((p_data->>'employer_contributions')::numeric, 2); v_employer_set := true;
  ELSIF NOT (p_data ? 'employer_contributions') AND line.employer_set THEN
    v_employer := line.employer_contributions; v_employer_set := true;
  ELSE
    v_employer := round(v_gross * rates.employer_rate / 100, 2); v_employer_set := false;
  END IF;

  IF least(v_tax, v_employee, v_other, v_employer) < 0 THEN
    RAISE EXCEPTION '%', amount_of;
  END IF;
  IF v_tax + v_employee + v_other > v_gross THEN
    RAISE EXCEPTION 'Deductions can''t be more than the gross pay';
  END IF;
  IF length(p_data->>'note') > 200 THEN
    RAISE EXCEPTION 'Keep the note under 200 characters';
  END IF;

  UPDATE hr.pay_lines SET hours = v_hours, base_pay = v_base, additions = round(v_additions, 2), gross = v_gross,
      income_tax = v_tax, employee_contributions = v_employee, other_deductions = v_other, employer_contributions = v_employer,
      income_tax_set = v_tax_set, employee_set = v_employee_set, other_set = v_other_set, employer_set = v_employer_set,
      net = v_gross - v_tax - v_employee - v_other,
      note = CASE WHEN p_data ? 'note' THEN nullif(btrim(p_data->>'note'), '') ELSE note END
    WHERE id = p_line;
  PERFORM hr.refresh_run_totals(line.run_id);
  RETURN (SELECT row_to_json(l) FROM hr.pay_lines l WHERE id = p_line);
END;
$function$;

-- Recalculating starts every line again from the company rates
CREATE OR REPLACE FUNCTION hr.calc_line(p_run uuid, p_employee uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  run hr.pay_runs;
  person hr.employees;
  pay hr.compensation;
  rates hr.settings;
  month_days INT;
  worked_from DATE;
  worked_to DATE;
  worked_days INT;
  unpaid NUMERIC;
  v_hours NUMERIC;
  v_base NUMERIC;
  v_unpaid NUMERIC := 0;
  v_gross NUMERIC;
BEGIN
  SELECT * INTO run FROM hr.pay_runs WHERE id = p_run;
  SELECT * INTO person FROM hr.employees WHERE id = p_employee;
  SELECT * INTO pay FROM hr.compensation WHERE employee_id = p_employee;
  SELECT * INTO rates FROM hr.settings WHERE tenant_id = run.tenant_id;

  month_days := hr.working_days(run.tenant_id, run.period_start, run.period_end);
  worked_from := greatest(run.period_start, person.start_date);
  worked_to := least(run.period_end, coalesce(person.end_date, run.period_end));
  worked_days := CASE WHEN worked_to >= worked_from THEN hr.working_days(run.tenant_id, worked_from, worked_to) ELSE 0 END;

  -- Unpaid leave days that fall in this month
  SELECT coalesce(sum(CASE WHEN r.half_day THEN 0.5
      ELSE hr.working_days(run.tenant_id, greatest(r.start_date, worked_from), least(r.end_date, worked_to)) END), 0)
    INTO unpaid
    FROM hr.leave_requests r JOIN hr.leave_types t ON t.id = r.leave_type_id
    WHERE r.employee_id = p_employee AND r.status = 'approved' AND NOT t.paid
      AND r.start_date <= worked_to AND r.end_date >= worked_from;

  IF coalesce(pay.pay_type, 'salary') = 'salary' THEN
    -- A month's salary, less any part of the month before they started or after they left
    v_base := round(coalesce(pay.amount, 0) / 12 * CASE WHEN month_days = 0 THEN 0 ELSE worked_days::numeric / month_days END, 2);
    v_unpaid := CASE WHEN month_days = 0 THEN 0 ELSE round(coalesce(pay.amount, 0) / 12 / month_days * unpaid, 2) END;
    v_hours := NULL;
  ELSE
    -- Hourly pay starts from their usual hours on the days they worked, less unpaid leave
    v_hours := round(pay.hours_per_week / 5 * greatest(worked_days - unpaid, 0), 2);
    v_base := round(v_hours * pay.amount, 2);
  END IF;
  v_gross := greatest(v_base - v_unpaid, 0);

  INSERT INTO hr.pay_lines (tenant_id, run_id, employee_id, pay_type, rate, hours, base_pay, unpaid_days, unpaid_deduction,
      additions, gross, income_tax, employee_contributions, other_deductions, net, employer_contributions, cost_center_id)
    VALUES (run.tenant_id, p_run, p_employee, coalesce(pay.pay_type, 'salary'), coalesce(pay.amount, 0), v_hours, v_base,
      unpaid, v_unpaid, 0, v_gross,
      round(v_gross * rates.income_tax_rate / 100, 2), round(v_gross * rates.employee_rate / 100, 2), 0,
      v_gross - round(v_gross * rates.income_tax_rate / 100, 2) - round(v_gross * rates.employee_rate / 100, 2),
      round(v_gross * rates.employer_rate / 100, 2), person.cost_center_id)
    ON CONFLICT (run_id, employee_id) DO UPDATE SET
      pay_type = EXCLUDED.pay_type, rate = EXCLUDED.rate, hours = EXCLUDED.hours, base_pay = EXCLUDED.base_pay,
      unpaid_days = EXCLUDED.unpaid_days, unpaid_deduction = EXCLUDED.unpaid_deduction, additions = 0,
      gross = EXCLUDED.gross, income_tax = EXCLUDED.income_tax, employee_contributions = EXCLUDED.employee_contributions,
      other_deductions = 0, net = EXCLUDED.net, employer_contributions = EXCLUDED.employer_contributions,
      cost_center_id = EXCLUDED.cost_center_id, note = NULL,
      income_tax_set = false, employee_set = false, employer_set = false, other_set = false;
END;
$function$;

-- 3. Invoice numbers come from the database; the number and customer details can't be edited later;
--    every line needs a real quantity and price
CREATE OR REPLACE FUNCTION accounting.prepare_invoice()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  home TEXT := accounting.base_currency(NEW.tenant_id);
  paid NUMERIC;
  credited NUMERIC;
  refunded NUMERIC;
  number_like CONSTANT TEXT := '^\s*[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?\s*$';
BEGIN
  IF jsonb_typeof(NEW.line_items) <> 'array' OR jsonb_array_length(NEW.line_items) = 0 THEN
    RAISE EXCEPTION 'Add at least one line item';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.line_items) l
    WHERE jsonb_typeof(l) <> 'object'
       OR jsonb_typeof(l->'quantity') NOT IN ('number', 'string') OR jsonb_typeof(l->'unit_price') NOT IN ('number', 'string')
       OR (l->>'quantity') !~ number_like OR (l->>'unit_price') !~ number_like
  ) THEN
    RAISE EXCEPTION 'Each line needs a quantity and a unit price that are numbers';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.line_items) l
    LEFT JOIN accounting.tax_rates t ON t.id::text = l->>'tax_rate_id' AND t.tenant_id = NEW.tenant_id
    WHERE coalesce(l->>'tax_rate_id', '') <> '' AND t.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Tax rate not found';
  END IF;

  NEW.currency := upper(coalesce(NEW.currency, home));
  IF NEW.currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'Enter a three-letter currency code';
  END IF;
  IF NEW.currency = home THEN
    NEW.exchange_rate := 1;
  END IF;

  SELECT
    sum(base),
    sum(round(base * coalesce(rate, 0) / 100, 2))
  INTO NEW.subtotal, NEW.tax_amount
  FROM (
    SELECT round((l->>'quantity')::numeric * (l->>'unit_price')::numeric, 2) AS base, t.rate
    FROM jsonb_array_elements(NEW.line_items) l
    LEFT JOIN accounting.tax_rates t ON t.id::text = l->>'tax_rate_id'
  ) lines;
  NEW.amount := NEW.subtotal + NEW.tax_amount;
  NEW.base_amount := round(NEW.subtotal * NEW.exchange_rate, 2) + round(NEW.tax_amount * NEW.exchange_rate, 2);

  IF TG_OP = 'INSERT' THEN
    NEW.status := 'draft';
    NEW.amount_paid := 0;
    NEW.amount_credited := 0;
    NEW.base_settled := 0;
    NEW.paid_at := NULL;

    -- The next INV-0001 style number, under the same lock every invoice-creating function takes
    NEW.invoice_number := nullif(btrim(NEW.invoice_number), '');
    IF NEW.invoice_number IS NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text, 7));
      SELECT 'INV-' || lpad((coalesce(max(substring(i.invoice_number FROM '^INV-(\d+)$')::bigint), 0) + 1)::text, 4, '0')
        INTO NEW.invoice_number
        FROM accounting.invoices i WHERE i.tenant_id = NEW.tenant_id;
    ELSIF EXISTS (SELECT 1 FROM accounting.invoices i WHERE i.tenant_id = NEW.tenant_id AND i.invoice_number = NEW.invoice_number) THEN
      RAISE EXCEPTION 'Invoice number % is already used', NEW.invoice_number;
    END IF;
  ELSE
    NEW.tenant_id := OLD.tenant_id;
    NEW.invoice_number := OLD.invoice_number;
    IF OLD.status = 'void' AND (NEW.status <> 'void' OR NEW.amount <> OLD.amount) THEN
      RAISE EXCEPTION 'A void invoice cannot be changed';
    END IF;
    IF NEW.status = 'draft' AND OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'A posted invoice cannot go back to draft. Void it instead.';
    END IF;
    IF NEW.customer_id IS DISTINCT FROM OLD.customer_id AND OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'The customer can only be changed on a draft invoice';
    END IF;

    SELECT coalesce(sum(amount), 0) INTO paid
      FROM accounting.payments WHERE invoice_id = NEW.id AND voided_at IS NULL;
    SELECT coalesce(sum(amount), 0), coalesce(sum(amount) FILTER (WHERE refund_account_id IS NOT NULL), 0)
      INTO credited, refunded
      FROM accounting.credit_notes WHERE invoice_id = NEW.id AND voided_at IS NULL;

    IF (paid > 0 OR credited > 0)
       AND (NEW.currency <> OLD.currency OR NEW.exchange_rate <> OLD.exchange_rate) THEN
      RAISE EXCEPTION 'The currency and rate cannot change once money has been recorded against this invoice';
    END IF;

    SELECT
      coalesce((SELECT sum(control_amount) FROM accounting.payments WHERE invoice_id = NEW.id AND voided_at IS NULL), 0)
      + coalesce((SELECT sum(base_amount) FROM accounting.credit_notes
                  WHERE invoice_id = NEW.id AND voided_at IS NULL AND refund_account_id IS NULL), 0)
    INTO NEW.base_settled;

    paid := paid - refunded;
    IF paid < 0 THEN
      RAISE EXCEPTION 'Void this invoice''s refunds first';
    END IF;
    NEW.amount_paid := paid;
    NEW.amount_credited := credited;

    IF NEW.status = 'void' THEN
      IF paid + credited > 0 THEN
        RAISE EXCEPTION 'Void this invoice''s payments and credit notes first';
      END IF;
    ELSIF NEW.status <> 'draft' THEN
      IF NEW.amount < paid + credited THEN
        RAISE EXCEPTION 'The total cannot be less than what has been paid and credited';
      END IF;
      IF credited > 0 AND NEW.tax_amount <> OLD.tax_amount THEN
        RAISE EXCEPTION 'Void this invoice''s credit notes before changing its tax';
      END IF;
      NEW.status := CASE
        WHEN NEW.amount = paid + credited THEN 'paid'
        WHEN paid + credited > 0 THEN 'partial'
        ELSE 'sent'
      END;
    END IF;

    SELECT CASE WHEN NEW.status = 'paid' THEN max(payment_date)::timestamp END INTO NEW.paid_at
      FROM accounting.payments WHERE invoice_id = NEW.id AND voided_at IS NULL;
  END IF;

  -- The customer's name and email always come from the customer record, never typed in
  IF TG_OP = 'INSERT' OR NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    SELECT name, email INTO NEW.customer_name, NEW.customer_email
      FROM accounting.customers WHERE id = NEW.customer_id AND tenant_id = NEW.tenant_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Customer not found';
    END IF;
  ELSIF NEW.customer_name IS DISTINCT FROM OLD.customer_name OR NEW.customer_email IS DISTINCT FROM OLD.customer_email THEN
    SELECT c.name, c.email INTO NEW.customer_name, NEW.customer_email
      FROM accounting.customers c WHERE c.id = NEW.customer_id AND c.tenant_id = NEW.tenant_id;
    IF NOT FOUND THEN
      NEW.customer_name := OLD.customer_name;
      NEW.customer_email := OLD.customer_email;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- 4. The app writes only the columns it edits; totals, payments and customer details are the database's
REVOKE INSERT, UPDATE ON accounting.invoices FROM authenticated;
GRANT INSERT (tenant_id, invoice_number, customer_id, invoice_date, due_date, description, amount, cost_center_id,
  currency, exchange_rate, line_items) ON accounting.invoices TO authenticated;
GRANT UPDATE (customer_id, invoice_date, due_date, description, amount, cost_center_id, currency, exchange_rate,
  line_items, status, updated_at) ON accounting.invoices TO authenticated;

-- 5. Posting and moving the lock date take the same company lock, so nothing posts into a period
--    that is being locked
CREATE OR REPLACE FUNCTION accounting.insert_entry(p_tenant uuid, p_date date, p_memo text, p_source text, p_source_id uuid, p_reversal_of uuid, p_lines jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  new_id UUID;
  next_number BIGINT;
  total_debit NUMERIC;
  total_credit NUMERIC;
  locked_through DATE;
BEGIN
  -- Keeps entry numbers gap-free when two postings race, and holds the lock date still while posting
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 0));

  SELECT lock_date INTO locked_through FROM accounting.settings WHERE tenant_id = p_tenant;
  IF p_date <= locked_through THEN
    RAISE EXCEPTION 'The books are locked through %. Use a later date.', locked_through;
  END IF;

  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'A journal entry needs at least two lines';
  END IF;

  SELECT
    coalesce(sum(round(coalesce((l->>'debit')::numeric, 0), 2)), 0),
    coalesce(sum(round(coalesce((l->>'credit')::numeric, 0), 2)), 0)
  INTO total_debit, total_credit
  FROM jsonb_array_elements(p_lines) l;

  IF total_debit <> total_credit THEN
    RAISE EXCEPTION 'Debits (%) must equal credits (%)', total_debit, total_credit;
  END IF;
  IF total_debit = 0 THEN
    RAISE EXCEPTION 'A journal entry needs an amount';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) l
    LEFT JOIN accounting.accounts a
      ON a.id = (l->>'account_id')::uuid AND a.tenant_id = p_tenant
    WHERE a.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Account not found';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) l
    LEFT JOIN accounting.cost_centers c
      ON c.id = nullif(l->>'cost_center_id', '')::uuid AND c.tenant_id = p_tenant
    WHERE nullif(l->>'cost_center_id', '') IS NOT NULL AND c.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Cost center not found';
  END IF;

  SELECT coalesce(max(entry_number), 0) + 1 INTO next_number
    FROM accounting.journal_entries WHERE tenant_id = p_tenant;

  INSERT INTO accounting.journal_entries
      (tenant_id, entry_number, entry_date, memo, source_type, source_id, reversal_of)
    VALUES (p_tenant, next_number, p_date, p_memo, p_source, p_source_id, p_reversal_of)
    RETURNING id INTO new_id;

  INSERT INTO accounting.journal_lines (tenant_id, entry_id, account_id, debit, credit, cost_center_id)
    SELECT p_tenant, new_id, (l->>'account_id')::uuid,
      round(coalesce((l->>'debit')::numeric, 0), 2),
      round(coalesce((l->>'credit')::numeric, 0), 2),
      nullif(l->>'cost_center_id', '')::uuid
    FROM jsonb_array_elements(p_lines) l;

  RETURN new_id;
END;
$function$;

CREATE OR REPLACE FUNCTION accounting.set_lock_date(p_tenant uuid, p_date date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  member_role TEXT := accounting.require_manager(p_tenant);
  current_lock DATE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 0));
  SELECT lock_date INTO current_lock FROM accounting.settings WHERE tenant_id = p_tenant;

  IF p_date > current_date THEN
    RAISE EXCEPTION 'The lock date cannot be in the future';
  END IF;
  IF member_role <> 'owner' AND (p_date IS NULL OR p_date < current_lock) THEN
    RAISE EXCEPTION 'Only the owner can reopen a locked period';
  END IF;

  INSERT INTO accounting.settings (tenant_id, lock_date) VALUES (p_tenant, p_date)
    ON CONFLICT (tenant_id) DO UPDATE SET lock_date = p_date, updated_at = now();
END;
$function$;

CREATE OR REPLACE FUNCTION accounting.close_year(p_tenant uuid, p_date date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  current_lock DATE;
  entry_lines JSONB;
  total NUMERIC;
  retained UUID := accounting.account_by_code(p_tenant, '3100');
  new_id UUID;
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 0));

  IF p_date IS NULL OR p_date > current_date THEN
    RAISE EXCEPTION 'Choose a year-end date that has passed';
  END IF;
  SELECT lock_date INTO current_lock FROM accounting.settings WHERE tenant_id = p_tenant;
  IF p_date <= current_lock THEN
    RAISE EXCEPTION 'That date is already locked';
  END IF;

  SELECT
    jsonb_agg(jsonb_build_object('account_id', account_id, 'debit', greatest(-net, 0), 'credit', greatest(net, 0))),
    sum(net)
  INTO entry_lines, total
  FROM (
    SELECT l.account_id, sum(l.debit - l.credit) AS net
    FROM accounting.journal_lines l
    JOIN accounting.journal_entries e ON e.id = l.entry_id
    JOIN accounting.accounts a ON a.id = l.account_id
    WHERE l.tenant_id = p_tenant AND a.type IN ('revenue', 'expense') AND e.entry_date <= p_date
    GROUP BY l.account_id
    HAVING sum(l.debit - l.credit) <> 0
  ) balances;

  IF entry_lines IS NULL THEN
    RAISE EXCEPTION 'There is nothing to close';
  END IF;
  IF total <> 0 THEN
    entry_lines := entry_lines || jsonb_build_object(
      'account_id', retained, 'debit', greatest(total, 0), 'credit', greatest(-total, 0)
    );
  END IF;

  new_id := accounting.insert_entry(
    p_tenant, p_date, 'Year-end close to ' || p_date, 'closing', NULL, NULL, entry_lines
  );

  INSERT INTO accounting.settings (tenant_id, lock_date) VALUES (p_tenant, p_date)
    ON CONFLICT (tenant_id) DO UPDATE SET lock_date = p_date, updated_at = now();

  RETURN new_id;
END;
$function$;

-- 6. The audit trail stays: stocked items, ledger rows and posted payroll / expense claims can't
--    be changed or deleted, except when the whole company is deleted
CREATE OR REPLACE FUNCTION inventory.protect_valued_item()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  -- Deleting the whole company takes its books with it
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id) THEN
    RETURN OLD;
  END IF;
  IF OLD.stock_value <> 0 THEN
    RAISE EXCEPTION 'Adjust % down to zero before deleting it, so its value comes off the books', OLD.name;
  END IF;
  IF OLD.quantity <> 0 THEN
    RAISE EXCEPTION 'Adjust % down to zero before deleting it', OLD.name;
  END IF;
  IF EXISTS (SELECT 1 FROM inventory.movements m WHERE m.item_id = OLD.id) THEN
    RAISE EXCEPTION '% has stock history, so it can''t be deleted', OLD.name;
  END IF;
  RETURN OLD;
END;
$function$;
REVOKE EXECUTE ON FUNCTION inventory.protect_valued_item() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION accounting.protect_journal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'Posted journal entries can''t be changed or deleted. Post a reversing entry instead.';
END;
$function$;
REVOKE EXECUTE ON FUNCTION accounting.protect_journal() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS protect_journal ON accounting.journal_entries;
CREATE TRIGGER protect_journal BEFORE UPDATE OR DELETE ON accounting.journal_entries
  FOR EACH ROW EXECUTE FUNCTION accounting.protect_journal();
DROP TRIGGER IF EXISTS protect_journal ON accounting.journal_lines;
CREATE TRIGGER protect_journal BEFORE UPDATE OR DELETE ON accounting.journal_lines
  FOR EACH ROW EXECUTE FUNCTION accounting.protect_journal();

CREATE OR REPLACE FUNCTION hr.protect_posted_run()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF OLD.status <> 'draft' AND EXISTS (SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id) THEN
    RAISE EXCEPTION 'Only a draft pay run can be deleted. Void it instead.';
  END IF;
  RETURN OLD;
END;
$function$;
REVOKE EXECUTE ON FUNCTION hr.protect_posted_run() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS protect_posted_run ON hr.pay_runs;
CREATE TRIGGER protect_posted_run BEFORE DELETE ON hr.pay_runs
  FOR EACH ROW EXECUTE FUNCTION hr.protect_posted_run();

CREATE OR REPLACE FUNCTION hr.protect_posted_claim()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  -- Approved, paid and void claims have ledger entries behind them
  IF OLD.status NOT IN ('submitted', 'rejected', 'cancelled') AND EXISTS (SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id) THEN
    RAISE EXCEPTION 'An approved, paid or void expense claim can''t be deleted';
  END IF;
  RETURN OLD;
END;
$function$;
REVOKE EXECUTE ON FUNCTION hr.protect_posted_claim() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS protect_posted_claim ON hr.expense_claims;
CREATE TRIGGER protect_posted_claim BEFORE DELETE ON hr.expense_claims
  FOR EACH ROW EXECUTE FUNCTION hr.protect_posted_claim();

-- 7. Only owners, admins and accountants write expenses directly; amounts stay in range
DROP POLICY IF EXISTS tenant_writes ON accounting.expenses;
DROP POLICY IF EXISTS finance_inserts ON accounting.expenses;
DROP POLICY IF EXISTS finance_updates ON accounting.expenses;
DROP POLICY IF EXISTS finance_deletes ON accounting.expenses;
CREATE POLICY finance_inserts ON accounting.expenses FOR INSERT TO authenticated
  WITH CHECK (tenant_id IN (SELECT tm.tenant_id FROM public.tenant_members tm
    WHERE tm.user_id = (SELECT auth.uid()) AND tm.role IN ('owner', 'admin', 'accountant')));
CREATE POLICY finance_updates ON accounting.expenses FOR UPDATE TO authenticated
  USING (tenant_id IN (SELECT tm.tenant_id FROM public.tenant_members tm
    WHERE tm.user_id = (SELECT auth.uid()) AND tm.role IN ('owner', 'admin', 'accountant')))
  WITH CHECK (tenant_id IN (SELECT tm.tenant_id FROM public.tenant_members tm
    WHERE tm.user_id = (SELECT auth.uid()) AND tm.role IN ('owner', 'admin', 'accountant')));
CREATE POLICY finance_deletes ON accounting.expenses FOR DELETE TO authenticated
  USING (tenant_id IN (SELECT tm.tenant_id FROM public.tenant_members tm
    WHERE tm.user_id = (SELECT auth.uid()) AND tm.role IN ('owner', 'admin', 'accountant')));
ALTER TABLE accounting.expenses DROP CONSTRAINT IF EXISTS expenses_amount_ceiling;
ALTER TABLE accounting.expenses ADD CONSTRAINT expenses_amount_ceiling CHECK (amount < 1e10);

-- 8. Companies, members and invites change only through their functions
REVOKE ALL ON public.tenants, public.tenant_members, public.tenant_invites FROM anon, authenticated;
GRANT SELECT ON public.tenants, public.tenant_members TO authenticated;

-- 9. Linked records must belong to the same company
ALTER TABLE accounting.cost_centers DROP CONSTRAINT IF EXISTS cost_centers_tenant_id_id_key;
ALTER TABLE accounting.cost_centers ADD CONSTRAINT cost_centers_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE accounting.customers DROP CONSTRAINT IF EXISTS customers_tenant_id_id_key;
ALTER TABLE accounting.customers ADD CONSTRAINT customers_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE crm.automations DROP CONSTRAINT IF EXISTS automations_tenant_id_id_key;
ALTER TABLE crm.automations ADD CONSTRAINT automations_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE accounting.invoices DROP CONSTRAINT IF EXISTS invoices_cost_center_id_fkey;
ALTER TABLE accounting.invoices ADD CONSTRAINT invoices_cost_center_id_fkey
  FOREIGN KEY (tenant_id, cost_center_id) REFERENCES accounting.cost_centers (tenant_id, id);
ALTER TABLE accounting.expenses DROP CONSTRAINT IF EXISTS expenses_cost_center_id_fkey;
ALTER TABLE accounting.expenses ADD CONSTRAINT expenses_cost_center_id_fkey
  FOREIGN KEY (tenant_id, cost_center_id) REFERENCES accounting.cost_centers (tenant_id, id);
ALTER TABLE crm.contacts DROP CONSTRAINT IF EXISTS contacts_customer_id_fkey;
ALTER TABLE crm.contacts ADD CONSTRAINT contacts_customer_id_fkey
  FOREIGN KEY (tenant_id, customer_id) REFERENCES accounting.customers (tenant_id, id) ON DELETE SET NULL (customer_id);
ALTER TABLE crm.companies DROP CONSTRAINT IF EXISTS companies_customer_id_fkey;
ALTER TABLE crm.companies ADD CONSTRAINT companies_customer_id_fkey
  FOREIGN KEY (tenant_id, customer_id) REFERENCES accounting.customers (tenant_id, id) ON DELETE SET NULL (customer_id);
ALTER TABLE crm.activities DROP CONSTRAINT IF EXISTS activities_automation_id_fkey;
ALTER TABLE crm.activities ADD CONSTRAINT activities_automation_id_fkey
  FOREIGN KEY (tenant_id, automation_id) REFERENCES crm.automations (tenant_id, id) ON DELETE SET NULL (automation_id);
CREATE INDEX IF NOT EXISTS idx_crm_activities_automation ON crm.activities (automation_id) WHERE automation_id IS NOT NULL;

-- 10. A revoked API key's requests aren't logged against it
CREATE OR REPLACE FUNCTION integrations.api_log(p_key text, p_method text, p_path text, p_status integer, p_ms integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  k RECORD;
BEGIN
  IF p_key IS NULL OR p_key !~ '^gk_[0-9a-f]{48}$' OR coalesce(p_method, '') NOT IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')
     OR coalesce(p_status, 0) NOT BETWEEN 100 AND 599 THEN
    RETURN;
  END IF;
  SELECT x.id, x.tenant_id INTO k FROM integrations.api_keys x
    WHERE x.key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex') AND x.revoked_at IS NULL;
  IF k.id IS NULL THEN
    RETURN;
  END IF;
  IF (SELECT count(*) FROM integrations.api_requests r WHERE r.key_id = k.id AND r.at > now() - interval '1 day') >= 2000 THEN
    RETURN;
  END IF;
  INSERT INTO integrations.api_requests (tenant_id, key_id, method, path, status, duration_ms)
    VALUES (k.tenant_id, k.id, p_method, left(regexp_replace(coalesce(p_path, ''), '[^A-Za-z0-9/_.-]', '', 'g'), 200),
      p_status, CASE WHEN p_ms BETWEEN 0 AND 600000 THEN p_ms END);
END;
$function$;

-- 11. Row checks worked out once per query instead of once per row. Same rules as before:
--   my_tenant_ids          = hr.is_member          (any member)
--   my_manager_tenant_ids  = hr.is_manager         (owner, admin)
--   my_payroll_tenant_ids  = hr.can_run_payroll    (owner, admin, or accountant when accountants run payroll)
--   my_expense_tenant_ids  = hr.handles_expenses   (owner, admin, accountant)
--   my_visible_employees   = hr.can_see_employee minus its manager part: the caller's own employee
--                            rows and their direct reports
CREATE OR REPLACE FUNCTION hr.my_tenant_ids()
 RETURNS SETOF uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' ROWS 5
AS $$
  SELECT tenant_id FROM public.tenant_members WHERE user_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION hr.my_manager_tenant_ids()
 RETURNS SETOF uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' ROWS 5
AS $$
  SELECT tenant_id FROM public.tenant_members WHERE user_id = auth.uid() AND role IN ('owner', 'admin');
$$;

CREATE OR REPLACE FUNCTION hr.my_payroll_tenant_ids()
 RETURNS SETOF uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' ROWS 5
AS $$
  SELECT m.tenant_id FROM public.tenant_members m
  WHERE m.user_id = auth.uid() AND (m.role IN ('owner', 'admin') OR (m.role = 'accountant' AND EXISTS (
    SELECT 1 FROM hr.settings s WHERE s.tenant_id = m.tenant_id AND s.accountants_run_payroll)));
$$;

CREATE OR REPLACE FUNCTION hr.my_expense_tenant_ids()
 RETURNS SETOF uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' ROWS 5
AS $$
  SELECT tenant_id FROM public.tenant_members WHERE user_id = auth.uid() AND role IN ('owner', 'admin', 'accountant');
$$;

CREATE OR REPLACE FUNCTION hr.my_visible_employees()
 RETURNS TABLE (tenant_id uuid, id uuid)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' ROWS 10
AS $$
  SELECT e.tenant_id, e.id FROM hr.employees e WHERE e.user_id = auth.uid()
  UNION
  SELECT e.tenant_id, e.id FROM hr.employees e JOIN hr.employees m ON m.id = e.manager_id WHERE m.user_id = auth.uid();
$$;

REVOKE EXECUTE ON FUNCTION hr.my_tenant_ids(), hr.my_manager_tenant_ids(), hr.my_payroll_tenant_ids(),
  hr.my_expense_tenant_ids(), hr.my_visible_employees() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION hr.my_tenant_ids(), hr.my_manager_tenant_ids(), hr.my_payroll_tenant_ids(),
  hr.my_expense_tenant_ids(), hr.my_visible_employees() TO authenticated;

ALTER POLICY tenant_rows ON hr.attendance USING (tenant_id IN (SELECT hr.my_payroll_tenant_ids())
  OR (tenant_id, employee_id) IN (SELECT v.tenant_id, v.id FROM hr.my_visible_employees() v));
ALTER POLICY tenant_rows ON hr.checklist_templates USING (tenant_id IN (SELECT hr.my_manager_tenant_ids()));
ALTER POLICY tenant_rows ON hr.compensation USING (tenant_id IN (SELECT hr.my_payroll_tenant_ids()));
ALTER POLICY manager_writes ON hr.departments USING (tenant_id IN (SELECT hr.my_manager_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT hr.my_manager_tenant_ids()));
ALTER POLICY tenant_rows ON hr.departments USING (tenant_id IN (SELECT hr.my_tenant_ids()));
ALTER POLICY tenant_rows ON hr.documents USING (tenant_id IN (SELECT hr.my_manager_tenant_ids()) OR (EXISTS (SELECT 1
  FROM hr.employees e WHERE e.id = documents.employee_id AND e.tenant_id = documents.tenant_id AND e.user_id = (SELECT auth.uid()))));
ALTER POLICY tenant_rows ON hr.employee_tasks USING (tenant_id IN (SELECT hr.my_manager_tenant_ids())
  OR (tenant_id, employee_id) IN (SELECT v.tenant_id, v.id FROM hr.my_visible_employees() v));
ALTER POLICY tenant_rows ON hr.employees USING (tenant_id IN (SELECT hr.my_tenant_ids()));
ALTER POLICY tenant_rows ON hr.employment_terms USING (tenant_id IN (SELECT hr.my_manager_tenant_ids())
  OR (tenant_id, employee_id) IN (SELECT v.tenant_id, v.id FROM hr.my_visible_employees() v));
ALTER POLICY tenant_rows ON hr.expense_categories USING (tenant_id IN (SELECT hr.my_tenant_ids()));
ALTER POLICY tenant_rows ON hr.expense_claims USING (tenant_id IN (SELECT hr.my_expense_tenant_ids())
  OR (tenant_id, employee_id) IN (SELECT v.tenant_id, v.id FROM hr.my_visible_employees() v));
ALTER POLICY manager_writes ON hr.holidays USING (tenant_id IN (SELECT hr.my_manager_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT hr.my_manager_tenant_ids()));
ALTER POLICY tenant_rows ON hr.holidays USING (tenant_id IN (SELECT hr.my_tenant_ids()));
ALTER POLICY tenant_rows ON hr.leave_requests USING (tenant_id IN (SELECT hr.my_manager_tenant_ids())
  OR (tenant_id, employee_id) IN (SELECT v.tenant_id, v.id FROM hr.my_visible_employees() v));
ALTER POLICY manager_writes ON hr.leave_types USING (tenant_id IN (SELECT hr.my_manager_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT hr.my_manager_tenant_ids()));
ALTER POLICY tenant_rows ON hr.leave_types USING (tenant_id IN (SELECT hr.my_tenant_ids()));
ALTER POLICY tenant_rows ON hr.pay_lines USING (tenant_id IN (SELECT hr.my_payroll_tenant_ids()));
ALTER POLICY tenant_rows ON hr.pay_runs USING (tenant_id IN (SELECT hr.my_payroll_tenant_ids()));
ALTER POLICY tenant_rows ON hr.settings USING (tenant_id IN (SELECT hr.my_manager_tenant_ids()));

-- Scheduler, chat and social: any member reads their company's rows
DO $$
DECLARE
  p RECORD;
BEGIN
  FOR p IN
    SELECT schemaname, tablename FROM pg_policies
    WHERE schemaname IN ('scheduler', 'chat', 'social') AND policyname = 'tenant_rows'
      AND qual IN ('scheduler.is_member(tenant_id)', 'chat.is_member(tenant_id)', 'social.is_member(tenant_id)')
  LOOP
    EXECUTE format('ALTER POLICY tenant_rows ON %I.%I USING (tenant_id IN (SELECT tm.tenant_id FROM public.tenant_members tm WHERE tm.user_id = (SELECT auth.uid())))',
      p.schemaname, p.tablename);
  END LOOP;
END $$;

-- 12. Checking a time zone no longer reads the whole time zone list
CREATE OR REPLACE FUNCTION hr.valid_tz(p_tz text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF p_tz IS NULL OR btrim(p_tz) = '' OR length(p_tz) > 64 THEN
    RETURN 'UTC';
  END IF;
  PERFORM now() AT TIME ZONE p_tz;
  RETURN p_tz;
EXCEPTION WHEN others THEN
  RETURN 'UTC';
END;
$function$;

-- 13. The bot scores only the 50 answers that match best
CREATE OR REPLACE FUNCTION chat.find_answer(p_tenant uuid, p_text text)
 RETURNS TABLE(answer_id uuid, score numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  typed TEXT := left(coalesce(p_text, ''), 2000);
  v TEXT[] := chat.words(typed);
  every_word TEXT[] := tsvector_to_array(to_tsvector('simple'::regconfig, typed));
  v_total NUMERIC;
  loose_q tsquery;
  exact_q tsquery := websearch_to_tsquery('simple'::regconfig, typed);
BEGIN
  IF cardinality(every_word) = 0 THEN
    RETURN;
  END IF;
  SELECT coalesce(sum(char_length(w)), 0) INTO v_total FROM unnest(v) AS w;
  -- Built from tsquery values Postgres produced itself, so typed punctuation can't break it
  SELECT string_agg('(' || q::text || ':*)', ' | ')::tsquery INTO loose_q
    FROM (SELECT DISTINCT phraseto_tsquery('simple'::regconfig, left(w, 4)) AS q FROM unnest(every_word) AS w) s
    WHERE numnode(q) > 0;
  IF loose_q IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH cand AS (
    SELECT a.id, a.times_used, a.terms, a.keywords, a.search @@ exact_q AS full_match
    FROM chat.answers a
    WHERE a.tenant_id = p_tenant AND a.is_active AND a.search @@ loose_q
    ORDER BY ts_rank(a.search, loose_q) DESC, a.times_used DESC, a.id
    LIMIT 50
  ),
  scored AS (
    SELECT c.id, c.times_used, c.full_match,
      (SELECT coalesce(sum(char_length(x)), 0) FROM unnest(v) AS x WHERE EXISTS (SELECT 1 FROM unnest(c.terms) AS t
        WHERE x = t OR (char_length(x) >= 4 AND char_length(t) >= 4 AND abs(char_length(x) - char_length(t)) <= 3
          AND x !~ '[0-9]' AND t !~ '[0-9]' AND (starts_with(x, t) OR starts_with(t, x)))))::numeric AS hit_v,
      (SELECT coalesce(sum(char_length(t)), 0) FROM unnest(c.terms) AS t WHERE EXISTS (SELECT 1 FROM unnest(v) AS x
        WHERE x = t OR (char_length(x) >= 4 AND char_length(t) >= 4 AND abs(char_length(x) - char_length(t)) <= 3
          AND x !~ '[0-9]' AND t !~ '[0-9]' AND (starts_with(x, t) OR starts_with(t, x)))))::numeric AS hit_q,
      (SELECT coalesce(sum(char_length(t)), 0) FROM unnest(c.terms) AS t)::numeric AS len_q,
      (SELECT count(*) FROM (SELECT tsvector_to_array(to_tsvector('simple'::regconfig, k)) AS kws
          FROM unnest(string_to_array(c.keywords, ',')) AS k) kw
        WHERE cardinality(kw.kws) > 0 AND NOT EXISTS (SELECT 1 FROM unnest(kw.kws) AS t WHERE NOT EXISTS (
          SELECT 1 FROM unnest(every_word) AS x
          WHERE x = t OR (char_length(x) >= 4 AND char_length(t) >= 4 AND abs(char_length(x) - char_length(t)) <= 3
            AND x !~ '[0-9]' AND t !~ '[0-9]' AND (starts_with(x, t) OR starts_with(t, x)))))) AS keyword_hits
    FROM cand c
  )
  SELECT s.id,
    round(least(s.keyword_hits, 3)
      + CASE WHEN v_total > 0 THEN 0.6 * s.hit_v / v_total ELSE 0 END
      + CASE WHEN s.len_q > 0 AND v_total > 0 THEN 0.4 * s.hit_q / s.len_q ELSE 0 END
      + CASE WHEN s.full_match AND v_total > 0 THEN 0.25 ELSE 0 END, 3)
  FROM scored s
  ORDER BY 2 DESC, s.times_used DESC
  LIMIT 1;
END;
$function$;

-- 14. Indexes: drop a duplicate, cover foreign keys and cleanup scans
DROP INDEX IF EXISTS crm.idx_deals_contact;
CREATE INDEX IF NOT EXISTS idx_crm_activities_owner ON crm.activities (owner_id);
CREATE INDEX IF NOT EXISTS idx_crm_activities_created_by ON crm.activities (created_by);
CREATE INDEX IF NOT EXISTS idx_crm_deals_owner ON crm.deals (owner_id);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_owner ON crm.contacts (owner_id);
CREATE INDEX IF NOT EXISTS idx_crm_deal_history_changed_by ON crm.deal_history (changed_by);
CREATE INDEX IF NOT EXISTS idx_integrations_api_requests_tenant ON integrations.api_requests (tenant_id);
CREATE INDEX IF NOT EXISTS idx_inventory_count_lines_item ON inventory.count_lines (item_id);
CREATE INDEX IF NOT EXISTS idx_crm_notifications_created ON crm.notifications (created_at);
CREATE INDEX IF NOT EXISTS idx_integrations_deliveries_created ON integrations.deliveries (created_at);
CREATE INDEX IF NOT EXISTS idx_integrations_inbound_log_at ON integrations.inbound_log (at);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_closed ON chat.conversations (closed_at) WHERE status = 'closed';

-- 15. Closed chats (and their messages) are kept for a year
CREATE OR REPLACE FUNCTION chat.cleanup()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  DELETE FROM chat.conversations WHERE status = 'closed' AND closed_at < now() - interval '365 days';
END;
$function$;
REVOKE EXECUTE ON FUNCTION chat.cleanup() FROM PUBLIC, anon, authenticated;

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'chat-cleanup';
SELECT cron.schedule('chat-cleanup', '41 3 * * *', 'SELECT chat.cleanup()');
