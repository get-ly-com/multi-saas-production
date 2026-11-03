-- HR: people, departments, leave and monthly payroll. Pay is private to owners and admins, so it
-- lives in its own tables that only they can read. Everyone in the company sees the staff
-- directory and who is out; each person sees their own leave and payslips. Approved payroll
-- posts into the accounting ledger, and paying it posts the bank side.

CREATE SCHEMA IF NOT EXISTS hr;
GRANT USAGE ON SCHEMA hr TO authenticated, service_role;

-- Ledger accounts for payroll
CREATE OR REPLACE FUNCTION accounting.seed_chart(p_tenant UUID)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO accounting.accounts (tenant_id, code, name, type, is_system, is_cash)
  VALUES
    (p_tenant, '1000', 'Cash', 'asset', true, true),
    (p_tenant, '1200', 'Accounts Receivable', 'asset', true, false),
    (p_tenant, '1300', 'Due from Group Companies', 'asset', true, false),
    (p_tenant, '1400', 'Inventory', 'asset', true, false),
    (p_tenant, '1500', 'Fixed Assets', 'asset', true, false),
    (p_tenant, '1590', 'Accumulated Depreciation', 'asset', true, false),
    (p_tenant, '2000', 'Accounts Payable', 'liability', true, false),
    (p_tenant, '2100', 'Tax Payable', 'liability', true, false),
    (p_tenant, '2200', 'Deferred Revenue', 'liability', true, false),
    (p_tenant, '2300', 'Due to Group Companies', 'liability', true, false),
    (p_tenant, '2400', 'Payroll Liabilities', 'liability', true, false),
    (p_tenant, '2500', 'Wages Payable', 'liability', true, false),
    (p_tenant, '3000', 'Owner''s Equity', 'equity', true, false),
    (p_tenant, '3100', 'Retained Earnings', 'equity', true, false),
    (p_tenant, '4000', 'Sales Revenue', 'revenue', true, false),
    (p_tenant, '5000', 'Cost of Goods Sold', 'expense', true, false),
    (p_tenant, '5100', 'Stock Adjustments', 'expense', true, false),
    (p_tenant, '6000', 'General Expenses', 'expense', true, false),
    (p_tenant, '6100', 'Depreciation Expense', 'expense', true, false),
    (p_tenant, '6200', 'Salaries and Wages', 'expense', true, false),
    (p_tenant, '6210', 'Employer Payroll Costs', 'expense', true, false),
    (p_tenant, '7000', 'Gain or Loss on Disposal', 'expense', true, false),
    (p_tenant, '7100', 'Exchange Gain or Loss', 'expense', true, false)
  ON CONFLICT (tenant_id, code) DO NOTHING;
$$;
SELECT accounting.seed_chart(id) FROM public.tenants;

ALTER TABLE accounting.journal_entries DROP CONSTRAINT journal_entries_source_type_check;
ALTER TABLE accounting.journal_entries ADD CONSTRAINT journal_entries_source_type_check CHECK (source_type IN (
  'manual', 'invoice', 'invoice_payment', 'expense', 'bill', 'payment', 'credit_note', 'bank', 'closing', 'asset',
  'depreciation', 'vendor_credit', 'revenue', 'intercompany', 'invoice_cost', 'stock_adjustment',
  'payroll', 'payroll_payment'));

-- Role checks
CREATE FUNCTION hr.is_manager(p_tenant UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.tenant_members
    WHERE tenant_id = p_tenant AND user_id = auth.uid() AND role IN ('owner', 'admin'));
$$;

CREATE FUNCTION hr.is_member(p_tenant UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = auth.uid());
$$;

-- Company settings
CREATE TABLE hr.settings (
  tenant_id UUID PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  income_tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (income_tax_rate BETWEEN 0 AND 100),
  employee_rate NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (employee_rate BETWEEN 0 AND 100),
  employer_rate NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (employer_rate BETWEEN 0 AND 100),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
ALTER TABLE hr.settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON hr.settings FOR SELECT TO authenticated USING (hr.is_manager(tenant_id));
GRANT SELECT ON hr.settings TO authenticated;

CREATE TABLE hr.departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_hr_departments_name ON hr.departments (tenant_id, lower(name));
ALTER TABLE hr.departments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON hr.departments FOR SELECT TO authenticated USING (hr.is_member(tenant_id));
CREATE POLICY manager_writes ON hr.departments FOR ALL TO authenticated
  USING (hr.is_manager(tenant_id)) WITH CHECK (hr.is_manager(tenant_id));
GRANT SELECT, DELETE ON hr.departments TO authenticated;
GRANT INSERT (tenant_id, name) ON hr.departments TO authenticated;
GRANT UPDATE (name) ON hr.departments TO authenticated;

-- The directory. Everyone in the company can read it; owners and admins change it.
CREATE TABLE hr.employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  employee_number INT NOT NULL,
  first_name TEXT NOT NULL CHECK (length(first_name) BETWEEN 1 AND 100),
  last_name TEXT NOT NULL DEFAULT '' CHECK (length(last_name) <= 100),
  email TEXT CHECK (length(email) <= 200),
  phone TEXT CHECK (length(phone) <= 50),
  job_title TEXT CHECK (length(job_title) <= 100),
  department_id UUID REFERENCES hr.departments(id) ON DELETE SET NULL,
  manager_id UUID REFERENCES hr.employees(id) ON DELETE SET NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  employment_type TEXT NOT NULL DEFAULT 'full_time' CHECK (employment_type IN ('full_time', 'part_time', 'contractor')),
  start_date DATE NOT NULL,
  end_date DATE,
  cost_center_id UUID REFERENCES accounting.cost_centers(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, employee_number),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (manager_id IS NULL OR manager_id <> id)
);
CREATE UNIQUE INDEX uq_hr_employees_user ON hr.employees (tenant_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_hr_employees_user ON hr.employees (user_id);
CREATE INDEX idx_hr_employees_department ON hr.employees (department_id);
CREATE INDEX idx_hr_employees_manager ON hr.employees (manager_id);
CREATE INDEX idx_hr_employees_cost_center ON hr.employees (cost_center_id);
ALTER TABLE hr.employees ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON hr.employees FOR SELECT TO authenticated USING (hr.is_member(tenant_id));
GRANT SELECT ON hr.employees TO authenticated;

-- Pay and private notes. Owners and admins only. Salary is a yearly amount; hourly is a rate per hour.
CREATE TABLE hr.compensation (
  employee_id UUID PRIMARY KEY REFERENCES hr.employees(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  pay_type TEXT NOT NULL DEFAULT 'salary' CHECK (pay_type IN ('salary', 'hourly')),
  amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (amount >= 0 AND amount < 1e10),
  hours_per_week NUMERIC(5,2) NOT NULL DEFAULT 40 CHECK (hours_per_week > 0 AND hours_per_week <= 100),
  notes TEXT CHECK (length(notes) <= 5000),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_hr_compensation_tenant ON hr.compensation (tenant_id);
ALTER TABLE hr.compensation ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON hr.compensation FOR SELECT TO authenticated USING (hr.is_manager(tenant_id));
GRANT SELECT ON hr.compensation TO authenticated;

-- Leave
CREATE TABLE hr.leave_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  days_per_year NUMERIC(5,1) NOT NULL DEFAULT 0 CHECK (days_per_year BETWEEN 0 AND 366),
  paid BOOLEAN NOT NULL DEFAULT true,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_hr_leave_types_name ON hr.leave_types (tenant_id, lower(name));
ALTER TABLE hr.leave_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON hr.leave_types FOR SELECT TO authenticated USING (hr.is_member(tenant_id));
CREATE POLICY manager_writes ON hr.leave_types FOR ALL TO authenticated
  USING (hr.is_manager(tenant_id)) WITH CHECK (hr.is_manager(tenant_id));
GRANT SELECT, DELETE ON hr.leave_types TO authenticated;
GRANT INSERT (tenant_id, name, days_per_year, paid) ON hr.leave_types TO authenticated;
GRANT UPDATE (name, days_per_year, paid, is_active) ON hr.leave_types TO authenticated;

CREATE TABLE hr.holidays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  holiday_date DATE NOT NULL,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  UNIQUE (tenant_id, holiday_date)
);
ALTER TABLE hr.holidays ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON hr.holidays FOR SELECT TO authenticated USING (hr.is_member(tenant_id));
CREATE POLICY manager_writes ON hr.holidays FOR ALL TO authenticated
  USING (hr.is_manager(tenant_id)) WITH CHECK (hr.is_manager(tenant_id));
GRANT SELECT, DELETE ON hr.holidays TO authenticated;
GRANT INSERT (tenant_id, holiday_date, name) ON hr.holidays TO authenticated;
GRANT UPDATE (holiday_date, name) ON hr.holidays TO authenticated;

CREATE TABLE hr.leave_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES hr.employees(id) ON DELETE CASCADE,
  leave_type_id UUID NOT NULL REFERENCES hr.leave_types(id),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  half_day BOOLEAN NOT NULL DEFAULT false,
  days NUMERIC(5,1) NOT NULL CHECK (days > 0),
  reason TEXT CHECK (length(reason) <= 1000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at TIMESTAMP,
  decision_note TEXT CHECK (length(decision_note) <= 500),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  CHECK (NOT half_day OR start_date = end_date)
);
CREATE INDEX idx_hr_leave_requests_employee ON hr.leave_requests (employee_id, start_date);
CREATE INDEX idx_hr_leave_requests_tenant ON hr.leave_requests (tenant_id, status, start_date);
CREATE INDEX idx_hr_leave_requests_type ON hr.leave_requests (leave_type_id);
CREATE INDEX idx_hr_leave_requests_decided_by ON hr.leave_requests (decided_by);
CREATE INDEX idx_hr_leave_requests_created_by ON hr.leave_requests (created_by);

-- The employee themself, their manager, and owners and admins see a request and its reason
CREATE FUNCTION hr.can_see_employee(p_tenant UUID, p_employee UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT hr.is_manager(p_tenant) OR EXISTS (
    SELECT 1 FROM hr.employees e
    LEFT JOIN hr.employees m ON m.id = e.manager_id
    WHERE e.id = p_employee AND e.tenant_id = p_tenant
      AND (e.user_id = auth.uid() OR m.user_id = auth.uid()));
$$;

ALTER TABLE hr.leave_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON hr.leave_requests FOR SELECT TO authenticated
  USING (hr.can_see_employee(tenant_id, employee_id));
GRANT SELECT ON hr.leave_requests TO authenticated;

-- Payroll. Owners and admins only.
CREATE TABLE hr.pay_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  run_number INT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  pay_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'paid', 'void')),
  gross NUMERIC(14,2) NOT NULL DEFAULT 0,
  deductions NUMERIC(14,2) NOT NULL DEFAULT 0,
  employer_costs NUMERIC(14,2) NOT NULL DEFAULT 0,
  net NUMERIC(14,2) NOT NULL DEFAULT 0,
  paid_from UUID REFERENCES accounting.accounts(id),
  paid_on DATE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at TIMESTAMP,
  UNIQUE (tenant_id, run_number),
  CHECK (period_end >= period_start)
);
CREATE INDEX idx_hr_pay_runs_period ON hr.pay_runs (tenant_id, period_start);
CREATE INDEX idx_hr_pay_runs_paid_from ON hr.pay_runs (paid_from);
CREATE INDEX idx_hr_pay_runs_created_by ON hr.pay_runs (created_by);
CREATE INDEX idx_hr_pay_runs_approved_by ON hr.pay_runs (approved_by);
ALTER TABLE hr.pay_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON hr.pay_runs FOR SELECT TO authenticated USING (hr.is_manager(tenant_id));
GRANT SELECT ON hr.pay_runs TO authenticated;

CREATE TABLE hr.pay_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES hr.pay_runs(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES hr.employees(id),
  pay_type TEXT NOT NULL CHECK (pay_type IN ('salary', 'hourly')),
  rate NUMERIC(14,2) NOT NULL,
  hours NUMERIC(7,2),
  base_pay NUMERIC(14,2) NOT NULL DEFAULT 0,
  unpaid_days NUMERIC(5,1) NOT NULL DEFAULT 0,
  unpaid_deduction NUMERIC(14,2) NOT NULL DEFAULT 0,
  additions NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (additions >= 0),
  gross NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (gross >= 0),
  income_tax NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (income_tax >= 0),
  employee_contributions NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (employee_contributions >= 0),
  other_deductions NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (other_deductions >= 0),
  net NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (net >= 0),
  employer_contributions NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (employer_contributions >= 0),
  cost_center_id UUID REFERENCES accounting.cost_centers(id) ON DELETE SET NULL,
  note TEXT CHECK (length(note) <= 200),
  UNIQUE (run_id, employee_id)
);
CREATE INDEX idx_hr_pay_lines_employee ON hr.pay_lines (employee_id);
CREATE INDEX idx_hr_pay_lines_tenant ON hr.pay_lines (tenant_id);
CREATE INDEX idx_hr_pay_lines_cost_center ON hr.pay_lines (cost_center_id);
ALTER TABLE hr.pay_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON hr.pay_lines FOR SELECT TO authenticated USING (hr.is_manager(tenant_id));
GRANT SELECT ON hr.pay_lines TO authenticated;

-- New companies get the usual leave types
CREATE FUNCTION hr.seed_defaults(p_tenant UUID)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO hr.settings (tenant_id) VALUES (p_tenant) ON CONFLICT DO NOTHING;
  INSERT INTO hr.leave_types (tenant_id, name, days_per_year, paid)
  SELECT p_tenant, t.name, t.days, t.paid
  FROM (VALUES ('Annual leave', 20::numeric, true), ('Sick leave', 10::numeric, true), ('Unpaid leave', 0::numeric, false))
    AS t(name, days, paid)
  WHERE NOT EXISTS (SELECT 1 FROM hr.leave_types WHERE tenant_id = p_tenant);
$$;

CREATE FUNCTION hr.seed_for_new_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM hr.seed_defaults(NEW.id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER seed_hr AFTER INSERT ON public.tenants FOR EACH ROW EXECUTE FUNCTION hr.seed_for_new_tenant();
SELECT hr.seed_defaults(id) FROM public.tenants;

-- Monday to Friday, less the company's holidays
CREATE FUNCTION hr.working_days(p_tenant UUID, p_from DATE, p_to DATE)
RETURNS INT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT count(*)::int FROM generate_series(p_from, p_to, interval '1 day') d
  WHERE extract(isodow FROM d) < 6
    AND NOT EXISTS (SELECT 1 FROM hr.holidays h WHERE h.tenant_id = p_tenant AND h.holiday_date = d::date);
$$;

CREATE FUNCTION hr.leave_days(p_tenant UUID, p_from DATE, p_to DATE, p_half_day BOOLEAN)
RETURNS NUMERIC
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE WHEN p_half_day THEN least(0.5, hr.working_days(p_tenant, p_from, p_to)) ELSE hr.working_days(p_tenant, p_from, p_to) END;
$$;

-- Employees and pay
CREATE FUNCTION hr.save_employee(p_tenant UUID, p_employee UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  row_id UUID := p_employee;
  existing hr.employees;
  v_department UUID := nullif(p_data->>'department_id', '')::uuid;
  v_manager UUID := nullif(p_data->>'manager_id', '')::uuid;
  v_user UUID := nullif(p_data->>'user_id', '')::uuid;
  v_cost_center UUID := nullif(p_data->>'cost_center_id', '')::uuid;
  v_start DATE := nullif(p_data->>'start_date', '')::date;
  v_end DATE := nullif(p_data->>'end_date', '')::date;
  v_pay_type TEXT := coalesce(nullif(p_data->>'pay_type', ''), 'salary');
  v_amount NUMERIC := coalesce(nullif(p_data->>'pay_amount', '')::numeric, 0);
  v_hours NUMERIC := coalesce(nullif(p_data->>'hours_per_week', '')::numeric, 40);
  next_number INT;
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  IF length(btrim(coalesce(p_data->>'first_name', ''))) = 0 THEN
    RAISE EXCEPTION 'Enter a first name';
  END IF;
  IF v_start IS NULL THEN
    RAISE EXCEPTION 'Enter a start date';
  END IF;
  IF v_end < v_start THEN
    RAISE EXCEPTION 'The end date can''t be before the start date';
  END IF;
  IF v_pay_type NOT IN ('salary', 'hourly') THEN
    RAISE EXCEPTION 'Choose salary or hourly pay';
  END IF;
  IF v_amount < 0 OR v_amount >= 1e10 THEN
    RAISE EXCEPTION 'Enter a valid pay amount';
  END IF;
  IF v_hours <= 0 OR v_hours > 100 THEN
    RAISE EXCEPTION 'Hours per week must be between 1 and 100';
  END IF;
  IF v_department IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hr.departments WHERE id = v_department AND tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'Department not found';
  END IF;
  IF v_cost_center IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounting.cost_centers WHERE id = v_cost_center AND tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'Cost center not found';
  END IF;
  IF v_user IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = v_user) THEN
    RAISE EXCEPTION 'That person isn''t in your team';
  END IF;
  IF v_manager IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM hr.employees WHERE id = v_manager AND tenant_id = p_tenant) THEN
      RAISE EXCEPTION 'Manager not found';
    END IF;
    -- No one may end up managing themself through a chain
    IF row_id IS NOT NULL AND EXISTS (
      WITH RECURSIVE chain(id) AS (
        SELECT v_manager
        UNION SELECT e.manager_id FROM hr.employees e JOIN chain c ON e.id = c.id WHERE e.manager_id IS NOT NULL)
      SELECT 1 FROM chain WHERE id = row_id) THEN
      RAISE EXCEPTION 'That manager reports to this person';
    END IF;
  END IF;

  IF row_id IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 23));
    SELECT coalesce(max(employee_number), 0) + 1 INTO next_number FROM hr.employees WHERE tenant_id = p_tenant;
    INSERT INTO hr.employees (tenant_id, employee_number, first_name, last_name, email, phone, job_title,
        department_id, manager_id, user_id, employment_type, start_date, end_date, cost_center_id)
      VALUES (p_tenant, next_number, btrim(p_data->>'first_name'), btrim(coalesce(p_data->>'last_name', '')),
        nullif(btrim(p_data->>'email'), ''), nullif(btrim(p_data->>'phone'), ''), nullif(btrim(p_data->>'job_title'), ''),
        v_department, v_manager, v_user, coalesce(nullif(p_data->>'employment_type', ''), 'full_time'),
        v_start, v_end, v_cost_center)
      RETURNING id INTO row_id;
  ELSE
    SELECT * INTO existing FROM hr.employees WHERE id = row_id AND tenant_id = p_tenant FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Employee not found';
    END IF;
    UPDATE hr.employees SET
      first_name = btrim(p_data->>'first_name'),
      last_name = btrim(coalesce(p_data->>'last_name', '')),
      email = nullif(btrim(p_data->>'email'), ''),
      phone = nullif(btrim(p_data->>'phone'), ''),
      job_title = nullif(btrim(p_data->>'job_title'), ''),
      department_id = v_department,
      manager_id = v_manager,
      user_id = v_user,
      employment_type = coalesce(nullif(p_data->>'employment_type', ''), 'full_time'),
      start_date = v_start,
      end_date = v_end,
      cost_center_id = v_cost_center,
      updated_at = now()
    WHERE id = row_id;
  END IF;

  INSERT INTO hr.compensation (employee_id, tenant_id, pay_type, amount, hours_per_week, notes)
    VALUES (row_id, p_tenant, v_pay_type, round(v_amount, 2), v_hours, nullif(p_data->>'notes', ''))
    ON CONFLICT (employee_id) DO UPDATE SET pay_type = EXCLUDED.pay_type, amount = EXCLUDED.amount,
      hours_per_week = EXCLUDED.hours_per_week, notes = EXCLUDED.notes, updated_at = now();

  RETURN (SELECT row_to_json(e) FROM hr.employees e WHERE id = row_id);
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'That team member is already linked to another employee';
END;
$$;

CREATE FUNCTION hr.delete_employee(p_tenant UUID, p_employee UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  IF EXISTS (SELECT 1 FROM hr.pay_lines WHERE employee_id = p_employee) THEN
    RAISE EXCEPTION 'This person has been on a pay run, so they can''t be deleted. Add an end date instead.';
  END IF;
  DELETE FROM hr.employees WHERE id = p_employee AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;
  RETURN json_build_object('success', true);
END;
$$;

CREATE FUNCTION hr.save_settings(p_tenant UUID, p_income_tax NUMERIC, p_employee NUMERIC, p_employer NUMERIC)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  IF p_income_tax NOT BETWEEN 0 AND 100 OR p_employee NOT BETWEEN 0 AND 100 OR p_employer NOT BETWEEN 0 AND 100 THEN
    RAISE EXCEPTION 'Rates must be between 0 and 100';
  END IF;
  INSERT INTO hr.settings (tenant_id, income_tax_rate, employee_rate, employer_rate)
    VALUES (p_tenant, p_income_tax, p_employee, p_employer)
    ON CONFLICT (tenant_id) DO UPDATE SET income_tax_rate = EXCLUDED.income_tax_rate,
      employee_rate = EXCLUDED.employee_rate, employer_rate = EXCLUDED.employer_rate, updated_at = now();
  RETURN (SELECT row_to_json(s) FROM hr.settings s WHERE tenant_id = p_tenant);
END;
$$;

-- Leave
CREATE FUNCTION hr.leave_balances(p_tenant UUID, p_employee UUID, p_year INT)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  person hr.employees;
  year_start DATE := make_date(p_year, 1, 1);
  year_end DATE := make_date(p_year, 12, 31);
  share NUMERIC;
BEGIN
  IF NOT hr.can_see_employee(p_tenant, p_employee) THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;
  SELECT * INTO person FROM hr.employees WHERE id = p_employee AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;
  -- Someone who starts or leaves during the year gets that share of the allowance
  share := greatest(0, least(year_end, coalesce(person.end_date, year_end)) - greatest(year_start, person.start_date) + 1)::numeric
    / (year_end - year_start + 1);

  RETURN coalesce((
    SELECT json_agg(json_build_object(
      'leave_type_id', t.id, 'name', t.name, 'paid', t.paid, 'limited', t.days_per_year > 0,
      'allowance', round(t.days_per_year * share * 2) / 2,
      'taken', coalesce(used.taken, 0), 'pending', coalesce(used.pending, 0),
      'left', CASE WHEN t.days_per_year > 0 THEN round(t.days_per_year * share * 2) / 2 - coalesce(used.taken, 0) - coalesce(used.pending, 0) END
    ) ORDER BY t.name)
    FROM hr.leave_types t
    LEFT JOIN LATERAL (
      SELECT sum(r.days) FILTER (WHERE r.status = 'approved') AS taken,
             sum(r.days) FILTER (WHERE r.status = 'pending') AS pending
      FROM hr.leave_requests r
      WHERE r.employee_id = p_employee AND r.leave_type_id = t.id AND r.start_date BETWEEN year_start AND year_end
    ) used ON true
    WHERE t.tenant_id = p_tenant AND (t.is_active OR used.taken IS NOT NULL OR used.pending IS NOT NULL)
  ), '[]'::json);
END;
$$;

-- Checks a request fits the allowance. The request being decided is already counted as pending.
CREATE FUNCTION hr.check_allowance(p_tenant UUID, p_employee UUID, p_type UUID, p_year INT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  balance JSON;
BEGIN
  SELECT b INTO balance FROM json_array_elements(hr.leave_balances(p_tenant, p_employee, p_year)) b
    WHERE (b->>'leave_type_id')::uuid = p_type;
  IF (balance->>'limited')::boolean AND (balance->>'left')::numeric < 0 THEN
    RAISE EXCEPTION 'That''s more % than is left for % (% of % days). An owner or admin can raise the allowance.',
      lower(balance->>'name'), p_year, (balance->>'left')::numeric + 0, balance->>'allowance';
  END IF;
END;
$$;

CREATE FUNCTION hr.request_leave(
  p_tenant UUID, p_employee UUID, p_type UUID, p_start DATE, p_end DATE, p_half_day BOOLEAN, p_reason TEXT
)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  person hr.employees;
  kind hr.leave_types;
  v_days NUMERIC;
  new_id UUID;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  SELECT * INTO person FROM hr.employees WHERE id = p_employee AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;
  IF NOT hr.is_manager(p_tenant) AND person.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'You can only ask for your own leave';
  END IF;
  SELECT * INTO kind FROM hr.leave_types WHERE id = p_type AND tenant_id = p_tenant AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Choose a type of leave';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN
    RAISE EXCEPTION 'Choose a start and end date';
  END IF;
  IF extract(year FROM p_start) <> extract(year FROM p_end) THEN
    RAISE EXCEPTION 'Leave that crosses into a new year needs one request for each year';
  END IF;
  IF coalesce(p_half_day, false) AND p_start <> p_end THEN
    RAISE EXCEPTION 'A half day is for a single date';
  END IF;
  IF p_start < person.start_date OR p_end > coalesce(person.end_date, p_end) THEN
    RAISE EXCEPTION 'Those dates are outside this person''s employment';
  END IF;
  IF length(p_reason) > 1000 THEN
    RAISE EXCEPTION 'Keep the reason under 1,000 characters';
  END IF;
  v_days := hr.leave_days(p_tenant, p_start, p_end, coalesce(p_half_day, false));
  IF v_days = 0 THEN
    RAISE EXCEPTION 'Those dates are all weekends or holidays';
  END IF;
  IF EXISTS (SELECT 1 FROM hr.leave_requests WHERE employee_id = p_employee AND status IN ('pending', 'approved')
      AND start_date <= p_end AND end_date >= p_start) THEN
    RAISE EXCEPTION 'This overlaps leave that''s already booked or waiting';
  END IF;

  INSERT INTO hr.leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, half_day, days, reason, created_by)
    VALUES (p_tenant, p_employee, p_type, p_start, p_end, coalesce(p_half_day, false), v_days, nullif(btrim(p_reason), ''), auth.uid())
    RETURNING id INTO new_id;
  PERFORM hr.check_allowance(p_tenant, p_employee, p_type, extract(year FROM p_start)::int);
  RETURN (SELECT row_to_json(r) FROM hr.leave_requests r WHERE id = new_id);
END;
$$;

-- Owners and admins decide any request; a manager decides their own team's. No one decides their own,
-- except the owner, who has no one above them.
CREATE FUNCTION hr.decide_leave(p_tenant UUID, p_request UUID, p_status TEXT, p_note TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  request hr.leave_requests;
  person hr.employees;
  my_role TEXT;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  IF p_status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Approve or reject the request';
  END IF;
  SELECT * INTO request FROM hr.leave_requests WHERE id = p_request AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found';
  END IF;
  SELECT * INTO person FROM hr.employees WHERE id = request.employee_id;
  SELECT role INTO my_role FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = auth.uid();

  IF person.user_id = auth.uid() AND my_role <> 'owner' THEN
    RAISE EXCEPTION 'Someone else needs to decide your own leave';
  END IF;
  IF my_role NOT IN ('owner', 'admin') AND NOT EXISTS (
      SELECT 1 FROM hr.employees m WHERE m.id = person.manager_id AND m.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Only this person''s manager, an owner or an admin can decide this';
  END IF;
  IF request.status <> 'pending' THEN
    RAISE EXCEPTION 'This request has already been %', request.status;
  END IF;
  IF length(p_note) > 500 THEN
    RAISE EXCEPTION 'Keep the note under 500 characters';
  END IF;

  IF p_status = 'approved' THEN
    PERFORM hr.check_allowance(p_tenant, request.employee_id, request.leave_type_id, extract(year FROM request.start_date)::int);
  END IF;
  UPDATE hr.leave_requests SET status = p_status, decided_by = auth.uid(), decided_at = now(),
      decision_note = nullif(btrim(p_note), '')
    WHERE id = p_request;
  RETURN (SELECT row_to_json(r) FROM hr.leave_requests r WHERE id = p_request);
END;
$$;

-- The person can cancel their own leave until it starts; owners and admins can cancel any
CREATE FUNCTION hr.cancel_leave(p_tenant UUID, p_request UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  request hr.leave_requests;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  SELECT r.* INTO request FROM hr.leave_requests r WHERE r.id = p_request AND r.tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND OR NOT hr.can_see_employee(p_tenant, request.employee_id) THEN
    RAISE EXCEPTION 'Request not found';
  END IF;
  IF request.status NOT IN ('pending', 'approved') THEN
    RAISE EXCEPTION 'This request has already been %', request.status;
  END IF;
  IF NOT hr.is_manager(p_tenant) THEN
    IF NOT EXISTS (SELECT 1 FROM hr.employees WHERE id = request.employee_id AND user_id = auth.uid()) THEN
      RAISE EXCEPTION 'Only the person, an owner or an admin can cancel this';
    END IF;
    IF request.status = 'approved' AND request.start_date <= current_date THEN
      RAISE EXCEPTION 'This leave has started. Ask an owner or admin to change it.';
    END IF;
  END IF;
  UPDATE hr.leave_requests SET status = 'cancelled', decided_by = auth.uid(), decided_at = now() WHERE id = p_request;
  RETURN (SELECT row_to_json(r) FROM hr.leave_requests r WHERE id = p_request);
END;
$$;

-- Who is away. Everyone in the company sees names and dates; the type shows only to those who
-- can see the request, so sick leave stays private.
CREATE FUNCTION hr.who_is_out(p_tenant UUID, p_from DATE, p_to DATE)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT hr.is_member(p_tenant) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF p_to < p_from OR p_to - p_from > 92 THEN
    RAISE EXCEPTION 'Choose up to three months';
  END IF;
  RETURN coalesce((
    SELECT json_agg(json_build_object(
      'id', r.id, 'employee_id', e.id, 'name', btrim(e.first_name || ' ' || e.last_name),
      'leave_type', CASE WHEN hr.can_see_employee(p_tenant, e.id) THEN t.name ELSE 'Away' END, 'start_date', r.start_date, 'end_date', r.end_date, 'half_day', r.half_day, 'days', r.days
    ) ORDER BY r.start_date, e.first_name)
    FROM hr.leave_requests r
    JOIN hr.employees e ON e.id = r.employee_id
    JOIN hr.leave_types t ON t.id = r.leave_type_id
    WHERE r.tenant_id = p_tenant AND r.status = 'approved' AND r.start_date <= p_to AND r.end_date >= p_from
  ), '[]'::json);
END;
$$;

-- Payroll
CREATE FUNCTION hr.refresh_run_totals(p_run UUID)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  UPDATE hr.pay_runs r SET
    gross = t.gross, deductions = t.deductions, employer_costs = t.employer, net = t.net
  FROM (
    SELECT coalesce(sum(gross), 0) AS gross,
      coalesce(sum(income_tax + employee_contributions + other_deductions), 0) AS deductions,
      coalesce(sum(employer_contributions), 0) AS employer, coalesce(sum(net), 0) AS net
    FROM hr.pay_lines WHERE run_id = p_run
  ) t
  WHERE r.id = p_run;
$$;

-- Works out one person's pay for the month from their pay and approved unpaid leave
CREATE FUNCTION hr.calc_line(p_run UUID, p_employee UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
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
      cost_center_id = EXCLUDED.cost_center_id, note = NULL;
END;
$$;

-- Fills a draft with everyone employed during the month, except contractors (pay them with bills)
CREATE FUNCTION hr.fill_run(p_run UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  run hr.pay_runs;
  person RECORD;
BEGIN
  SELECT * INTO run FROM hr.pay_runs WHERE id = p_run;
  DELETE FROM hr.pay_lines WHERE run_id = p_run;
  FOR person IN
    SELECT id FROM hr.employees
    WHERE tenant_id = run.tenant_id AND employment_type <> 'contractor'
      AND start_date <= run.period_end AND (end_date IS NULL OR end_date >= run.period_start)
  LOOP
    PERFORM hr.calc_line(p_run, person.id);
  END LOOP;
  PERFORM hr.refresh_run_totals(p_run);
END;
$$;

CREATE FUNCTION hr.create_pay_run(p_tenant UUID, p_month DATE, p_pay_date DATE)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_start DATE := date_trunc('month', p_month)::date;
  v_end DATE := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  next_number INT;
  new_id UUID;
BEGIN
  PERFORM accounting.require_manager(p_tenant);
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

CREATE FUNCTION hr.draft_run(p_tenant UUID, p_run UUID)
RETURNS hr.pay_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  run hr.pay_runs;
BEGIN
  PERFORM accounting.require_manager(p_tenant);
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

-- Starts the draft again from everyone's current pay and leave. Edits are lost.
CREATE FUNCTION hr.recalculate_pay_run(p_tenant UUID, p_run UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM hr.draft_run(p_tenant, p_run);
  PERFORM hr.fill_run(p_run);
  RETURN (SELECT row_to_json(r) FROM hr.pay_runs r WHERE id = p_run);
END;
$$;

-- Changes one person's line on a draft. Taxes follow the company rates unless they are given.
CREATE FUNCTION hr.update_pay_line(p_tenant UUID, p_line UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
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

  v_tax := round(coalesce(nullif(p_data->>'income_tax', '')::numeric, v_gross * rates.income_tax_rate / 100), 2);
  v_employee := round(coalesce(nullif(p_data->>'employee_contributions', '')::numeric, v_gross * rates.employee_rate / 100), 2);
  v_other := round(coalesce(nullif(p_data->>'other_deductions', '')::numeric, line.other_deductions), 2);
  v_employer := round(coalesce(nullif(p_data->>'employer_contributions', '')::numeric, v_gross * rates.employer_rate / 100), 2);
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
      net = v_gross - v_tax - v_employee - v_other,
      note = CASE WHEN p_data ? 'note' THEN nullif(btrim(p_data->>'note'), '') ELSE note END
    WHERE id = p_line;
  PERFORM hr.refresh_run_totals(line.run_id);
  RETURN (SELECT row_to_json(l) FROM hr.pay_lines l WHERE id = p_line);
END;
$$;

CREATE FUNCTION hr.remove_pay_line(p_tenant UUID, p_line UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  line hr.pay_lines;
BEGIN
  SELECT * INTO line FROM hr.pay_lines WHERE id = p_line AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pay line not found';
  END IF;
  PERFORM hr.draft_run(p_tenant, line.run_id);
  DELETE FROM hr.pay_lines WHERE id = p_line;
  PERFORM hr.refresh_run_totals(line.run_id);
  RETURN json_build_object('success', true);
END;
$$;

CREATE FUNCTION hr.delete_pay_run(p_tenant UUID, p_run UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM hr.draft_run(p_tenant, p_run);
  DELETE FROM hr.pay_runs WHERE id = p_run;
  RETURN json_build_object('success', true);
END;
$$;

-- Approving books the cost: salaries and employer costs against what is owed to staff and to the tax office
CREATE FUNCTION hr.approve_pay_run(p_tenant UUID, p_run UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  run hr.pay_runs;
  lines JSONB;
BEGIN
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

-- Paying staff clears what is owed to them from a bank or cash account
CREATE FUNCTION hr.pay_pay_run(p_tenant UUID, p_run UUID, p_account UUID, p_date DATE)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  run hr.pay_runs;
BEGIN
  PERFORM accounting.require_manager(p_tenant);
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

-- Undoes an approved or paid run in the ledger. Its lines stay for the record.
CREATE FUNCTION hr.void_pay_run(p_tenant UUID, p_run UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  run hr.pay_runs;
BEGIN
  PERFORM accounting.require_manager(p_tenant);
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

-- A payslip, for owners and admins or for the person it belongs to once the run is approved
CREATE FUNCTION hr.payslip(p_tenant UUID, p_line UUID)
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
  IF NOT hr.is_manager(p_tenant) AND (person.user_id IS DISTINCT FROM auth.uid() OR run.status NOT IN ('approved', 'paid')) THEN
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

-- The signed-in person's own record, leave and payslips
CREATE FUNCTION hr.me(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  person hr.employees;
BEGIN
  IF NOT hr.is_member(p_tenant) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  SELECT * INTO person FROM hr.employees WHERE tenant_id = p_tenant AND user_id = auth.uid();
  IF NOT FOUND THEN
    RETURN json_build_object('employee', NULL);
  END IF;
  RETURN json_build_object(
    'employee', row_to_json(person),
    'balances', hr.leave_balances(p_tenant, person.id, extract(year FROM current_date)::int),
    'payslips', coalesce((
      SELECT json_agg(json_build_object('id', l.id, 'period_start', r.period_start, 'pay_date', r.pay_date,
        'gross', l.gross, 'net', l.net, 'status', r.status) ORDER BY r.period_start DESC)
      FROM hr.pay_lines l JOIN hr.pay_runs r ON r.id = l.run_id
      WHERE l.employee_id = person.id AND r.status IN ('approved', 'paid')
    ), '[]'::json)
  );
END;
$$;

CREATE FUNCTION hr.overview(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  manager BOOLEAN := hr.is_manager(p_tenant);
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
    'monthly_pay', CASE WHEN manager THEN (
      SELECT coalesce(sum(CASE WHEN c.pay_type = 'salary' THEN c.amount / 12 ELSE c.amount * c.hours_per_week * 52 / 12 END), 0)
      FROM hr.compensation c JOIN hr.employees e ON e.id = c.employee_id
      WHERE c.tenant_id = p_tenant AND e.employment_type <> 'contractor'
        AND e.start_date <= current_date AND (e.end_date IS NULL OR e.end_date >= current_date)) END,
    'last_run', CASE WHEN manager THEN (
      SELECT row_to_json(r) FROM (SELECT id, run_number, period_start, pay_date, status, gross, net FROM hr.pay_runs
        WHERE tenant_id = p_tenant AND status <> 'void' ORDER BY period_start DESC LIMIT 1) r) END,
    'is_manager', manager
  );
END;
$$;

DO $$
DECLARE
  fn TEXT;
BEGIN
  -- Helpers used inside other functions, never called directly
  FOREACH fn IN ARRAY ARRAY['hr.seed_defaults(uuid)', 'hr.seed_for_new_tenant()', 'hr.refresh_run_totals(uuid)',
      'hr.calc_line(uuid, uuid)', 'hr.fill_run(uuid)', 'hr.draft_run(uuid, uuid)', 'hr.check_allowance(uuid, uuid, uuid, integer)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
  END LOOP;
  FOREACH fn IN ARRAY ARRAY['hr.is_manager(uuid)', 'hr.is_member(uuid)', 'hr.can_see_employee(uuid, uuid)',
      'hr.working_days(uuid, date, date)', 'hr.leave_days(uuid, date, date, boolean)',
      'hr.save_employee(uuid, uuid, jsonb)', 'hr.delete_employee(uuid, uuid)',
      'hr.save_settings(uuid, numeric, numeric, numeric)', 'hr.leave_balances(uuid, uuid, integer)',
      'hr.request_leave(uuid, uuid, uuid, date, date, boolean, text)', 'hr.decide_leave(uuid, uuid, text, text)',
      'hr.cancel_leave(uuid, uuid)', 'hr.who_is_out(uuid, date, date)', 'hr.create_pay_run(uuid, date, date)',
      'hr.recalculate_pay_run(uuid, uuid)', 'hr.update_pay_line(uuid, uuid, jsonb)', 'hr.remove_pay_line(uuid, uuid)',
      'hr.delete_pay_run(uuid, uuid)', 'hr.approve_pay_run(uuid, uuid)', 'hr.pay_pay_run(uuid, uuid, uuid, date)',
      'hr.void_pay_run(uuid, uuid)', 'hr.payslip(uuid, uuid)', 'hr.me(uuid)', 'hr.overview(uuid)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
  END LOOP;
END;
$$;

ALTER ROLE authenticator SET pgrst.db_schemas = 'public, graphql_public, accounting, crm, inventory, hr';
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';
