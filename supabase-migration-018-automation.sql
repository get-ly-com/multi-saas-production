-- CRM automation: rules that create tasks, send alerts and assign records, plus daily task reminders.
-- Rules run inside the database, so a lead from the web form, an import or a conversion is treated the same.
-- Time based rules run every hour with pg_cron. Alerts are in the app; nothing is emailed.

CREATE EXTENSION IF NOT EXISTS pg_cron;

ALTER TABLE crm.lead_settings ADD COLUMN task_reminders BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE crm.automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  enabled BOOLEAN NOT NULL DEFAULT true,
  event TEXT NOT NULL CHECK (event IN (
    'lead_created', 'lead_hot', 'lead_idle',
    'deal_created', 'deal_stage', 'deal_won', 'deal_lost', 'deal_idle', 'deal_closing',
    'quote_expiring'
  )),
  -- Stays set to null when its stage is deleted, and a rule with no stage never runs
  stage_id UUID REFERENCES crm.stages(id) ON DELETE SET NULL,
  days INT CHECK (days BETWEEN 0 AND 365),
  source TEXT,
  min_value NUMERIC CHECK (min_value >= 0),
  actions JSONB NOT NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_automations_tenant ON crm.automations (tenant_id, event) WHERE enabled;

-- One row for each time a rule meets a record. The unique key stops a rule repeating itself.
CREATE TABLE crm.automation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  automation_id UUID NOT NULL REFERENCES crm.automations(id) ON DELETE CASCADE,
  record_kind TEXT NOT NULL CHECK (record_kind IN ('lead', 'deal', 'quote')),
  record_id UUID NOT NULL,
  record_name TEXT,
  link TEXT,
  run_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done', 'failed', 'skipped')),
  error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (automation_id, record_id, run_key)
);
CREATE INDEX idx_crm_automation_runs_tenant ON crm.automation_runs (tenant_id, created_at DESC);

CREATE TABLE crm.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  dedupe_key TEXT,
  read_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_notifications_user ON crm.notifications (user_id, tenant_id, created_at DESC);
CREATE UNIQUE INDEX uq_crm_notifications_dedupe ON crm.notifications (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- A rule's own task is not sales activity: it must not raise a score or make a deal look busy
ALTER TABLE crm.activities ADD COLUMN automation_id UUID REFERENCES crm.automations(id) ON DELETE SET NULL;

ALTER TABLE crm.automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.automation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_rows ON crm.automations FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid())));
CREATE POLICY tenant_rows ON crm.automation_runs FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid())));
CREATE POLICY own_rows ON crm.notifications FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) AND tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid())));

GRANT SELECT ON crm.automations, crm.automation_runs, crm.notifications TO authenticated;

CREATE OR REPLACE FUNCTION crm.prepare_lead()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  scoring crm.score_rules;
  touches INT := 0;
  earned INT;
  label TEXT;
  total INT := 0;
  reasons JSONB := '[]'::jsonb;
BEGIN
  NEW.name := trim(NEW.name);
  NEW.email := nullif(lower(trim(coalesce(NEW.email, ''))), '');
  NEW.phone := nullif(trim(coalesce(NEW.phone, '')), '');
  NEW.company_name := nullif(trim(coalesce(NEW.company_name, '')), '');
  NEW.job_title := nullif(trim(coalesce(NEW.job_title, '')), '');
  NEW.source := nullif(trim(coalesce(NEW.source, '')), '');

  IF NOT crm.trusted() THEN
    IF NEW.status = 'converted' AND (TG_OP = 'INSERT' OR OLD.status <> 'converted') THEN
      RAISE EXCEPTION 'Use Convert to turn a lead into a contact';
    END IF;
    IF TG_OP = 'INSERT' THEN
      NEW.from_form := false;
      NEW.converted_contact_id := NULL;
      NEW.converted_company_id := NULL;
      NEW.converted_deal_id := NULL;
      NEW.converted_at := NULL;
    ELSE
      NEW.from_form := OLD.from_form;
      NEW.converted_contact_id := OLD.converted_contact_id;
      NEW.converted_company_id := OLD.converted_company_id;
      NEW.converted_deal_id := OLD.converted_deal_id;
      NEW.converted_at := OLD.converted_at;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'converted' AND NEW.status <> 'converted' THEN
    RAISE EXCEPTION 'This lead has already been converted';
  END IF;
  IF NEW.status <> 'disqualified' THEN
    NEW.disqualified_reason := NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.owner_id := coalesce(NEW.owner_id, crm.next_owner(NEW.tenant_id), auth.uid());
  ELSE
    SELECT count(*) INTO touches FROM crm.activities a WHERE a.lead_id = NEW.id AND a.automation_id IS NULL;
  END IF;

  FOR scoring IN SELECT * FROM crm.score_rules r WHERE r.tenant_id = NEW.tenant_id LOOP
    earned := 0;
    IF scoring.kind = 'email' AND NEW.email IS NOT NULL THEN
      earned := scoring.points;
      label := 'Has an email';
    ELSIF scoring.kind = 'phone' AND NEW.phone IS NOT NULL THEN
      earned := scoring.points;
      label := 'Has a phone number';
    ELSIF scoring.kind = 'company' AND NEW.company_name IS NOT NULL THEN
      earned := scoring.points;
      label := 'Has a company';
    ELSIF scoring.kind = 'title_contains' AND position(lower(scoring.match) IN lower(coalesce(NEW.job_title, ''))) > 0 THEN
      earned := scoring.points;
      label := 'Job title has ' || scoring.match;
    ELSIF scoring.kind = 'source_is' AND lower(scoring.match) = lower(coalesce(NEW.source, '')) THEN
      earned := scoring.points;
      label := 'Came from ' || scoring.match;
    ELSIF scoring.kind = 'activity' AND touches > 0 THEN
      earned := scoring.points * least(touches, 5);
      label := least(touches, 5) || ' logged on the timeline';
    END IF;
    IF earned <> 0 THEN
      total := total + earned;
      reasons := reasons || jsonb_build_object('label', label, 'points', earned);
    END IF;
  END LOOP;

  NEW.score := greatest(0, least(100, total));
  NEW.score_reasons := reasons;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Who a rule means. If a record's owner has left, or it has none, the person who wrote the rule gets it.
CREATE FUNCTION crm.recipients(p_rule crm.automations, p_who TEXT, p_owner UUID)
RETURNS UUID[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  team UUID[];
  managers UUID[];
BEGIN
  SELECT array_agg(m.user_id), array_agg(m.user_id) FILTER (WHERE m.role IN ('owner', 'admin'))
    INTO team, managers
    FROM public.tenant_members m WHERE m.tenant_id = p_rule.tenant_id;

  IF p_who = 'managers' THEN
    RETURN managers;
  END IF;
  IF p_who <> 'owner' THEN
    IF NOT p_who::uuid = ANY(team) THEN
      RAISE EXCEPTION 'The person chosen in this rule is no longer on the team';
    END IF;
    RETURN ARRAY[p_who::uuid];
  END IF;
  IF p_owner = ANY(team) THEN
    RETURN ARRAY[p_owner];
  END IF;
  IF p_rule.created_by = ANY(team) THEN
    RETURN ARRAY[p_rule.created_by];
  END IF;
  RETURN managers;
END;
$$;

-- Returns false once the company has reached its daily limit. A failed rule is logged and never
-- stops the save that set it off, so the failure undoes only that rule's own actions.
CREATE FUNCTION crm.run_rule(
  p_rule crm.automations, p_kind TEXT, p_id UUID, p_name TEXT, p_owner UUID,
  p_links JSONB, p_path TEXT, p_key TEXT, p_scheduled BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  the_run UUID;
  owner UUID := p_owner;
  action JSONB;
  who UUID;
BEGIN
  IF (SELECT count(*) FROM crm.automation_runs r
      WHERE r.tenant_id = p_rule.tenant_id AND r.created_at >= date_trunc('day', now())) >= 2000 THEN
    IF NOT p_scheduled THEN
      INSERT INTO crm.automation_runs (tenant_id, automation_id, record_kind, record_id, record_name, link, run_key, status, error)
        VALUES (p_rule.tenant_id, p_rule.id, p_kind, p_id, p_name, p_path, p_key, 'skipped', 'The limit of 2000 runs a day was reached')
        ON CONFLICT DO NOTHING;
    END IF;
    RETURN false;
  END IF;

  INSERT INTO crm.automation_runs (tenant_id, automation_id, record_kind, record_id, record_name, link, run_key)
    VALUES (p_rule.tenant_id, p_rule.id, p_kind, p_id, p_name, p_path, p_key)
    ON CONFLICT DO NOTHING
    RETURNING id INTO the_run;
  IF the_run IS NULL THEN
    RETURN true;
  END IF;

  BEGIN
    -- An earlier rule may have just assigned this record
    IF p_kind = 'lead' THEN
      SELECT l.owner_id INTO owner FROM crm.leads l WHERE l.id = p_id;
    ELSIF p_kind = 'deal' THEN
      SELECT d.owner_id INTO owner FROM crm.deals d WHERE d.id = p_id;
    END IF;

    FOR action IN SELECT value FROM jsonb_array_elements(p_rule.actions) LOOP
      IF action->>'type' = 'assign' THEN
        owner := (action->>'to')::uuid;
        IF p_kind = 'lead' THEN
          UPDATE crm.leads SET owner_id = owner WHERE id = p_id;
        ELSE
          UPDATE crm.deals SET owner_id = owner WHERE id = p_id;
        END IF;

      ELSIF action->>'type' = 'task' THEN
        who := (crm.recipients(p_rule, action->>'to', owner))[1];
        INSERT INTO crm.activities (tenant_id, kind, subject, due_on, owner_id, lead_id, deal_id, contact_id, company_id, automation_id)
          VALUES (
            p_rule.tenant_id, 'task', left(replace(action->>'subject', '{name}', p_name), 200),
            current_date + (action->>'due_days')::int, who,
            (p_links->>'lead_id')::uuid, (p_links->>'deal_id')::uuid, (p_links->>'contact_id')::uuid, (p_links->>'company_id')::uuid,
            p_rule.id
          );

      ELSIF action->>'type' = 'alert' THEN
        INSERT INTO crm.notifications (tenant_id, user_id, title, body, link)
          SELECT p_rule.tenant_id, person, left(replace(action->>'message', '{name}', p_name), 200), p_rule.name, p_path
          FROM unnest(crm.recipients(p_rule, action->>'to', owner)) AS person;
      END IF;
    END LOOP;
  EXCEPTION WHEN others THEN
    UPDATE crm.automation_runs SET status = 'failed', error = left(SQLERRM, 300) WHERE id = the_run;
  END;
  RETURN true;
END;
$$;

CREATE FUNCTION crm.lead_events()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  rule crm.automations;
  turned_hot BOOLEAN := NEW.score >= 60 AND NEW.status IN ('new', 'working') AND (TG_OP = 'INSERT' OR OLD.score < 60);
BEGIN
  IF TG_OP = 'UPDATE' AND NOT turned_hot THEN
    RETURN NULL;
  END IF;

  FOR rule IN
    SELECT * FROM crm.automations a
    WHERE a.tenant_id = NEW.tenant_id AND a.enabled
      AND ((a.event = 'lead_created' AND TG_OP = 'INSERT') OR (a.event = 'lead_hot' AND turned_hot))
      AND (a.source IS NULL OR lower(a.source) = lower(coalesce(NEW.source, '')))
    ORDER BY a.created_at
  LOOP
    PERFORM crm.run_rule(rule, 'lead', NEW.id, NEW.name, NEW.owner_id, jsonb_build_object('lead_id', NEW.id),
      '/saas/crm/lead/' || NEW.id, rule.event, false);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER z_automation AFTER INSERT OR UPDATE ON crm.leads
  FOR EACH ROW EXECUTE FUNCTION crm.lead_events();

CREATE FUNCTION crm.deal_events()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  rule crm.automations;
  moved BOOLEAN := TG_OP = 'INSERT' OR NEW.stage_id IS DISTINCT FROM OLD.stage_id;
  stage_kind TEXT;
BEGIN
  IF NOT moved THEN
    RETURN NULL;
  END IF;
  SELECT s.kind INTO stage_kind FROM crm.stages s WHERE s.id = NEW.stage_id;

  FOR rule IN
    SELECT * FROM crm.automations a
    WHERE a.tenant_id = NEW.tenant_id AND a.enabled
      AND ((a.event = 'deal_created' AND TG_OP = 'INSERT')
        OR (a.event = 'deal_stage' AND a.stage_id = NEW.stage_id)
        OR (a.event = 'deal_won' AND stage_kind = 'won')
        OR (a.event = 'deal_lost' AND stage_kind = 'lost'))
      AND coalesce(NEW.value, 0) >= coalesce(a.min_value, 0)
    ORDER BY a.created_at
  LOOP
    PERFORM crm.run_rule(rule, 'deal', NEW.id, NEW.title, NEW.owner_id, jsonb_build_object('deal_id', NEW.id),
      '/saas/crm/deal/' || NEW.id,
      CASE WHEN rule.event = 'deal_created' THEN 'created' ELSE extract(epoch FROM NEW.stage_changed_at)::text END,
      false);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER z_automation AFTER INSERT OR UPDATE OF stage_id ON crm.deals
  FOR EACH ROW EXECUTE FUNCTION crm.deal_events();

-- The records a time based rule applies to now. The key holds the date that matters, so
-- a deal that goes quiet again, or a close date that moves, can run the rule once more.
CREATE FUNCTION crm.due_records(p_rule crm.automations)
RETURNS TABLE (kind TEXT, id UUID, name TEXT, owner UUID, links JSONB, path TEXT, run_key TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT r.* FROM (
    SELECT 'deal'::text, d.id, d.title, d.owner_id, jsonb_build_object('deal_id', d.id), '/saas/crm/deal/' || d.id,
      greatest(d.stage_changed_at, t.touched)::date::text
    FROM crm.deals d
    JOIN crm.stages s ON s.id = d.stage_id
    LEFT JOIN LATERAL (
      SELECT max(greatest(a.done_at, CASE WHEN a.automation_id IS NULL THEN a.created_at END)) AS touched
      FROM crm.activities a WHERE a.deal_id = d.id
    ) t ON true
    WHERE p_rule.event = 'deal_idle' AND d.tenant_id = p_rule.tenant_id AND s.kind = 'open'
      AND coalesce(d.value, 0) >= coalesce(p_rule.min_value, 0)
      AND greatest(d.stage_changed_at, t.touched) < now() - make_interval(days => p_rule.days)

    UNION ALL
    SELECT 'deal', d.id, d.title, d.owner_id, jsonb_build_object('deal_id', d.id), '/saas/crm/deal/' || d.id,
      d.expected_close::text
    FROM crm.deals d
    JOIN crm.stages s ON s.id = d.stage_id
    WHERE p_rule.event = 'deal_closing' AND d.tenant_id = p_rule.tenant_id AND s.kind = 'open'
      AND coalesce(d.value, 0) >= coalesce(p_rule.min_value, 0)
      AND d.expected_close BETWEEN current_date AND current_date + p_rule.days

    UNION ALL
    SELECT 'lead', l.id, l.name, l.owner_id, jsonb_build_object('lead_id', l.id), '/saas/crm/lead/' || l.id,
      greatest(l.created_at, t.touched)::date::text
    FROM crm.leads l
    LEFT JOIN LATERAL (
      SELECT max(greatest(a.done_at, CASE WHEN a.automation_id IS NULL THEN a.created_at END)) AS touched
      FROM crm.activities a WHERE a.lead_id = l.id
    ) t ON true
    WHERE p_rule.event = 'lead_idle' AND l.tenant_id = p_rule.tenant_id AND l.status IN ('new', 'working')
      AND (p_rule.source IS NULL OR lower(p_rule.source) = lower(coalesce(l.source, '')))
      AND greatest(l.created_at, t.touched) < now() - make_interval(days => p_rule.days)

    UNION ALL
    SELECT 'quote', q.id, q.quote_number, coalesce(d.owner_id, q.created_by),
      jsonb_build_object('deal_id', q.deal_id, 'contact_id', q.contact_id, 'company_id', q.company_id),
      '/saas/crm/quote/' || q.id, q.valid_until::text
    FROM crm.quotes q
    LEFT JOIN crm.deals d ON d.id = q.deal_id
    WHERE p_rule.event = 'quote_expiring' AND q.tenant_id = p_rule.tenant_id AND q.status = 'sent'
      AND q.total >= coalesce(p_rule.min_value, 0)
      AND q.valid_until BETWEEN current_date AND current_date + p_rule.days
  ) r (kind, id, name, owner, links, path, run_key)
  WHERE NOT EXISTS (
    SELECT 1 FROM crm.automation_runs x
    WHERE x.automation_id = p_rule.id AND x.record_id = r.id AND x.run_key = r.run_key
  )
  LIMIT 200;
$$;

CREATE FUNCTION crm.run_tenant(p_tenant UUID)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  rule crm.automations;
  item RECORD;
  handled INT := 0;
BEGIN
  <<rules>>
  FOR rule IN
    SELECT * FROM crm.automations a
    WHERE a.tenant_id = p_tenant AND a.enabled
      AND a.event IN ('lead_idle', 'deal_idle', 'deal_closing', 'quote_expiring')
    ORDER BY a.created_at
  LOOP
    FOR item IN SELECT * FROM crm.due_records(rule) LOOP
      EXIT rules WHEN NOT crm.run_rule(rule, item.kind, item.id, item.name, item.owner, item.links, item.path, item.run_key, true);
      handled := handled + 1;
    END LOOP;
  END LOOP;

  INSERT INTO crm.notifications (tenant_id, user_id, title, body, link, dedupe_key)
    SELECT p_tenant, a.owner_id,
      CASE WHEN count(*) = 1 THEN 'You have 1 task due' ELSE 'You have ' || count(*) || ' tasks due' END,
      CASE WHEN count(*) FILTER (WHERE a.due_on < current_date) > 0
        THEN count(*) FILTER (WHERE a.due_on < current_date) || ' overdue' END,
      '/saas/crm/tasks', 'tasks-' || current_date
    FROM crm.activities a
    JOIN public.tenant_members m ON m.tenant_id = a.tenant_id AND m.user_id = a.owner_id
    JOIN crm.lead_settings s ON s.tenant_id = a.tenant_id AND s.task_reminders
    WHERE a.tenant_id = p_tenant AND a.kind = 'task' AND a.done_at IS NULL AND a.due_on <= current_date
    GROUP BY a.owner_id
    ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;

  RETURN handled;
END;
$$;

-- Called by pg_cron. One company's problem must not stop the others.
CREATE FUNCTION crm.run_scheduled()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  company UUID;
BEGIN
  FOR company IN SELECT t.id FROM public.tenants t LOOP
    BEGIN
      PERFORM crm.run_tenant(company);
    EXCEPTION WHEN others THEN
      RAISE WARNING 'Automation failed for %: %', company, SQLERRM;
    END;
  END LOOP;

  DELETE FROM crm.notifications WHERE created_at < now() - interval '90 days';
  DELETE FROM crm.automation_runs WHERE created_at < now() - interval '1 year';
END;
$$;

CREATE FUNCTION crm.run_automations_now(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  RETURN json_build_object('handled', crm.run_tenant(p_tenant));
END;
$$;

CREATE FUNCTION crm.save_automation(p_tenant UUID, p_rule UUID, p_name TEXT, p_event TEXT, p_stage UUID, p_days INT, p_source TEXT, p_min_value NUMERIC, p_actions JSONB)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  on_lead BOOLEAN := p_event IN ('lead_created', 'lead_hot', 'lead_idle');
  on_quote BOOLEAN := p_event = 'quote_expiring';
  timed BOOLEAN := p_event IN ('lead_idle', 'deal_idle', 'deal_closing', 'quote_expiring');
  item JSONB;
  clean JSONB := '[]'::jsonb;
  the_rule UUID := p_rule;
  person TEXT;
BEGIN
  PERFORM accounting.require_manager(p_tenant);

  IF length(trim(coalesce(p_name, ''))) = 0 OR length(p_name) > 80 THEN
    RAISE EXCEPTION 'Enter a rule name of up to 80 characters';
  END IF;
  IF coalesce(p_event, '') NOT IN ('lead_created', 'lead_hot', 'lead_idle', 'deal_created', 'deal_stage', 'deal_won', 'deal_lost', 'deal_idle', 'deal_closing', 'quote_expiring') THEN
    RAISE EXCEPTION 'Choose when this rule runs';
  END IF;
  IF timed AND (p_days IS NULL OR p_days NOT BETWEEN 0 AND 365 OR (p_days = 0 AND p_event IN ('lead_idle', 'deal_idle'))) THEN
    RAISE EXCEPTION 'Enter a number of days up to 365';
  END IF;
  IF p_event = 'deal_stage' AND NOT EXISTS (SELECT 1 FROM crm.stages s WHERE s.id = p_stage AND s.tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'Choose a stage';
  END IF;
  IF jsonb_typeof(p_actions) IS DISTINCT FROM 'array' OR jsonb_array_length(p_actions) NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION 'Add between 1 and 5 actions';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_actions) LOOP
    person := nullif(item->>'to', '');

    IF person IS NOT NULL AND person NOT IN ('owner', 'managers') THEN
      IF person !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR NOT EXISTS (
        SELECT 1 FROM public.tenant_members m
        WHERE m.tenant_id = p_tenant AND m.user_id = person::uuid
          AND (item->>'type' = 'alert' OR m.role <> 'viewer')
      ) THEN
        RAISE EXCEPTION 'That person can''t be chosen for this action';
      END IF;
    END IF;

    IF item->>'type' = 'task' THEN
      IF length(trim(coalesce(item->>'subject', ''))) = 0 OR length(item->>'subject') > 200 THEN
        RAISE EXCEPTION 'Enter what the task should say';
      END IF;
      IF coalesce(item->>'due_days', '') !~ '^[0-9]{1,3}$' OR (item->>'due_days')::int > 365 THEN
        RAISE EXCEPTION 'Enter when the task is due, up to 365 days';
      END IF;
      IF person IS NULL OR person = 'managers' THEN
        RAISE EXCEPTION 'Choose who the task is for';
      END IF;
      clean := clean || jsonb_build_object('type', 'task', 'subject', trim(item->>'subject'), 'due_days', (item->>'due_days')::int, 'to', person);

    ELSIF item->>'type' = 'alert' THEN
      IF length(trim(coalesce(item->>'message', ''))) = 0 OR length(item->>'message') > 200 THEN
        RAISE EXCEPTION 'Enter what the alert should say';
      END IF;
      IF person IS NULL THEN
        RAISE EXCEPTION 'Choose who gets the alert';
      END IF;
      clean := clean || jsonb_build_object('type', 'alert', 'message', trim(item->>'message'), 'to', person);

    ELSIF item->>'type' = 'assign' THEN
      IF on_quote THEN
        RAISE EXCEPTION 'A quote can''t be assigned';
      END IF;
      IF person IS NULL OR person IN ('owner', 'managers') THEN
        RAISE EXCEPTION 'Choose who to assign it to';
      END IF;
      clean := clean || jsonb_build_object('type', 'assign', 'to', person);

    ELSE
      RAISE EXCEPTION 'Choose an action';
    END IF;
  END LOOP;

  IF the_rule IS NULL THEN
    IF (SELECT count(*) FROM crm.automations a WHERE a.tenant_id = p_tenant) >= 50 THEN
      RAISE EXCEPTION 'A company can have up to 50 rules';
    END IF;
    INSERT INTO crm.automations (tenant_id, name, event, stage_id, days, source, min_value, actions, created_by)
      VALUES (
        p_tenant, trim(p_name), p_event,
        CASE WHEN p_event = 'deal_stage' THEN p_stage END,
        CASE WHEN timed THEN p_days END,
        CASE WHEN on_lead THEN nullif(trim(coalesce(p_source, '')), '') END,
        CASE WHEN NOT on_lead THEN p_min_value END,
        clean, auth.uid()
      )
      RETURNING id INTO the_rule;
  ELSE
    UPDATE crm.automations a SET
      name = trim(p_name),
      event = p_event,
      stage_id = CASE WHEN p_event = 'deal_stage' THEN p_stage END,
      days = CASE WHEN timed THEN p_days END,
      source = CASE WHEN on_lead THEN nullif(trim(coalesce(p_source, '')), '') END,
      min_value = CASE WHEN NOT on_lead THEN p_min_value END,
      actions = clean,
      updated_at = now()
    WHERE a.id = the_rule AND a.tenant_id = p_tenant;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Not found';
    END IF;
  END IF;
  RETURN the_rule;
END;
$$;

CREATE FUNCTION crm.set_automation_enabled(p_tenant UUID, p_rule UUID, p_enabled BOOLEAN)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  UPDATE crm.automations SET enabled = p_enabled, updated_at = now() WHERE id = p_rule AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
END;
$$;

-- Tasks a rule already made stay, because someone may be working on them
CREATE FUNCTION crm.delete_automation(p_tenant UUID, p_rule UUID)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  DELETE FROM crm.automations WHERE id = p_rule AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
END;
$$;

CREATE FUNCTION crm.save_task_reminders(p_tenant UUID, p_enabled BOOLEAN)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  UPDATE crm.lead_settings SET task_reminders = coalesce(p_enabled, true) WHERE tenant_id = p_tenant;
END;
$$;

-- Runs as the user, so policies apply
CREATE FUNCTION crm.automation_summary(p_tenant UUID)
RETURNS JSON
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT json_build_object(
    'task_reminders', (SELECT s.task_reminders FROM crm.lead_settings s WHERE s.tenant_id = p_tenant),
    'rules', (
      SELECT coalesce(json_agg(r ORDER BY r.created_at DESC), '[]'::json) FROM (
        SELECT a.*,
          (SELECT max(x.created_at) FROM crm.automation_runs x WHERE x.automation_id = a.id) AS last_run,
          (SELECT count(*) FROM crm.automation_runs x WHERE x.automation_id = a.id AND x.created_at >= now() - interval '30 days') AS runs_30,
          (SELECT count(*) FROM crm.automation_runs x WHERE x.automation_id = a.id AND x.created_at >= now() - interval '30 days' AND x.status <> 'done') AS failed_30
        FROM crm.automations a WHERE a.tenant_id = p_tenant
      ) r
    ),
    'runs', (
      SELECT coalesce(json_agg(r), '[]'::json) FROM (
        SELECT x.id, x.record_kind, x.record_name, x.link, x.status, x.error, x.created_at, a.name AS rule_name
        FROM crm.automation_runs x JOIN crm.automations a ON a.id = x.automation_id
        WHERE x.tenant_id = p_tenant
        ORDER BY x.created_at DESC LIMIT 50
      ) r
    )
  );
$$;

CREATE FUNCTION crm.my_notifications(p_tenant UUID)
RETURNS JSON
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT json_build_object(
    'unread', (SELECT count(*) FROM crm.notifications n WHERE n.tenant_id = p_tenant AND n.user_id = auth.uid() AND n.read_at IS NULL),
    'items', (
      SELECT coalesce(json_agg(r), '[]'::json) FROM (
        SELECT n.id, n.title, n.body, n.link, n.read_at, n.created_at
        FROM crm.notifications n
        WHERE n.tenant_id = p_tenant AND n.user_id = auth.uid()
        ORDER BY n.created_at DESC LIMIT 30
      ) r
    )
  );
$$;

-- Viewers get alerts too, so this only checks the alert is the caller's own. Null marks them all.
CREATE FUNCTION crm.mark_notifications_read(p_tenant UUID, p_ids UUID[])
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  UPDATE crm.notifications n SET read_at = now()
    WHERE n.tenant_id = p_tenant AND n.user_id = auth.uid() AND n.read_at IS NULL
      AND (p_ids IS NULL OR n.id = ANY(p_ids));
END;
$$;

CREATE OR REPLACE FUNCTION crm.overview(p_tenant UUID)
RETURNS JSON
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH open_deals AS (
    SELECT d.*, s.probability, s.name AS stage_name, s.position, s.pipeline_id,
      greatest(d.stage_changed_at, (
        SELECT max(greatest(a.done_at, CASE WHEN a.automation_id IS NULL THEN a.created_at END))
        FROM crm.activities a WHERE a.deal_id = d.id
      )) AS last_touch
    FROM crm.deals d JOIN crm.stages s ON s.id = d.stage_id
    WHERE d.tenant_id = p_tenant AND s.kind = 'open'
  ), closed AS (
    SELECT s.kind, d.value, d.closed_at
    FROM crm.deals d JOIN crm.stages s ON s.id = d.stage_id
    WHERE d.tenant_id = p_tenant AND s.kind <> 'open'
  ), tasks AS (
    SELECT a.id, a.subject, a.due_on, a.owner_id, a.deal_id, a.contact_id, a.company_id, a.lead_id,
      c.name AS contact_name, d.title AS deal_title, l.name AS lead_name
    FROM crm.activities a
    LEFT JOIN crm.contacts c ON c.id = a.contact_id
    LEFT JOIN crm.deals d ON d.id = a.deal_id
    LEFT JOIN crm.leads l ON l.id = a.lead_id
    WHERE a.tenant_id = p_tenant AND a.kind = 'task' AND a.done_at IS NULL
  )
  SELECT json_build_object(
    'open_count', (SELECT count(*) FROM open_deals),
    'open_value', (SELECT coalesce(sum(value), 0) FROM open_deals),
    'weighted_value', (SELECT coalesce(round(sum(value * probability / 100.0), 2), 0) FROM open_deals),
    'won_this_month', (SELECT coalesce(sum(value), 0) FROM closed WHERE kind = 'won' AND closed_at >= date_trunc('month', now())),
    'won_90', (SELECT count(*) FROM closed WHERE kind = 'won' AND closed_at >= now() - interval '90 days'),
    'lost_90', (SELECT count(*) FROM closed WHERE kind = 'lost' AND closed_at >= now() - interval '90 days'),
    'overdue_tasks', (SELECT count(*) FROM tasks WHERE due_on < current_date),
    'stages', (
      SELECT coalesce(json_agg(r ORDER BY r.position), '[]'::json) FROM (
        SELECT s.name, s.position, count(o.id) AS deals, coalesce(sum(o.value), 0) AS value
        FROM crm.stages s
        JOIN crm.pipelines p ON p.id = s.pipeline_id AND p.is_default
        LEFT JOIN open_deals o ON o.stage_id = s.id
        WHERE s.tenant_id = p_tenant AND s.kind = 'open'
        GROUP BY s.id
      ) r
    ),
    'forecast', (
      SELECT coalesce(json_agg(r ORDER BY r.month), '[]'::json) FROM (
        SELECT to_char(date_trunc('month', expected_close), 'YYYY-MM') AS month,
          count(*) AS deals, coalesce(sum(value), 0) AS value,
          coalesce(round(sum(value * probability / 100.0), 2), 0) AS weighted
        FROM open_deals
        WHERE expected_close >= date_trunc('month', current_date)
          AND expected_close < date_trunc('month', current_date) + interval '3 months'
        GROUP BY 1
      ) r
    ),
    'undated_deals', (SELECT count(*) FROM open_deals WHERE expected_close IS NULL),
    'late_deals', (SELECT count(*) FROM open_deals WHERE expected_close < current_date),
    'my_tasks', (
      SELECT coalesce(json_agg(t ORDER BY t.due_on NULLS LAST), '[]'::json) FROM (
        SELECT * FROM tasks WHERE owner_id = auth.uid() AND (due_on IS NULL OR due_on <= current_date)
        ORDER BY due_on NULLS LAST LIMIT 20
      ) t
    ),
    'stale_deals', (
      SELECT coalesce(json_agg(d ORDER BY d.last_touch), '[]'::json) FROM (
        SELECT id, title, value, stage_name, last_touch FROM open_deals
        WHERE last_touch < now() - interval '14 days'
        ORDER BY last_touch LIMIT 10
      ) d
    )
  );
$$;

REVOKE ALL ON FUNCTION
  crm.recipients(crm.automations, TEXT, UUID),
  crm.run_rule(crm.automations, TEXT, UUID, TEXT, UUID, JSONB, TEXT, TEXT, BOOLEAN),
  crm.lead_events(),
  crm.deal_events(),
  crm.due_records(crm.automations),
  crm.run_tenant(UUID),
  crm.run_scheduled(),
  crm.run_automations_now(UUID),
  crm.save_automation(UUID, UUID, TEXT, TEXT, UUID, INT, TEXT, NUMERIC, JSONB),
  crm.set_automation_enabled(UUID, UUID, BOOLEAN),
  crm.delete_automation(UUID, UUID),
  crm.save_task_reminders(UUID, BOOLEAN),
  crm.automation_summary(UUID),
  crm.my_notifications(UUID),
  crm.mark_notifications_read(UUID, UUID[])
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  crm.run_automations_now(UUID),
  crm.save_automation(UUID, UUID, TEXT, TEXT, UUID, INT, TEXT, NUMERIC, JSONB),
  crm.set_automation_enabled(UUID, UUID, BOOLEAN),
  crm.delete_automation(UUID, UUID),
  crm.save_task_reminders(UUID, BOOLEAN),
  crm.automation_summary(UUID),
  crm.my_notifications(UUID),
  crm.mark_notifications_read(UUID, UUID[])
  TO authenticated;

SELECT cron.schedule('crm-automations', '5 * * * *', 'SELECT crm.run_scheduled()');

NOTIFY pgrst, 'reload schema';
