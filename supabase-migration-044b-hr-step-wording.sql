-- Wording: "1 step" rather than "1 steps", and "A step on Nia's onboarding checklist is due".

CREATE FUNCTION hr.steps_text(p_count BIGINT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT p_count || CASE WHEN p_count = 1 THEN ' step' ELSE ' steps' END;
$$;
REVOKE EXECUTE ON FUNCTION hr.steps_text(BIGINT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION hr.alert_new_tasks(p_tenant UUID, p_employee UUID, p_kind TEXT, p_key TEXT)
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
        hr.steps_text((SELECT count(*) FROM hr.employee_tasks WHERE employee_id = p_employee AND kind = p_kind AND who = 'employee' AND done_at IS NULL))
          || ' on your ' || p_kind || ' checklist' AS body
      WHERE EXISTS (SELECT 1 FROM hr.employee_tasks WHERE employee_id = p_employee AND kind = p_kind AND who = 'employee' AND done_at IS NULL)
      UNION
      SELECT m.user_id, initcap(p_kind) || ' steps for ' || v_name,
        hr.steps_text((SELECT count(*) FROM hr.employee_tasks WHERE employee_id = p_employee AND kind = p_kind AND who = 'manager' AND done_at IS NULL))
          || ' for you as their manager'
      FROM hr.employees m
      WHERE m.id = person.manager_id
        AND EXISTS (SELECT 1 FROM hr.employee_tasks WHERE employee_id = p_employee AND kind = p_kind AND who = 'manager' AND done_at IS NULL)
    ) r
    JOIN public.tenant_members tm ON tm.tenant_id = p_tenant AND tm.user_id = r.uid
    WHERE r.uid IS DISTINCT FROM auth.uid()
    ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION hr.send_date_reminders()
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
      CASE WHEN p.who = 'employee' THEN 'A step on your checklist is due' ELSE 'A step on ' || p.name || '''s ' || p.kind || ' checklist is due' END,
      p.title, '/saas/hr/employee/' || p.employee_id, 'hr-step:' || p.id
    FROM people p
    JOIN public.tenant_members tm ON tm.tenant_id = p.tenant_id AND tm.user_id = p.uid
    ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN v_count + n;
END;
$$;

NOTIFY pgrst, 'reload schema';
