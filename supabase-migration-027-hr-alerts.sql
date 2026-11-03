-- HR alerts in the Alerts bell (crm.notifications). Triggers only, so every path that changes leave or
-- approves payroll raises them. People are alerted only while they are still in the company, and never
-- about something they did themself.

-- "Annual leave, 2 to 6 Nov (5 days)"
CREATE OR REPLACE FUNCTION hr.leave_summary(p_request hr.leave_requests)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce((SELECT t.name FROM hr.leave_types t WHERE t.id = p_request.leave_type_id), 'Leave') || ', ' ||
    CASE
      WHEN p_request.start_date = p_request.end_date THEN to_char(p_request.start_date, 'FMDD Mon')
      WHEN date_trunc('month', p_request.start_date) = date_trunc('month', p_request.end_date)
        THEN to_char(p_request.start_date, 'FMDD') || ' to ' || to_char(p_request.end_date, 'FMDD Mon')
      ELSE to_char(p_request.start_date, 'FMDD Mon') || ' to ' || to_char(p_request.end_date, 'FMDD Mon')
    END || ' (' ||
    CASE
      WHEN p_request.half_day THEN 'half a day'
      WHEN p_request.days = 1 THEN '1 day'
      ELSE trim_scale(p_request.days)::text || ' days'
    END || ')';
$$;

-- Who decides an employee's leave: their manager's linked user if that person is still in the company,
-- otherwise every owner and admin. Anyone in p_exclude is left out.
CREATE OR REPLACE FUNCTION hr.leave_deciders(p_tenant UUID, p_employee UUID, p_exclude UUID[])
RETURNS SETOF UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  skip UUID[] := array_remove(coalesce(p_exclude, '{}'::uuid[]), NULL);
  boss UUID;
BEGIN
  SELECT m.user_id INTO boss
    FROM hr.employees e
    JOIN hr.employees m ON m.id = e.manager_id
    JOIN public.tenant_members tm ON tm.tenant_id = p_tenant AND tm.user_id = m.user_id
    WHERE e.id = p_employee AND e.tenant_id = p_tenant AND NOT (m.user_id = ANY (skip));
  IF boss IS NOT NULL THEN
    RETURN NEXT boss;
    RETURN;
  END IF;
  RETURN QUERY SELECT tm.user_id FROM public.tenant_members tm
    WHERE tm.tenant_id = p_tenant AND tm.role IN ('owner', 'admin') AND NOT (tm.user_id = ANY (skip));
END;
$$;

-- A new request goes to the people who can decide it
CREATE OR REPLACE FUNCTION hr.alert_leave_requested()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  person hr.employees;
  who TEXT;
BEGIN
  SELECT * INTO person FROM hr.employees WHERE id = NEW.employee_id;
  who := btrim(person.first_name || ' ' || person.last_name);
  INSERT INTO crm.notifications (tenant_id, user_id, title, body, link, dedupe_key)
    SELECT NEW.tenant_id, d.uid,
      CASE WHEN NEW.created_by IS NOT DISTINCT FROM person.user_id OR NEW.created_by IS NULL
        THEN who || ' asked for leave' ELSE 'Leave request for ' || who END,
      hr.leave_summary(NEW), '/saas/hr/leave', 'leave:' || NEW.id || ':pending'
    FROM hr.leave_deciders(NEW.tenant_id, NEW.employee_id, ARRAY[NEW.created_by, person.user_id]) AS d(uid)
    ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
  RETURN NULL;
END;
$$;

-- Decisions go to the employee; cancellations go to the employee, or to their deciders when the
-- employee cancels leave that was already approved
CREATE OR REPLACE FUNCTION hr.alert_leave_status()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  person hr.employees;
  actor UUID := coalesce(NEW.decided_by, auth.uid());
  summary TEXT := hr.leave_summary(NEW);
  v_key TEXT := 'leave:' || NEW.id || ':' || NEW.status;
BEGIN
  SELECT * INTO person FROM hr.employees WHERE id = NEW.employee_id;

  IF NEW.status IN ('approved', 'rejected') AND OLD.status = 'pending' THEN
    INSERT INTO crm.notifications (tenant_id, user_id, title, body, link, dedupe_key)
      SELECT NEW.tenant_id, person.user_id,
        CASE WHEN NEW.status = 'approved' THEN 'Your leave was approved' ELSE 'Your leave wasn''t approved' END,
        summary || coalesce('. Note: ' || NEW.decision_note, ''), '/saas/hr', v_key
      FROM public.tenant_members tm
      WHERE tm.tenant_id = NEW.tenant_id AND tm.user_id = person.user_id AND person.user_id IS DISTINCT FROM actor
      ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;

  ELSIF NEW.status = 'cancelled' AND OLD.status IN ('pending', 'approved') THEN
    IF person.user_id IS DISTINCT FROM actor THEN
      INSERT INTO crm.notifications (tenant_id, user_id, title, body, link, dedupe_key)
        SELECT NEW.tenant_id, person.user_id, 'Your leave was cancelled', summary, '/saas/hr', v_key
        FROM public.tenant_members tm
        WHERE tm.tenant_id = NEW.tenant_id AND tm.user_id = person.user_id
        ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
    ELSIF OLD.status = 'approved' THEN
      INSERT INTO crm.notifications (tenant_id, user_id, title, body, link, dedupe_key)
        SELECT NEW.tenant_id, d.uid, btrim(person.first_name || ' ' || person.last_name) || ' cancelled their leave',
          summary, '/saas/hr/leave', v_key
        FROM hr.leave_deciders(NEW.tenant_id, NEW.employee_id, ARRAY[actor, person.user_id]) AS d(uid)
        ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- Approved payroll: each person on the run with a linked login hears their payslip is ready.
-- Keyed on the pay line, so the same payslip never alerts twice.
CREATE OR REPLACE FUNCTION hr.alert_payslips_ready()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  INSERT INTO crm.notifications (tenant_id, user_id, title, body, link, dedupe_key)
    SELECT NEW.tenant_id, e.user_id,
      'Your payslip for ' || to_char(NEW.period_start, 'FMMonth YYYY') || ' is ready',
      'Paid on ' || to_char(NEW.pay_date, 'FMDD Mon YYYY'),
      '/saas/hr/payslip/' || l.id, 'payslip:' || l.id
    FROM hr.pay_lines l
    JOIN hr.employees e ON e.id = l.employee_id
    JOIN public.tenant_members tm ON tm.tenant_id = NEW.tenant_id AND tm.user_id = e.user_id
    WHERE l.run_id = NEW.id
    ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS alert_leave_requested ON hr.leave_requests;
CREATE TRIGGER alert_leave_requested AFTER INSERT ON hr.leave_requests
  FOR EACH ROW WHEN (NEW.status = 'pending') EXECUTE FUNCTION hr.alert_leave_requested();

DROP TRIGGER IF EXISTS alert_leave_status ON hr.leave_requests;
CREATE TRIGGER alert_leave_status AFTER UPDATE OF status ON hr.leave_requests
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION hr.alert_leave_status();

DROP TRIGGER IF EXISTS alert_payslips_ready ON hr.pay_runs;
CREATE TRIGGER alert_payslips_ready AFTER UPDATE OF status ON hr.pay_runs
  FOR EACH ROW WHEN (NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved')
  EXECUTE FUNCTION hr.alert_payslips_ready();

REVOKE EXECUTE ON FUNCTION hr.leave_summary(hr.leave_requests) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION hr.leave_deciders(UUID, UUID, UUID[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION hr.alert_leave_requested() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION hr.alert_leave_status() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION hr.alert_payslips_ready() FROM PUBLIC, anon, authenticated;
