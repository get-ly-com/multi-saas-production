-- HR: attendance (clock in and out, with a shared kiosk), expense claims with receipts, onboarding and
-- offboarding checklists, probation dates, reminders in the Alerts bell, and public holidays import.
-- Payroll and leave work exactly as before. A draft pay run takes approved attendance hours for hourly
-- staff only when someone asks it to (use_attendance_hours).

-- ===== Journal sources for expense claims. Keeps every source that exists today and adds two.
DO $$
DECLARE
  sources TEXT;
BEGIN
  SELECT string_agg(quote_literal(s), ', ' ORDER BY s) INTO sources FROM (
    SELECT m[1] AS s
    FROM pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') m
    WHERE c.conname = 'journal_entries_source_type_check' AND c.conrelid = 'accounting.journal_entries'::regclass
    UNION SELECT unnest(ARRAY['hr_expense', 'hr_expense_payment'])) t;
  ALTER TABLE accounting.journal_entries DROP CONSTRAINT journal_entries_source_type_check;
  EXECUTE format('ALTER TABLE accounting.journal_entries ADD CONSTRAINT journal_entries_source_type_check CHECK (source_type IN (%s))', sources);
END;
$$;

-- ===== Role checks

-- Who decides for an employee: owners and admins, or the person's manager. No one decides for
-- themself, except the owner, who has no one above them. Same rule as leave.
CREATE FUNCTION hr.decides_for(p_tenant UUID, p_employee UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM hr.employees e
    LEFT JOIN hr.employees m ON m.id = e.manager_id
    JOIN public.tenant_members tm ON tm.tenant_id = p_tenant AND tm.user_id = auth.uid()
    WHERE e.id = p_employee AND e.tenant_id = p_tenant
      AND (e.user_id IS DISTINCT FROM auth.uid() OR tm.role = 'owner')
      AND (tm.role IN ('owner', 'admin') OR m.user_id = auth.uid()));
$$;

-- Owners, admins and accountants see every expense claim and pay approved ones
CREATE FUNCTION hr.handles_expenses(p_tenant UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.tenant_members
    WHERE tenant_id = p_tenant AND user_id = auth.uid() AND role IN ('owner', 'admin', 'accountant'));
$$;

-- The signed-in person's own employee record, if they are linked to one
CREATE FUNCTION hr.my_employee(p_tenant UUID)
RETURNS hr.employees
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT e.* FROM hr.employees e
  JOIN public.tenant_members tm ON tm.tenant_id = e.tenant_id AND tm.user_id = e.user_id
  WHERE e.tenant_id = p_tenant AND e.user_id = auth.uid();
$$;

-- ===== Settings: which sign-in may run the shared clock-in kiosk, besides owners and admins
ALTER TABLE hr.settings ADD COLUMN IF NOT EXISTS kiosk_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_hr_settings_kiosk_user ON hr.settings (kiosk_user_id);

CREATE FUNCTION hr.can_run_kiosk(p_tenant UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT hr.is_manager(p_tenant) OR EXISTS (
    SELECT 1 FROM hr.settings s JOIN public.tenant_members tm ON tm.tenant_id = s.tenant_id AND tm.user_id = s.kiosk_user_id
    WHERE s.tenant_id = p_tenant AND s.kiosk_user_id = auth.uid());
$$;

CREATE FUNCTION hr.set_kiosk_user(p_tenant UUID, p_user UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  IF p_user IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = p_user) THEN
    RAISE EXCEPTION 'That person isn''t in your team';
  END IF;
  INSERT INTO hr.settings (tenant_id, kiosk_user_id) VALUES (p_tenant, p_user)
    ON CONFLICT (tenant_id) DO UPDATE SET kiosk_user_id = EXCLUDED.kiosk_user_id, updated_at = now();
  RETURN json_build_object('kiosk_user_id', p_user);
END;
$$;

-- ===== Probation. Kept apart from the directory, so only the person, their manager, owners and admins see it.
CREATE TABLE hr.employment_terms (
  employee_id UUID PRIMARY KEY REFERENCES hr.employees(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  probation_end_date DATE,
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_hr_employment_terms_tenant ON hr.employment_terms (tenant_id);
ALTER TABLE hr.employment_terms ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON hr.employment_terms FOR SELECT TO authenticated
  USING (hr.can_see_employee(tenant_id, employee_id));
GRANT SELECT ON hr.employment_terms TO authenticated;

CREATE FUNCTION hr.set_probation(p_tenant UUID, p_employee UUID, p_date DATE)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  person hr.employees;
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  SELECT * INTO person FROM hr.employees WHERE id = p_employee AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;
  IF p_date IS NOT NULL AND (p_date < person.start_date OR p_date > person.start_date + 730) THEN
    RAISE EXCEPTION 'The probation end must be after the start date and within two years of it';
  END IF;
  INSERT INTO hr.employment_terms (employee_id, tenant_id, probation_end_date) VALUES (p_employee, p_tenant, p_date)
    ON CONFLICT (employee_id) DO UPDATE SET probation_end_date = EXCLUDED.probation_end_date, updated_at = now();
  RETURN json_build_object('employee_id', p_employee, 'probation_end_date', p_date);
END;
$$;

-- ===== Attendance
CREATE TABLE hr.attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES hr.employees(id) ON DELETE CASCADE,
  work_date DATE NOT NULL,
  check_in TIMESTAMPTZ NOT NULL,
  check_out TIMESTAMPTZ,
  break_minutes INT NOT NULL DEFAULT 0 CHECK (break_minutes BETWEEN 0 AND 600),
  hours NUMERIC(6,2) GENERATED ALWAYS AS (CASE WHEN check_out IS NULL THEN NULL
    ELSE round(((extract(epoch FROM (check_out - check_in)) / 60 - break_minutes) / 60)::numeric, 2) END) STORED,
  source TEXT NOT NULL DEFAULT 'self' CHECK (source IN ('self', 'kiosk', 'manual')),
  note TEXT CHECK (length(note) <= 300),
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at TIMESTAMP,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  CHECK (check_out IS NULL OR (check_out > check_in AND check_out - check_in <= interval '24 hours')),
  CHECK (check_out IS NULL OR break_minutes * interval '1 minute' < check_out - check_in),
  CHECK (approved_at IS NULL OR check_out IS NOT NULL)
);
-- Someone can be clocked in only once at a time
CREATE UNIQUE INDEX uq_hr_attendance_open ON hr.attendance (employee_id) WHERE check_out IS NULL;
CREATE INDEX idx_hr_attendance_employee ON hr.attendance (employee_id, work_date);
CREATE INDEX idx_hr_attendance_tenant ON hr.attendance (tenant_id, work_date);
CREATE INDEX idx_hr_attendance_approved_by ON hr.attendance (approved_by);
CREATE INDEX idx_hr_attendance_created_by ON hr.attendance (created_by);
ALTER TABLE hr.attendance ENABLE ROW LEVEL SECURITY;
-- The person, their manager, owners and admins, and whoever runs payroll
CREATE POLICY tenant_rows ON hr.attendance FOR SELECT TO authenticated
  USING (hr.can_see_employee(tenant_id, employee_id) OR hr.can_run_payroll(tenant_id));
GRANT SELECT ON hr.attendance TO authenticated;

-- Kiosk PINs. Stored hashed; no one can read this table, only the functions below.
CREATE TABLE hr.kiosk_pins (
  employee_id UUID PRIMARY KEY REFERENCES hr.employees(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  pin_hash TEXT NOT NULL,
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_hr_kiosk_pins_tenant ON hr.kiosk_pins (tenant_id);
ALTER TABLE hr.kiosk_pins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON hr.kiosk_pins FROM PUBLIC, anon, authenticated;

CREATE FUNCTION hr.valid_tz(p_tz TEXT)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce((SELECT name FROM pg_catalog.pg_timezone_names WHERE name = p_tz LIMIT 1), 'UTC');
$$;

-- Clocks a person in, or out if they are in. Returns an 'error' instead of raising, so the kiosk can
-- keep its count of wrong PINs.
CREATE FUNCTION hr.clock_toggle(p_person hr.employees, p_tz TEXT, p_source TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_today DATE := (now() AT TIME ZONE hr.valid_tz(p_tz))::date;
  open_entry hr.attendance;
  v_status TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('hr.attendance:' || p_person.id::text, 0));
  SELECT * INTO open_entry FROM hr.attendance WHERE employee_id = p_person.id AND check_out IS NULL;
  IF FOUND THEN
    IF open_entry.check_in < now() - interval '24 hours' THEN
      RETURN json_build_object('error', 'You''ve been clocked in since ' || to_char(open_entry.check_in AT TIME ZONE hr.valid_tz(p_tz), 'FMDD Mon HH24:MI')
        || '. Ask your manager to put in the time you left, then clock in again.');
    END IF;
    UPDATE hr.attendance SET check_out = greatest(now(), check_in + interval '1 minute'), updated_at = now()
      WHERE id = open_entry.id;
    v_status := 'out';
  ELSE
    IF p_person.start_date > v_today OR (p_person.end_date IS NOT NULL AND p_person.end_date < v_today) THEN
      RETURN json_build_object('error', 'You aren''t employed today, so you can''t clock in');
    END IF;
    INSERT INTO hr.attendance (tenant_id, employee_id, work_date, check_in, source, created_by)
      VALUES (p_person.tenant_id, p_person.id, v_today, now(), p_source, auth.uid());
    v_status := 'in';
  END IF;
  RETURN json_build_object('status', v_status, 'name', p_person.first_name, 'at', now(),
    'hours_today', (SELECT coalesce(sum(hours), 0) FROM hr.attendance WHERE employee_id = p_person.id AND work_date = v_today));
END;
$$;

-- Clocking yourself in or out. Anyone linked to an employee may, viewers included: it's their own time.
CREATE FUNCTION hr.clock(p_tenant UUID, p_tz TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  person hr.employees := hr.my_employee(p_tenant);
  result JSON;
BEGIN
  IF person.id IS NULL THEN
    RAISE EXCEPTION 'Your sign-in isn''t linked to an employee. Ask an owner or admin to link it.';
  END IF;
  result := hr.clock_toggle(person, p_tz, 'self');
  IF result->>'error' IS NOT NULL THEN
    RAISE EXCEPTION '%', result->>'error';
  END IF;
  RETURN result;
END;
$$;

-- The shared kiosk: someone types their employee number and PIN. Five wrong PINs lock that person
-- out of the kiosk for 15 minutes.
CREATE FUNCTION hr.kiosk_clock(p_tenant UUID, p_number INT, p_pin TEXT, p_tz TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  person hr.employees;
  pin hr.kiosk_pins;
  no_match CONSTANT TEXT := 'That number and PIN don''t match';
BEGIN
  IF NOT hr.can_run_kiosk(p_tenant) THEN
    RAISE EXCEPTION 'This sign-in can''t run the clock-in kiosk. An owner or admin can choose one in HR settings.';
  END IF;
  SELECT * INTO person FROM hr.employees WHERE tenant_id = p_tenant AND employee_number = p_number;
  IF NOT FOUND THEN
    RETURN json_build_object('error', no_match);
  END IF;
  SELECT * INTO pin FROM hr.kiosk_pins WHERE employee_id = person.id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('error', 'You don''t have a kiosk PIN yet. Set one on the Attendance page, or ask your manager.');
  END IF;
  IF pin.locked_until > now() THEN
    RETURN json_build_object('error', 'Too many wrong PINs. Try again after ' || to_char(pin.locked_until AT TIME ZONE hr.valid_tz(p_tz), 'HH24:MI') || '.');
  END IF;
  IF p_pin IS NULL OR pin.pin_hash <> extensions.crypt(p_pin, pin.pin_hash) THEN
    UPDATE hr.kiosk_pins SET failed_attempts = failed_attempts + 1,
        locked_until = CASE WHEN failed_attempts + 1 >= 5 THEN now() + interval '15 minutes' END
      WHERE employee_id = person.id;
    RETURN json_build_object('error', no_match);
  END IF;
  UPDATE hr.kiosk_pins SET failed_attempts = 0, locked_until = NULL WHERE employee_id = person.id;
  RETURN hr.clock_toggle(person, p_tz, 'kiosk');
END;
$$;

-- The person sets their own PIN; owners and admins can set anyone's
CREATE FUNCTION hr.set_kiosk_pin(p_tenant UUID, p_employee UUID, p_pin TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT hr.is_manager(p_tenant) AND (hr.my_employee(p_tenant)).id IS DISTINCT FROM p_employee THEN
    RAISE EXCEPTION 'You can only set your own PIN';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM hr.employees WHERE id = p_employee AND tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;
  IF p_pin IS NULL OR p_pin !~ '^[0-9]{4,8}$' THEN
    RAISE EXCEPTION 'A PIN is 4 to 8 numbers';
  END IF;
  IF p_pin ~ '^(.)\1+$' OR position(p_pin IN '0123456789') > 0 OR position(p_pin IN '9876543210') > 0 THEN
    RAISE EXCEPTION 'Choose a PIN that''s harder to guess than repeated or counting numbers';
  END IF;
  INSERT INTO hr.kiosk_pins (employee_id, tenant_id, pin_hash)
    VALUES (p_employee, p_tenant, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)))
    ON CONFLICT (employee_id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, failed_attempts = 0, locked_until = NULL, updated_at = now();
  RETURN json_build_object('success', true);
END;
$$;

-- Adds or changes a time entry. The person can fix their own until it's approved; their manager, owners
-- and admins can add and change anyone's they decide for. Approved entries only change by owners and admins.
CREATE FUNCTION hr.save_attendance(p_tenant UUID, p_entry UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  existing hr.attendance;
  person hr.employees;
  v_employee UUID;
  v_in TIMESTAMPTZ := nullif(p_data->>'check_in', '')::timestamptz;
  v_out TIMESTAMPTZ := nullif(p_data->>'check_out', '')::timestamptz;
  v_break INT := coalesce(nullif(p_data->>'break_minutes', '')::int, 0);
  v_note TEXT := nullif(btrim(coalesce(p_data->>'note', '')), '');
  v_tz TEXT := hr.valid_tz(p_data->>'tz');
  v_date DATE;
  is_self BOOLEAN;
  row_id UUID := p_entry;
BEGIN
  IF NOT hr.is_member(p_tenant) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF row_id IS NOT NULL THEN
    SELECT * INTO existing FROM hr.attendance WHERE id = row_id AND tenant_id = p_tenant FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Time entry not found';
    END IF;
    v_employee := existing.employee_id;
  ELSE
    v_employee := nullif(p_data->>'employee_id', '')::uuid;
  END IF;
  SELECT * INTO person FROM hr.employees WHERE id = v_employee AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;
  is_self := person.user_id = auth.uid();
  IF NOT hr.decides_for(p_tenant, v_employee) AND NOT is_self THEN
    RAISE EXCEPTION 'Only this person, their manager, an owner or an admin can change their time';
  END IF;
  IF existing.approved_at IS NOT NULL AND NOT hr.is_manager(p_tenant) THEN
    RAISE EXCEPTION 'This time is approved. Ask an owner or admin to change it.';
  END IF;

  IF v_in IS NULL THEN
    RAISE EXCEPTION 'Enter the time in';
  END IF;
  IF v_in > now() + interval '5 minutes' OR v_out > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Times can''t be in the future';
  END IF;
  IF v_out IS NOT NULL AND v_out <= v_in THEN
    RAISE EXCEPTION 'The time out must be after the time in';
  END IF;
  IF v_out - v_in > interval '24 hours' THEN
    RAISE EXCEPTION 'One entry can be up to 24 hours';
  END IF;
  IF v_break < 0 OR v_break > 600 OR (v_out IS NOT NULL AND v_break * interval '1 minute' >= v_out - v_in) THEN
    RAISE EXCEPTION 'The break must be shorter than the time worked';
  END IF;
  IF length(v_note) > 300 THEN
    RAISE EXCEPTION 'Keep the note under 300 characters';
  END IF;
  v_date := coalesce(nullif(p_data->>'work_date', '')::date, (v_in AT TIME ZONE v_tz)::date);
  IF abs(v_date - (v_in AT TIME ZONE 'UTC')::date) > 1 THEN
    RAISE EXCEPTION 'The day must match the time in';
  END IF;
  IF v_date < person.start_date OR v_date > coalesce(person.end_date, v_date) THEN
    RAISE EXCEPTION 'That day is outside this person''s employment';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('hr.attendance:' || v_employee::text, 0));
  IF EXISTS (SELECT 1 FROM hr.attendance a WHERE a.employee_id = v_employee AND a.id IS DISTINCT FROM row_id
      AND tstzrange(a.check_in, coalesce(a.check_out, 'infinity')) && tstzrange(v_in, coalesce(v_out, 'infinity'))) THEN
    RAISE EXCEPTION 'This overlaps another time entry';
  END IF;
  IF v_out IS NULL AND EXISTS (SELECT 1 FROM hr.attendance WHERE employee_id = v_employee AND check_out IS NULL
      AND id IS DISTINCT FROM row_id) THEN
    RAISE EXCEPTION 'This person is already clocked in';
  END IF;

  IF row_id IS NULL THEN
    INSERT INTO hr.attendance (tenant_id, employee_id, work_date, check_in, check_out, break_minutes, source, note, created_by)
      VALUES (p_tenant, v_employee, v_date, v_in, v_out, v_break, 'manual', v_note, auth.uid())
      RETURNING id INTO row_id;
  ELSE
    UPDATE hr.attendance SET work_date = v_date, check_in = v_in, check_out = v_out, break_minutes = v_break,
        note = v_note, updated_at = now(),
        approved_by = CASE WHEN approved_at IS NOT NULL AND v_out IS NOT NULL THEN auth.uid() END,
        approved_at = CASE WHEN approved_at IS NOT NULL AND v_out IS NOT NULL THEN now() END
      WHERE id = row_id;
  END IF;
  RETURN (SELECT row_to_json(a) FROM hr.attendance a WHERE id = row_id);
END;
$$;

CREATE FUNCTION hr.delete_attendance(p_tenant UUID, p_entry UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  entry hr.attendance;
BEGIN
  SELECT * INTO entry FROM hr.attendance WHERE id = p_entry AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND OR NOT (hr.can_see_employee(p_tenant, entry.employee_id)) THEN
    RAISE EXCEPTION 'Time entry not found';
  END IF;
  IF entry.approved_at IS NOT NULL AND NOT hr.is_manager(p_tenant) THEN
    RAISE EXCEPTION 'This time is approved. Ask an owner or admin to change it.';
  END IF;
  IF NOT hr.decides_for(p_tenant, entry.employee_id)
      AND NOT EXISTS (SELECT 1 FROM hr.employees WHERE id = entry.employee_id AND user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Only this person, their manager, an owner or an admin can change their time';
  END IF;
  DELETE FROM hr.attendance WHERE id = p_entry;
  RETURN json_build_object('success', true);
END;
$$;

-- Approves everyone's finished time between two dates that the caller decides for
CREATE FUNCTION hr.approve_attendance(p_tenant UUID, p_employee UUID, p_from DATE, p_to DATE)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_count INT;
  v_hours NUMERIC;
BEGIN
  IF NOT hr.is_member(p_tenant) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 62 THEN
    RAISE EXCEPTION 'Choose up to two months';
  END IF;
  IF NOT hr.decides_for(p_tenant, p_employee) THEN
    RAISE EXCEPTION 'Only this person''s manager, an owner or an admin can approve their time';
  END IF;
  WITH done AS (
    UPDATE hr.attendance SET approved_by = auth.uid(), approved_at = now()
    WHERE tenant_id = p_tenant AND employee_id = p_employee AND work_date BETWEEN p_from AND p_to
      AND check_out IS NOT NULL AND approved_at IS NULL
    RETURNING hours)
  SELECT count(*), coalesce(sum(hours), 0) INTO v_count, v_hours FROM done;
  RETURN json_build_object('approved', v_count, 'hours', v_hours);
END;
$$;

-- Hours for everyone the caller can see, between two dates
CREATE FUNCTION hr.attendance_summary(p_tenant UUID, p_from DATE, p_to DATE)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  payroll BOOLEAN := hr.can_run_payroll(p_tenant);
BEGIN
  IF NOT hr.is_member(p_tenant) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 62 THEN
    RAISE EXCEPTION 'Choose up to two months';
  END IF;
  RETURN coalesce((
    SELECT json_agg(json_build_object(
      'employee_id', e.id, 'employee_number', e.employee_number, 'name', btrim(e.first_name || ' ' || e.last_name),
      'usual_hours', c.hours_per_week, 'pay_type', CASE WHEN payroll THEN c.pay_type END,
      'hours', coalesce(t.hours, 0), 'approved_hours', coalesce(t.approved, 0), 'waiting', coalesce(t.waiting, 0),
      'clocked_in_since', (SELECT a.check_in FROM hr.attendance a WHERE a.employee_id = e.id AND a.check_out IS NULL),
      'can_decide', hr.decides_for(p_tenant, e.id),
      'has_pin', EXISTS (SELECT 1 FROM hr.kiosk_pins k WHERE k.employee_id = e.id)
    ) ORDER BY e.first_name, e.last_name)
    FROM hr.employees e
    LEFT JOIN hr.compensation c ON c.employee_id = e.id
    LEFT JOIN LATERAL (
      SELECT sum(a.hours) AS hours, sum(a.hours) FILTER (WHERE a.approved_at IS NOT NULL) AS approved,
        count(*) FILTER (WHERE a.approved_at IS NULL AND a.check_out IS NOT NULL) AS waiting
      FROM hr.attendance a WHERE a.employee_id = e.id AND a.work_date BETWEEN p_from AND p_to
    ) t ON true
    WHERE e.tenant_id = p_tenant AND e.employment_type <> 'contractor'
      AND e.start_date <= p_to AND (e.end_date IS NULL OR e.end_date >= p_from)
      AND (payroll OR hr.can_see_employee(p_tenant, e.id))
  ), '[]'::json);
END;
$$;

-- The signed-in person's own clock
CREATE FUNCTION hr.my_attendance(p_tenant UUID, p_tz TEXT)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  person hr.employees := hr.my_employee(p_tenant);
  v_today DATE := (now() AT TIME ZONE hr.valid_tz(p_tz))::date;
  v_week DATE := date_trunc('week', (now() AT TIME ZONE hr.valid_tz(p_tz)))::date;
BEGIN
  IF person.id IS NULL THEN
    RETURN json_build_object('employee', NULL);
  END IF;
  RETURN json_build_object(
    'employee', json_build_object('id', person.id, 'name', btrim(person.first_name || ' ' || person.last_name),
      'employee_number', person.employee_number),
    'clocked_in_since', (SELECT check_in FROM hr.attendance WHERE employee_id = person.id AND check_out IS NULL),
    'hours_today', (SELECT coalesce(sum(hours), 0) FROM hr.attendance WHERE employee_id = person.id AND work_date = v_today),
    'hours_this_week', (SELECT coalesce(sum(hours), 0) FROM hr.attendance WHERE employee_id = person.id
      AND work_date BETWEEN v_week AND v_week + 6),
    'usual_hours', (SELECT hours_per_week FROM hr.compensation WHERE employee_id = person.id),
    'has_pin', EXISTS (SELECT 1 FROM hr.kiosk_pins WHERE employee_id = person.id)
  );
END;
$$;

-- On a draft pay run, sets each hourly person's hours to their approved attendance in the month.
-- People with no approved time keep their usual hours. Taxes are worked out again from the rates,
-- as when hours are changed by hand.
CREATE FUNCTION hr.use_attendance_hours(p_tenant UUID, p_run UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  run hr.pay_runs;
  line RECORD;
  v_updated INT := 0;
  v_kept TEXT[] := '{}';
  v_waiting INT;
BEGIN
  PERFORM hr.require_payroll(p_tenant);
  run := hr.draft_run(p_tenant, p_run);
  FOR line IN
    SELECT l.id, l.employee_id, btrim(e.first_name || ' ' || e.last_name) AS name,
      (SELECT sum(a.hours) FROM hr.attendance a WHERE a.employee_id = l.employee_id AND a.approved_at IS NOT NULL
        AND a.work_date BETWEEN run.period_start AND run.period_end) AS approved
    FROM hr.pay_lines l JOIN hr.employees e ON e.id = l.employee_id
    WHERE l.run_id = p_run AND l.pay_type = 'hourly'
    ORDER BY e.first_name
  LOOP
    IF coalesce(line.approved, 0) > 0 THEN
      PERFORM hr.update_pay_line(p_tenant, line.id, jsonb_build_object('hours', least(line.approved, 744)));
      v_updated := v_updated + 1;
    ELSE
      v_kept := v_kept || line.name;
    END IF;
  END LOOP;
  SELECT count(*) INTO v_waiting FROM hr.attendance a JOIN hr.pay_lines l ON l.employee_id = a.employee_id AND l.run_id = p_run
    WHERE l.pay_type = 'hourly' AND a.approved_at IS NULL AND a.check_out IS NOT NULL
      AND a.work_date BETWEEN run.period_start AND run.period_end;
  RETURN json_build_object('updated', v_updated, 'kept_usual_hours', to_json(v_kept), 'waiting_entries', v_waiting);
END;
$$;

-- ===== Expense claims
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('hr-receipts', 'hr-receipts', false, 5242880, ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO NOTHING;

CREATE TABLE hr.expense_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  -- An expense account in the ledger. Empty means 6000 General Expenses.
  account_id UUID REFERENCES accounting.accounts(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_hr_expense_categories_name ON hr.expense_categories (tenant_id, lower(name));
CREATE INDEX idx_hr_expense_categories_account ON hr.expense_categories (account_id);
ALTER TABLE hr.expense_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON hr.expense_categories FOR SELECT TO authenticated USING (hr.is_member(tenant_id));
GRANT SELECT ON hr.expense_categories TO authenticated;

CREATE TABLE hr.expense_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  claim_number INT NOT NULL,
  employee_id UUID NOT NULL REFERENCES hr.employees(id),
  expense_date DATE NOT NULL,
  category_id UUID NOT NULL REFERENCES hr.expense_categories(id),
  description TEXT NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 300),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0 AND amount < 1e8),
  receipt_path TEXT UNIQUE CHECK (length(receipt_path) <= 500),
  receipt_size BIGINT CHECK (receipt_size > 0 AND receipt_size <= 5242880),
  receipt_mime TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected', 'cancelled', 'paid', 'void')),
  decided_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at TIMESTAMP,
  decision_note TEXT CHECK (length(decision_note) <= 500),
  paid_from UUID REFERENCES accounting.accounts(id),
  paid_on DATE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, claim_number)
);
CREATE INDEX idx_hr_expense_claims_employee ON hr.expense_claims (employee_id, expense_date);
CREATE INDEX idx_hr_expense_claims_tenant ON hr.expense_claims (tenant_id, status);
CREATE INDEX idx_hr_expense_claims_category ON hr.expense_claims (category_id);
CREATE INDEX idx_hr_expense_claims_paid_from ON hr.expense_claims (paid_from);
CREATE INDEX idx_hr_expense_claims_decided_by ON hr.expense_claims (decided_by);
CREATE INDEX idx_hr_expense_claims_created_by ON hr.expense_claims (created_by);
ALTER TABLE hr.expense_claims ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON hr.expense_claims FOR SELECT TO authenticated
  USING (hr.can_see_employee(tenant_id, employee_id) OR hr.handles_expenses(tenant_id));
GRANT SELECT ON hr.expense_claims TO authenticated;

-- A person with expense claims stays on record, like someone who has been on a pay run
CREATE FUNCTION hr.keep_claimants()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM hr.expense_claims WHERE employee_id = OLD.id) THEN
    RAISE EXCEPTION 'This person has expense claims, so they can''t be deleted. Add an end date instead.';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER keep_claimants BEFORE DELETE ON hr.employees FOR EACH ROW EXECUTE FUNCTION hr.keep_claimants();

-- 2510 Expenses to Reimburse holds what the company owes staff for approved claims
CREATE FUNCTION hr.reimburse_account(p_tenant UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_id UUID := accounting.account_by_code(p_tenant, '2510');
BEGIN
  IF v_id IS NULL THEN
    INSERT INTO accounting.accounts (tenant_id, code, name, type, is_system, is_cash)
      VALUES (p_tenant, '2510', 'Expenses to Reimburse', 'liability', true, false)
      ON CONFLICT (tenant_id, code) DO NOTHING;
    v_id := accounting.account_by_code(p_tenant, '2510');
  END IF;
  RETURN v_id;
END;
$$;

CREATE FUNCTION hr.save_expense_category(p_tenant UUID, p_category UUID, p_name TEXT, p_account UUID, p_active BOOLEAN)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_name TEXT := btrim(coalesce(p_name, ''));
  row_id UUID := p_category;
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  IF length(v_name) NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'Enter a name of up to 60 characters';
  END IF;
  IF p_account IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounting.accounts
      WHERE id = p_account AND tenant_id = p_tenant AND type = 'expense' AND is_active) THEN
    RAISE EXCEPTION 'Choose an expense account';
  END IF;
  IF row_id IS NULL THEN
    INSERT INTO hr.expense_categories (tenant_id, name, account_id) VALUES (p_tenant, v_name, p_account) RETURNING id INTO row_id;
  ELSE
    UPDATE hr.expense_categories SET name = v_name, account_id = p_account, is_active = coalesce(p_active, is_active)
      WHERE id = row_id AND tenant_id = p_tenant;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Category not found';
    END IF;
  END IF;
  RETURN (SELECT row_to_json(c) FROM hr.expense_categories c WHERE id = row_id);
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'That name is already used';
END;
$$;

-- Receipt files live at '<tenant>/<employee>/<uuid>-<file name>' in the private 'hr-receipts' bucket.
-- Each company has 200 MB.
CREATE FUNCTION hr.receipt_space_used(p_tenant UUID)
RETURNS BIGINT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce(sum(coalesce((metadata->>'size')::bigint, 0)), 0)::bigint FROM storage.objects
  WHERE bucket_id = 'hr-receipts' AND name LIKE p_tenant::text || '/%';
$$;

CREATE FUNCTION hr.can_upload_receipt_file(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  folders TEXT[] := storage.foldername(p_name);
  v_tenant UUID := hr.uuid_or_null(folders[1]);
  v_employee UUID := hr.uuid_or_null(folders[2]);
BEGIN
  IF coalesce(array_length(folders, 1), 0) <> 2 OR v_tenant IS NULL OR v_employee IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM hr.employees WHERE id = v_employee AND tenant_id = v_tenant)
    AND (hr.is_manager(v_tenant) OR (hr.my_employee(v_tenant)).id = v_employee)
    AND hr.receipt_space_used(v_tenant) < 209715200;
END;
$$;

CREATE FUNCTION hr.can_read_receipt_file(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  folders TEXT[] := storage.foldername(p_name);
  v_tenant UUID := hr.uuid_or_null(folders[1]);
  v_employee UUID := hr.uuid_or_null(folders[2]);
BEGIN
  IF v_tenant IS NULL OR v_employee IS NULL THEN
    RETURN false;
  END IF;
  RETURN hr.handles_expenses(v_tenant) OR hr.can_see_employee(v_tenant, v_employee);
END;
$$;

-- Owners and admins can remove any receipt; the person can remove their own until a live claim uses it
CREATE FUNCTION hr.can_delete_receipt_file(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  folders TEXT[] := storage.foldername(p_name);
  v_tenant UUID := hr.uuid_or_null(folders[1]);
  v_employee UUID := hr.uuid_or_null(folders[2]);
BEGIN
  IF v_tenant IS NULL OR v_employee IS NULL THEN
    RETURN false;
  END IF;
  RETURN hr.is_manager(v_tenant) OR ((hr.my_employee(v_tenant)).id = v_employee AND NOT EXISTS (
    SELECT 1 FROM hr.expense_claims WHERE receipt_path = p_name AND status IN ('submitted', 'approved', 'paid')));
END;
$$;

CREATE POLICY hr_receipts_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'hr-receipts' AND hr.can_read_receipt_file(name));
CREATE POLICY hr_receipts_upload ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'hr-receipts' AND hr.can_upload_receipt_file(name));
CREATE POLICY hr_receipts_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'hr-receipts' AND hr.can_delete_receipt_file(name));

-- "Travel, 45.00: Train to Leeds"
CREATE FUNCTION hr.expense_summary(p_claim hr.expense_claims)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce((SELECT name FROM hr.expense_categories WHERE id = p_claim.category_id), 'Expense') || ', '
    || to_char(p_claim.amount, 'FM999G999G990D00') || coalesce(' ' || (SELECT base_currency FROM accounting.settings WHERE tenant_id = p_claim.tenant_id), '')
    || ': ' || p_claim.description;
$$;

-- Staff send their own claims; owners and admins can send one for anyone
CREATE FUNCTION hr.submit_expense(p_tenant UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  person hr.employees;
  v_employee UUID := nullif(p_data->>'employee_id', '')::uuid;
  v_date DATE := nullif(p_data->>'expense_date', '')::date;
  v_category UUID := nullif(p_data->>'category_id', '')::uuid;
  v_description TEXT := btrim(coalesce(p_data->>'description', ''));
  v_amount NUMERIC := round(nullif(p_data->>'amount', '')::numeric, 2);
  v_path TEXT := nullif(p_data->>'receipt_path', '');
  v_prefix TEXT;
  v_meta JSONB;
  v_size BIGINT;
  v_mime TEXT;
  next_number INT;
  claim hr.expense_claims;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  SELECT * INTO person FROM hr.employees WHERE id = v_employee AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;
  IF NOT hr.is_manager(p_tenant) AND person.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'You can only claim your own expenses';
  END IF;
  IF v_date IS NULL OR v_date > current_date + 1 OR v_date < current_date - 365 THEN
    RAISE EXCEPTION 'Choose the date you spent it, within the last year';
  END IF;
  IF v_date < person.start_date - 60 THEN
    RAISE EXCEPTION 'That date is before this person started';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM hr.expense_categories WHERE id = v_category AND tenant_id = p_tenant AND is_active) THEN
    RAISE EXCEPTION 'Choose a category';
  END IF;
  IF length(v_description) NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'Say what it was for, in up to 300 characters';
  END IF;
  IF v_amount IS NULL OR v_amount <= 0 OR v_amount >= 1e8 THEN
    RAISE EXCEPTION 'Enter an amount more than zero';
  END IF;

  IF v_path IS NOT NULL THEN
    v_prefix := p_tenant::text || '/' || v_employee::text || '/';
    IF length(v_path) > 500 OR left(v_path, length(v_prefix)) <> v_prefix OR length(v_path) = length(v_prefix)
        OR position('/' IN substr(v_path, length(v_prefix) + 1)) > 0 THEN
      RAISE EXCEPTION 'The receipt isn''t in the right place';
    END IF;
    SELECT metadata INTO v_meta FROM storage.objects WHERE bucket_id = 'hr-receipts' AND name = v_path;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The receipt wasn''t uploaded. Please try again.';
    END IF;
    v_size := (v_meta->>'size')::bigint;
    v_mime := v_meta->>'mimetype';
    IF v_size IS NULL OR v_size <= 0 OR v_size > 5242880 THEN
      RAISE EXCEPTION 'Receipts can be up to 5 MB';
    END IF;
    IF v_mime IS NULL OR v_mime NOT IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp') THEN
      RAISE EXCEPTION 'Add the receipt as a PDF, JPEG, PNG or WebP file';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('hr.expense_claims:' || p_tenant::text, 0));
  IF v_size IS NOT NULL AND (SELECT coalesce(sum(receipt_size), 0) FROM hr.expense_claims WHERE tenant_id = p_tenant) + v_size > 209715200 THEN
    RAISE EXCEPTION 'Your company has used its 200 MB of receipt space. An owner or admin can remove old receipts.';
  END IF;
  SELECT coalesce(max(claim_number), 0) + 1 INTO next_number FROM hr.expense_claims WHERE tenant_id = p_tenant;
  INSERT INTO hr.expense_claims (tenant_id, claim_number, employee_id, expense_date, category_id, description, amount,
      receipt_path, receipt_size, receipt_mime, created_by)
    VALUES (p_tenant, next_number, v_employee, v_date, v_category, v_description, v_amount, v_path, v_size, v_mime, auth.uid())
    RETURNING * INTO claim;

  INSERT INTO crm.notifications (tenant_id, user_id, title, body, link, dedupe_key)
    SELECT p_tenant, d.uid, btrim(person.first_name || ' ' || person.last_name) || ' sent an expense claim',
      hr.expense_summary(claim), '/saas/hr/expenses', 'expense:' || claim.id || ':submitted'
    FROM hr.leave_deciders(p_tenant, v_employee, ARRAY[auth.uid(), person.user_id]) AS d(uid)
    ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
  RETURN row_to_json(claim);
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'That receipt is already on another claim';
END;
$$;

-- Approving books the cost: the category's expense account against what is owed to the person
CREATE FUNCTION hr.decide_expense(p_tenant UUID, p_claim UUID, p_status TEXT, p_note TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  claim hr.expense_claims;
  person hr.employees;
  v_account UUID;
  v_date DATE;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  IF p_status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Approve or reject the claim';
  END IF;
  SELECT * INTO claim FROM hr.expense_claims WHERE id = p_claim AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND OR NOT (hr.can_see_employee(p_tenant, claim.employee_id) OR hr.handles_expenses(p_tenant)) THEN
    RAISE EXCEPTION 'Claim not found';
  END IF;
  IF NOT hr.decides_for(p_tenant, claim.employee_id) THEN
    IF EXISTS (SELECT 1 FROM hr.employees WHERE id = claim.employee_id AND user_id = auth.uid()) THEN
      RAISE EXCEPTION 'Someone else needs to approve your own claim';
    END IF;
    RAISE EXCEPTION 'Only this person''s manager, an owner or an admin can decide this';
  END IF;
  IF claim.status <> 'submitted' THEN
    RAISE EXCEPTION 'This claim has already been %', claim.status;
  END IF;
  IF length(p_note) > 500 THEN
    RAISE EXCEPTION 'Keep the note under 500 characters';
  END IF;
  SELECT * INTO person FROM hr.employees WHERE id = claim.employee_id;

  IF p_status = 'approved' THEN
    SELECT coalesce(c.account_id, accounting.account_by_code(p_tenant, '6000')) INTO v_account
      FROM hr.expense_categories c WHERE c.id = claim.category_id;
    -- Booked on the day it was spent, or the first open day if the books are locked
    SELECT greatest(claim.expense_date, coalesce(s.lock_date + 1, claim.expense_date)) INTO v_date
      FROM accounting.settings s WHERE s.tenant_id = p_tenant;
    PERFORM accounting.insert_entry(p_tenant, coalesce(v_date, claim.expense_date),
      'Expense claim #' || claim.claim_number || ', ' || btrim(person.first_name || ' ' || person.last_name) || ': ' || left(claim.description, 100),
      'hr_expense', claim.id, NULL, jsonb_build_array(
        jsonb_build_object('account_id', v_account, 'debit', claim.amount, 'cost_center_id', person.cost_center_id),
        jsonb_build_object('account_id', hr.reimburse_account(p_tenant), 'credit', claim.amount)));
  END IF;
  UPDATE hr.expense_claims SET status = p_status, decided_by = auth.uid(), decided_at = now(),
      decision_note = nullif(btrim(p_note), '')
    WHERE id = p_claim RETURNING * INTO claim;

  INSERT INTO crm.notifications (tenant_id, user_id, title, body, link, dedupe_key)
    SELECT p_tenant, person.user_id,
      CASE WHEN p_status = 'approved' THEN 'Your expense claim was approved' ELSE 'Your expense claim wasn''t approved' END,
      hr.expense_summary(claim) || coalesce('. Note: ' || claim.decision_note, ''), '/saas/hr/expenses',
      'expense:' || claim.id || ':' || p_status
    FROM public.tenant_members tm
    WHERE tm.tenant_id = p_tenant AND tm.user_id = person.user_id AND person.user_id IS DISTINCT FROM auth.uid()
    ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
  RETURN row_to_json(claim);
END;
$$;

-- The person can take back a claim no one has decided yet; owners and admins can too
CREATE FUNCTION hr.cancel_expense(p_tenant UUID, p_claim UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  claim hr.expense_claims;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  SELECT * INTO claim FROM hr.expense_claims WHERE id = p_claim AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND OR NOT (hr.can_see_employee(p_tenant, claim.employee_id) OR hr.handles_expenses(p_tenant)) THEN
    RAISE EXCEPTION 'Claim not found';
  END IF;
  IF NOT hr.is_manager(p_tenant) AND NOT EXISTS (SELECT 1 FROM hr.employees WHERE id = claim.employee_id AND user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Only the person, an owner or an admin can cancel this';
  END IF;
  IF claim.status <> 'submitted' THEN
    RAISE EXCEPTION 'This claim has already been %', claim.status;
  END IF;
  UPDATE hr.expense_claims SET status = 'cancelled', decided_by = auth.uid(), decided_at = now() WHERE id = p_claim
    RETURNING * INTO claim;
  RETURN row_to_json(claim);
END;
$$;

-- Paying approved claims from a bank or cash account clears what is owed to staff
CREATE FUNCTION hr.pay_expenses(p_tenant UUID, p_claims UUID[], p_account UUID, p_date DATE)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  claim hr.expense_claims;
  person hr.employees;
  v_total NUMERIC := 0;
  v_count INT := 0;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  IF NOT hr.handles_expenses(p_tenant) THEN
    RAISE EXCEPTION 'Only owners, admins and accountants can pay expense claims';
  END IF;
  IF p_claims IS NULL OR cardinality(p_claims) = 0 OR cardinality(p_claims) > 100 THEN
    RAISE EXCEPTION 'Choose up to 100 claims to pay';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM accounting.accounts WHERE id = p_account AND tenant_id = p_tenant AND is_cash AND is_active) THEN
    RAISE EXCEPTION 'Choose a bank or cash account';
  END IF;
  IF p_date IS NULL THEN
    RAISE EXCEPTION 'Choose the date it was paid';
  END IF;
  FOR claim IN SELECT * FROM hr.expense_claims WHERE tenant_id = p_tenant AND id = ANY (p_claims) ORDER BY claim_number FOR UPDATE
  LOOP
    IF claim.status <> 'approved' THEN
      RAISE EXCEPTION 'Claim #% is %, so it can''t be paid', claim.claim_number, claim.status;
    END IF;
    SELECT * INTO person FROM hr.employees WHERE id = claim.employee_id;
    PERFORM accounting.insert_entry(p_tenant, p_date,
      'Expense claim #' || claim.claim_number || ' paid to ' || btrim(person.first_name || ' ' || person.last_name),
      'hr_expense_payment', claim.id, NULL, jsonb_build_array(
        jsonb_build_object('account_id', hr.reimburse_account(p_tenant), 'debit', claim.amount),
        jsonb_build_object('account_id', p_account, 'credit', claim.amount)));
    UPDATE hr.expense_claims SET status = 'paid', paid_from = p_account, paid_on = p_date WHERE id = claim.id
      RETURNING * INTO claim;
    INSERT INTO crm.notifications (tenant_id, user_id, title, body, link, dedupe_key)
      SELECT p_tenant, person.user_id, 'Your expense claim was paid', hr.expense_summary(claim), '/saas/hr/expenses',
        'expense:' || claim.id || ':paid'
      FROM public.tenant_members tm
      WHERE tm.tenant_id = p_tenant AND tm.user_id = person.user_id AND person.user_id IS DISTINCT FROM auth.uid()
      ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
    v_total := v_total + claim.amount;
    v_count := v_count + 1;
  END LOOP;
  IF v_count <> cardinality(p_claims) THEN
    RAISE EXCEPTION 'Claim not found';
  END IF;
  RETURN json_build_object('paid', v_count, 'total', v_total);
END;
$$;

-- Undoes an approved or paid claim in the ledger. The claim stays for the record.
CREATE FUNCTION hr.void_expense(p_tenant UUID, p_claim UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  claim hr.expense_claims;
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  SELECT * INTO claim FROM hr.expense_claims WHERE id = p_claim AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim not found';
  END IF;
  IF claim.status NOT IN ('approved', 'paid') THEN
    RAISE EXCEPTION 'Only an approved or paid claim can be voided';
  END IF;
  PERFORM accounting.sync_entry(p_tenant, 'hr_expense_payment', p_claim, NULL, NULL, NULL);
  PERFORM accounting.sync_entry(p_tenant, 'hr_expense', p_claim, NULL, NULL, NULL);
  UPDATE hr.expense_claims SET status = 'void' WHERE id = p_claim RETURNING * INTO claim;
  RETURN row_to_json(claim);
END;
$$;

-- ===== Onboarding and offboarding checklists
CREATE TABLE hr.checklist_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('onboarding', 'offboarding')),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  -- [{"title": "...", "days": 0, "who": "hr" | "manager" | "employee"}], days from the start or last day
  items JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(items) = 'array'),
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_hr_checklist_templates_name ON hr.checklist_templates (tenant_id, lower(name));
ALTER TABLE hr.checklist_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON hr.checklist_templates FOR SELECT TO authenticated USING (hr.is_manager(tenant_id));
GRANT SELECT ON hr.checklist_templates TO authenticated;

CREATE TABLE hr.employee_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES hr.employees(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('onboarding', 'offboarding')),
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  due_date DATE,
  who TEXT NOT NULL DEFAULT 'hr' CHECK (who IN ('hr', 'manager', 'employee')),
  position INT NOT NULL DEFAULT 0,
  done_at TIMESTAMP,
  done_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_hr_employee_tasks_employee ON hr.employee_tasks (employee_id, kind, position);
CREATE INDEX idx_hr_employee_tasks_tenant ON hr.employee_tasks (tenant_id, due_date) WHERE done_at IS NULL;
CREATE INDEX idx_hr_employee_tasks_done_by ON hr.employee_tasks (done_by);
CREATE INDEX idx_hr_employee_tasks_created_by ON hr.employee_tasks (created_by);
ALTER TABLE hr.employee_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON hr.employee_tasks FOR SELECT TO authenticated
  USING (hr.can_see_employee(tenant_id, employee_id));
GRANT SELECT ON hr.employee_tasks TO authenticated;

CREATE FUNCTION hr.clean_checklist_items(p_items JSONB)
RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
  item JSONB;
  result JSONB := '[]';
  v_title TEXT;
  v_days INT;
  v_who TEXT;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'Add between 1 and 50 steps';
  END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_title := btrim(coalesce(item->>'title', ''));
    IF length(v_title) NOT BETWEEN 1 AND 200 THEN
      RAISE EXCEPTION 'Each step needs a name of up to 200 characters';
    END IF;
    IF coalesce(item->>'days', '0') !~ '^-?[0-9]{1,3}$' THEN
      RAISE EXCEPTION 'Days must be a whole number';
    END IF;
    v_days := coalesce(nullif(item->>'days', '')::int, 0);
    IF v_days NOT BETWEEN -90 AND 365 THEN
      RAISE EXCEPTION 'Days must be between 90 before and 365 after';
    END IF;
    v_who := coalesce(nullif(item->>'who', ''), 'hr');
    IF v_who NOT IN ('hr', 'manager', 'employee') THEN
      RAISE EXCEPTION 'Choose who does each step';
    END IF;
    result := result || jsonb_build_array(jsonb_build_object('title', v_title, 'days', v_days, 'who', v_who));
  END LOOP;
  RETURN result;
END;
$$;

CREATE FUNCTION hr.save_checklist_template(p_tenant UUID, p_template UUID, p_kind TEXT, p_name TEXT, p_items JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_name TEXT := btrim(coalesce(p_name, ''));
  v_items JSONB := hr.clean_checklist_items(p_items);
  row_id UUID := p_template;
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  IF p_kind IS NULL OR p_kind NOT IN ('onboarding', 'offboarding') THEN
    RAISE EXCEPTION 'Choose onboarding or offboarding';
  END IF;
  IF length(v_name) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Enter a name of up to 100 characters';
  END IF;
  IF row_id IS NULL THEN
    INSERT INTO hr.checklist_templates (tenant_id, kind, name, items) VALUES (p_tenant, p_kind, v_name, v_items) RETURNING id INTO row_id;
  ELSE
    UPDATE hr.checklist_templates SET kind = p_kind, name = v_name, items = v_items WHERE id = row_id AND tenant_id = p_tenant;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Checklist not found';
    END IF;
  END IF;
  RETURN (SELECT row_to_json(t) FROM hr.checklist_templates t WHERE id = row_id);
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'That name is already used';
END;
$$;

CREATE FUNCTION hr.delete_checklist_template(p_tenant UUID, p_template UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  DELETE FROM hr.checklist_templates WHERE id = p_template AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Checklist not found';
  END IF;
  RETURN json_build_object('success', true);
END;
$$;

-- Tells the people who have steps to do. One alert each per checklist started.
CREATE FUNCTION hr.alert_new_tasks(p_tenant UUID, p_employee UUID, p_kind TEXT, p_key TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  person hr.employees;
  v_name TEXT;
BEGIN
  SELECT * INTO person FROM hr.employees WHERE id = p_employee;
  v_name := btrim(person.first_name || ' ' || person.last_name);
  INSERT INTO crm.notifications (tenant_id, user_id, title, body, link, dedupe_key)
    SELECT p_tenant, r.uid, r.title, r.body, '/saas/hr/employee/' || p_employee, p_key || ':' || r.uid
    FROM (
      SELECT person.user_id AS uid,
        CASE WHEN p_kind = 'onboarding' THEN 'Welcome! You have steps to do' ELSE 'You have steps to do before you leave' END AS title,
        (SELECT count(*) FROM hr.employee_tasks WHERE employee_id = p_employee AND kind = p_kind AND who = 'employee' AND done_at IS NULL)
          || ' steps on your ' || p_kind || ' checklist' AS body
      WHERE EXISTS (SELECT 1 FROM hr.employee_tasks WHERE employee_id = p_employee AND kind = p_kind AND who = 'employee' AND done_at IS NULL)
      UNION
      SELECT m.user_id, initcap(p_kind) || ' steps for ' || v_name,
        (SELECT count(*) FROM hr.employee_tasks WHERE employee_id = p_employee AND kind = p_kind AND who = 'manager' AND done_at IS NULL)
          || ' steps are yours as their manager'
      FROM hr.employees m
      WHERE m.id = person.manager_id
        AND EXISTS (SELECT 1 FROM hr.employee_tasks WHERE employee_id = p_employee AND kind = p_kind AND who = 'manager' AND done_at IS NULL)
    ) r
    JOIN public.tenant_members tm ON tm.tenant_id = p_tenant AND tm.user_id = r.uid
    WHERE r.uid IS DISTINCT FROM auth.uid()
    ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
END;
$$;

-- Copies a checklist's steps onto a person, due relative to their start date (onboarding) or last day
CREATE FUNCTION hr.start_checklist(p_tenant UUID, p_employee UUID, p_template UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  person hr.employees;
  template hr.checklist_templates;
  base DATE;
  v_start INT;
  v_count INT;
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  SELECT * INTO person FROM hr.employees WHERE id = p_employee AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;
  SELECT * INTO template FROM hr.checklist_templates WHERE id = p_template AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Checklist not found';
  END IF;
  base := CASE WHEN template.kind = 'onboarding' THEN person.start_date ELSE person.end_date END;
  IF base IS NULL THEN
    RAISE EXCEPTION 'Add this person''s last day (end date) before starting offboarding';
  END IF;
  SELECT coalesce(max(position), 0) INTO v_start FROM hr.employee_tasks WHERE employee_id = p_employee;
  INSERT INTO hr.employee_tasks (tenant_id, employee_id, kind, title, due_date, who, position, created_by)
    SELECT p_tenant, p_employee, template.kind, i.item->>'title', base + (i.item->>'days')::int, i.item->>'who', v_start + i.n::int, auth.uid()
    FROM jsonb_array_elements(template.items) WITH ORDINALITY AS i(item, n);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM hr.alert_new_tasks(p_tenant, p_employee, template.kind, 'tasks:' || p_employee || ':' || template.id || ':' || v_start);
  RETURN json_build_object('added', v_count);
END;
$$;

CREATE FUNCTION hr.add_task(p_tenant UUID, p_employee UUID, p_kind TEXT, p_title TEXT, p_due DATE, p_who TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  task hr.employee_tasks;
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  IF NOT EXISTS (SELECT 1 FROM hr.employees WHERE id = p_employee AND tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('onboarding', 'offboarding') THEN
    RAISE EXCEPTION 'Choose onboarding or offboarding';
  END IF;
  IF length(btrim(coalesce(p_title, ''))) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Enter a step of up to 200 characters';
  END IF;
  IF coalesce(p_who, 'hr') NOT IN ('hr', 'manager', 'employee') THEN
    RAISE EXCEPTION 'Choose who does this step';
  END IF;
  INSERT INTO hr.employee_tasks (tenant_id, employee_id, kind, title, due_date, who, position, created_by)
    VALUES (p_tenant, p_employee, p_kind, btrim(p_title), p_due, coalesce(p_who, 'hr'),
      (SELECT coalesce(max(position), 0) + 1 FROM hr.employee_tasks WHERE employee_id = p_employee), auth.uid())
    RETURNING * INTO task;
  RETURN row_to_json(task);
END;
$$;

-- Owners and admins tick any step; the manager ticks theirs; the person ticks their own
CREATE FUNCTION hr.set_task_done(p_tenant UUID, p_task UUID, p_done BOOLEAN)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  task hr.employee_tasks;
  person hr.employees;
BEGIN
  IF NOT hr.is_member(p_tenant) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  SELECT * INTO task FROM hr.employee_tasks WHERE id = p_task AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND OR NOT hr.can_see_employee(p_tenant, task.employee_id) THEN
    RAISE EXCEPTION 'Step not found';
  END IF;
  SELECT * INTO person FROM hr.employees WHERE id = task.employee_id;
  IF NOT hr.is_manager(p_tenant)
      AND NOT (task.who = 'employee' AND person.user_id = auth.uid())
      AND NOT (task.who = 'manager' AND EXISTS (SELECT 1 FROM hr.employees m WHERE m.id = person.manager_id AND m.user_id = auth.uid())) THEN
    RAISE EXCEPTION 'This step is for someone else';
  END IF;
  UPDATE hr.employee_tasks SET done_at = CASE WHEN p_done THEN coalesce(done_at, now()) END,
      done_by = CASE WHEN p_done THEN coalesce(done_by, auth.uid()) END
    WHERE id = p_task RETURNING * INTO task;
  RETURN row_to_json(task);
END;
$$;

CREATE FUNCTION hr.delete_task(p_tenant UUID, p_task UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  DELETE FROM hr.employee_tasks WHERE id = p_task AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Step not found';
  END IF;
  RETURN json_build_object('success', true);
END;
$$;

-- ===== Defaults for every company: expense categories and two checklists
CREATE FUNCTION hr.seed_extras(p_tenant UUID)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO hr.expense_categories (tenant_id, name)
  SELECT p_tenant, c.name FROM (VALUES ('Travel'), ('Meals'), ('Accommodation'), ('Office supplies'), ('Phone and internet'), ('Other')) AS c(name)
  WHERE NOT EXISTS (SELECT 1 FROM hr.expense_categories WHERE tenant_id = p_tenant);

  INSERT INTO hr.checklist_templates (tenant_id, kind, name, items)
  SELECT p_tenant, t.kind, t.name, t.items::jsonb FROM (VALUES
    ('onboarding', 'New starter', '[
      {"title": "Send the contract to sign", "days": -14, "who": "hr"},
      {"title": "Order a laptop and anything else they need", "days": -7, "who": "manager"},
      {"title": "Set up their email and sign-in, and link it to their employee record", "days": -2, "who": "hr"},
      {"title": "Welcome them and introduce the team", "days": 0, "who": "manager"},
      {"title": "Send bank details for payroll", "days": 0, "who": "employee"},
      {"title": "Read the staff handbook", "days": 5, "who": "employee"},
      {"title": "Set a kiosk PIN for clocking in", "days": 1, "who": "employee"},
      {"title": "First-month check-in", "days": 30, "who": "manager"}]'),
    ('offboarding', 'Leaver', '[
      {"title": "Confirm the last day and work out final pay and leave owed", "days": -14, "who": "hr"},
      {"title": "Hand over work and passwords to shared tools", "days": -5, "who": "employee"},
      {"title": "Exit conversation", "days": -2, "who": "manager"},
      {"title": "Return laptop, keys and cards", "days": 0, "who": "employee"},
      {"title": "Turn off their sign-ins", "days": 0, "who": "hr"}]')
  ) AS t(kind, name, items)
  WHERE NOT EXISTS (SELECT 1 FROM hr.checklist_templates WHERE tenant_id = p_tenant);
$$;

CREATE FUNCTION hr.seed_extras_for_new_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM hr.seed_extras(NEW.id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER seed_hr_extras AFTER INSERT ON public.tenants FOR EACH ROW EXECUTE FUNCTION hr.seed_extras_for_new_tenant();
SELECT hr.seed_extras(id) FROM public.tenants;

-- ===== Coming up: starts, last days and probation ends in the next weeks, for people the caller can see
CREATE FUNCTION hr.upcoming_dates(p_tenant UUID, p_days INT)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_to DATE := current_date + least(greatest(coalesce(p_days, 60), 1), 180);
BEGIN
  IF NOT hr.is_member(p_tenant) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  RETURN coalesce((
    SELECT json_agg(d ORDER BY d.on_date, d.name) FROM (
      SELECT e.id AS employee_id, btrim(e.first_name || ' ' || e.last_name) AS name, 'starts' AS kind, e.start_date AS on_date
        FROM hr.employees e WHERE e.tenant_id = p_tenant AND e.start_date BETWEEN current_date AND v_to
          AND hr.can_see_employee(p_tenant, e.id)
      UNION ALL
      SELECT e.id, btrim(e.first_name || ' ' || e.last_name), 'last_day', e.end_date
        FROM hr.employees e WHERE e.tenant_id = p_tenant AND e.end_date BETWEEN current_date AND v_to
          AND hr.can_see_employee(p_tenant, e.id)
      UNION ALL
      SELECT e.id, btrim(e.first_name || ' ' || e.last_name), 'probation_ends', t.probation_end_date
        FROM hr.employment_terms t JOIN hr.employees e ON e.id = t.employee_id
        WHERE t.tenant_id = p_tenant AND t.probation_end_date BETWEEN current_date AND v_to
          AND (e.end_date IS NULL OR e.end_date >= t.probation_end_date)
          AND hr.can_see_employee(p_tenant, e.id)
      UNION ALL
      SELECT e.id, btrim(e.first_name || ' ' || e.last_name) || ': ' || k.title, 'step_due', k.due_date
        FROM hr.employee_tasks k JOIN hr.employees e ON e.id = k.employee_id
        WHERE k.tenant_id = p_tenant AND k.done_at IS NULL AND k.due_date BETWEEN current_date - 30 AND v_to
          AND hr.can_see_employee(p_tenant, e.id)
    ) d
  ), '[]'::json);
END;
$$;

-- ===== Daily reminders in the Alerts bell. Run by the scheduler, not by people.
-- Last days: 30 and 7 days before. Probation ends: 14 and 3 days before. Each stage alerts once, so a
-- date added late still gets one alert. Checklist steps alert the person doing them on the day they're due.
CREATE FUNCTION hr.send_date_reminders()
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_count INT := 0;
  n INT;
BEGIN
  -- Owners, admins and the person's manager hear about last days and probation ends
  WITH due AS (
    SELECT e.tenant_id, e.id, e.manager_id, e.user_id, btrim(e.first_name || ' ' || e.last_name) AS name,
      'last_day' AS kind, e.end_date AS on_date, CASE WHEN e.end_date - current_date <= 7 THEN 7 ELSE 30 END AS stage
    FROM hr.employees e WHERE e.end_date BETWEEN current_date AND current_date + 30
    UNION ALL
    SELECT e.tenant_id, e.id, e.manager_id, e.user_id, btrim(e.first_name || ' ' || e.last_name),
      'probation', t.probation_end_date, CASE WHEN t.probation_end_date - current_date <= 3 THEN 3 ELSE 14 END
    FROM hr.employment_terms t JOIN hr.employees e ON e.id = t.employee_id
    WHERE t.probation_end_date BETWEEN current_date AND current_date + 14
      AND (e.end_date IS NULL OR e.end_date >= t.probation_end_date)
  ), people AS (
    SELECT d.*, tm.user_id AS uid FROM due d
    JOIN public.tenant_members tm ON tm.tenant_id = d.tenant_id AND tm.role IN ('owner', 'admin')
    UNION
    SELECT d.*, m.user_id FROM due d
    JOIN hr.employees m ON m.id = d.manager_id
    JOIN public.tenant_members tm ON tm.tenant_id = d.tenant_id AND tm.user_id = m.user_id
  )
  INSERT INTO crm.notifications (tenant_id, user_id, title, body, link, dedupe_key)
    SELECT p.tenant_id, p.uid,
      CASE WHEN p.kind = 'last_day' THEN p.name || '''s last day is coming up' ELSE p.name || '''s probation ends soon' END,
      CASE WHEN p.on_date = current_date THEN 'Today' ELSE to_char(p.on_date, 'FMDay DD Mon YYYY') END
        || CASE WHEN p.kind = 'last_day' THEN '. Start the leaver checklist if you haven''t.' ELSE '. Time for a review.' END,
      '/saas/hr/employee/' || p.id, 'hr-' || p.kind || ':' || p.id || ':' || p.on_date || ':' || p.stage
    FROM people p
    WHERE p.uid IS DISTINCT FROM p.user_id
    ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  v_count := v_count + n;

  -- Checklist steps due today or in the last week that aren't done
  WITH steps AS (
    SELECT k.*, e.user_id AS person_user, e.manager_id, btrim(e.first_name || ' ' || e.last_name) AS name
    FROM hr.employee_tasks k JOIN hr.employees e ON e.id = k.employee_id
    WHERE k.done_at IS NULL AND k.due_date BETWEEN current_date - 7 AND current_date
  ), people AS (
    SELECT s.*, s.person_user AS uid FROM steps s WHERE s.who = 'employee'
    UNION ALL
    SELECT s.*, m.user_id FROM steps s JOIN hr.employees m ON m.id = s.manager_id WHERE s.who = 'manager'
    UNION ALL
    SELECT s.*, tm.user_id FROM steps s JOIN public.tenant_members tm ON tm.tenant_id = s.tenant_id AND tm.role IN ('owner', 'admin')
    WHERE s.who = 'hr' OR (s.who = 'manager' AND s.manager_id IS NULL)
  )
  INSERT INTO crm.notifications (tenant_id, user_id, title, body, link, dedupe_key)
    SELECT p.tenant_id, p.uid,
      CASE WHEN p.who = 'employee' THEN 'A step on your checklist is due' ELSE 'A ' || p.kind || ' step for ' || p.name || ' is due' END,
      p.title, '/saas/hr/employee/' || p.employee_id, 'hr-step:' || p.id
    FROM people p
    JOIN public.tenant_members tm ON tm.tenant_id = p.tenant_id AND tm.user_id = p.uid
    ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN v_count + n;
END;
$$;

DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'hr-date-reminders';
  PERFORM cron.schedule('hr-date-reminders', '15 6 * * *', 'SELECT hr.send_date_reminders()');
END;
$$;

-- ===== Public holidays import. The app works out the dates; this adds the ones not already there.
CREATE FUNCTION hr.import_holidays(p_tenant UUID, p_days JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_added INT;
  v_total INT;
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  IF p_days IS NULL OR jsonb_typeof(p_days) <> 'array' OR jsonb_array_length(p_days) NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'Choose up to 60 holidays';
  END IF;
  v_total := jsonb_array_length(p_days);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_days) d
      WHERE coalesce(d->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$' OR length(btrim(coalesce(d->>'name', ''))) NOT BETWEEN 1 AND 100) THEN
    RAISE EXCEPTION 'Each holiday needs a date and a name';
  END IF;
  INSERT INTO hr.holidays (tenant_id, holiday_date, name)
    SELECT DISTINCT ON ((d->>'date')::date) p_tenant, (d->>'date')::date, btrim(d->>'name') FROM jsonb_array_elements(p_days) d
    ON CONFLICT (tenant_id, holiday_date) DO NOTHING;
  GET DIAGNOSTICS v_added = ROW_COUNT;
  RETURN json_build_object('added', v_added, 'skipped', v_total - v_added);
END;
$$;

-- ===== Access
DO $$
DECLARE
  fn TEXT;
BEGIN
  -- Used only inside other functions, triggers and the scheduler
  FOREACH fn IN ARRAY ARRAY['hr.decides_for(uuid, uuid)', 'hr.valid_tz(text)', 'hr.clock_toggle(hr.employees, text, text)',
      'hr.reimburse_account(uuid)', 'hr.receipt_space_used(uuid)', 'hr.expense_summary(hr.expense_claims)',
      'hr.keep_claimants()', 'hr.alert_new_tasks(uuid, uuid, text, text)', 'hr.clean_checklist_items(jsonb)',
      'hr.seed_extras(uuid)', 'hr.seed_extras_for_new_tenant()', 'hr.send_date_reminders()']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
  END LOOP;
  -- handles_expenses, my_employee and the storage checks run as the signed-in user inside policies
  FOREACH fn IN ARRAY ARRAY['hr.handles_expenses(uuid)', 'hr.my_employee(uuid)', 'hr.can_run_kiosk(uuid)',
      'hr.set_kiosk_user(uuid, uuid)', 'hr.set_probation(uuid, uuid, date)',
      'hr.clock(uuid, text)', 'hr.kiosk_clock(uuid, integer, text, text)', 'hr.set_kiosk_pin(uuid, uuid, text)',
      'hr.save_attendance(uuid, uuid, jsonb)', 'hr.delete_attendance(uuid, uuid)',
      'hr.approve_attendance(uuid, uuid, date, date)', 'hr.attendance_summary(uuid, date, date)',
      'hr.my_attendance(uuid, text)', 'hr.use_attendance_hours(uuid, uuid)',
      'hr.save_expense_category(uuid, uuid, text, uuid, boolean)',
      'hr.can_upload_receipt_file(text)', 'hr.can_read_receipt_file(text)', 'hr.can_delete_receipt_file(text)',
      'hr.submit_expense(uuid, jsonb)', 'hr.decide_expense(uuid, uuid, text, text)', 'hr.cancel_expense(uuid, uuid)',
      'hr.pay_expenses(uuid, uuid[], uuid, date)', 'hr.void_expense(uuid, uuid)',
      'hr.save_checklist_template(uuid, uuid, text, text, jsonb)', 'hr.delete_checklist_template(uuid, uuid)',
      'hr.start_checklist(uuid, uuid, uuid)', 'hr.add_task(uuid, uuid, text, text, date, text)',
      'hr.set_task_done(uuid, uuid, boolean)', 'hr.delete_task(uuid, uuid)',
      'hr.upcoming_dates(uuid, integer)', 'hr.import_holidays(uuid, jsonb)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
