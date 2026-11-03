-- CRM: tags on records, changing many records at once, planned calls and meetings with a next step,
-- per-stage "going stale" days, and a list of lost reasons to pick from.

-- Tags -----------------------------------------------------------------------

CREATE TABLE crm.tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 40),
  color TEXT NOT NULL DEFAULT 'grey' CHECK (color IN ('grey', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink')),
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_crm_tags_name ON crm.tags (tenant_id, lower(name));

ALTER TABLE crm.tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON crm.tags FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid())));
-- Anyone who can edit records can add or rename a tag; only owners and admins can delete one
CREATE POLICY tenant_inserts ON crm.tags FOR INSERT TO authenticated
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid()) AND role <> 'viewer'));
CREATE POLICY tenant_updates ON crm.tags FOR UPDATE TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid()) AND role <> 'viewer'))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid()) AND role <> 'viewer'));
CREATE POLICY manager_deletes ON crm.tags FOR DELETE TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid()) AND role IN ('owner', 'admin')));
GRANT SELECT, INSERT, UPDATE, DELETE ON crm.tags TO authenticated;

ALTER TABLE crm.contacts ADD COLUMN tags UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE crm.companies ADD COLUMN tags UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE crm.leads ADD COLUMN tags UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE crm.deals ADD COLUMN tags UUID[] NOT NULL DEFAULT '{}';

-- Only this company's tags, each once, at most 20
CREATE FUNCTION crm.check_tags()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  NEW.tags := ARRAY(SELECT DISTINCT t FROM unnest(coalesce(NEW.tags, '{}'::uuid[])) t WHERE t IS NOT NULL);
  IF cardinality(NEW.tags) > 20 THEN
    RAISE EXCEPTION 'A record can have up to 20 tags';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(NEW.tags) t
    WHERE NOT EXISTS (SELECT 1 FROM crm.tags g WHERE g.id = t AND g.tenant_id = NEW.tenant_id)
  ) THEN
    RAISE EXCEPTION 'Tag not found';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER a_check_tags BEFORE INSERT OR UPDATE OF tags ON crm.contacts FOR EACH ROW EXECUTE FUNCTION crm.check_tags();
CREATE TRIGGER a_check_tags BEFORE INSERT OR UPDATE OF tags ON crm.companies FOR EACH ROW EXECUTE FUNCTION crm.check_tags();
CREATE TRIGGER a_check_tags BEFORE INSERT OR UPDATE OF tags ON crm.leads FOR EACH ROW EXECUTE FUNCTION crm.check_tags();
CREATE TRIGGER a_check_tags BEFORE INSERT OR UPDATE OF tags ON crm.deals FOR EACH ROW EXECUTE FUNCTION crm.check_tags();

-- A deleted tag comes off every record
CREATE FUNCTION crm.drop_tag()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  UPDATE crm.contacts SET tags = array_remove(tags, OLD.id) WHERE tenant_id = OLD.tenant_id AND OLD.id = ANY(tags);
  UPDATE crm.companies SET tags = array_remove(tags, OLD.id) WHERE tenant_id = OLD.tenant_id AND OLD.id = ANY(tags);
  UPDATE crm.leads SET tags = array_remove(tags, OLD.id) WHERE tenant_id = OLD.tenant_id AND OLD.id = ANY(tags);
  UPDATE crm.deals SET tags = array_remove(tags, OLD.id) WHERE tenant_id = OLD.tenant_id AND OLD.id = ANY(tags);
  RETURN NULL;
END;
$$;
CREATE TRIGGER drop_tag AFTER DELETE ON crm.tags FOR EACH ROW EXECUTE FUNCTION crm.drop_tag();

REVOKE EXECUTE ON FUNCTION crm.check_tags(), crm.drop_tag() FROM PUBLIC, anon, authenticated;

-- Lost reasons ---------------------------------------------------------------

CREATE TABLE crm.lost_reasons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_crm_lost_reasons_name ON crm.lost_reasons (tenant_id, lower(name));

ALTER TABLE crm.lost_reasons ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON crm.lost_reasons FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid())));
CREATE POLICY manager_writes ON crm.lost_reasons FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid()) AND role IN ('owner', 'admin')))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid()) AND role IN ('owner', 'admin')));
GRANT SELECT, INSERT, UPDATE, DELETE ON crm.lost_reasons TO authenticated;

-- Stages go stale after a number of days --------------------------------------

ALTER TABLE crm.stages ADD COLUMN rot_days INT CHECK (rot_days IS NULL OR rot_days BETWEEN 1 AND 365);

-- Same as before, and also saves each stage's stale days (blank means 14)
CREATE OR REPLACE FUNCTION crm.save_pipeline(p_tenant uuid, p_pipeline uuid, p_name text, p_stages jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  the_pipeline UUID := p_pipeline;
  item JSONB;
  place INT := 0;
  kept UUID[] := '{}';
  saved_stage UUID;
  gone TEXT;
  stale_days INT;
BEGIN
  PERFORM accounting.require_manager(p_tenant);

  IF length(trim(coalesce(p_name, ''))) = 0 THEN
    RAISE EXCEPTION 'Enter a pipeline name';
  END IF;
  IF jsonb_typeof(p_stages) <> 'array' THEN
    RAISE EXCEPTION 'Add the stages';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_stages) s WHERE s->>'kind' = 'won') <> 1
     OR (SELECT count(*) FROM jsonb_array_elements(p_stages) s WHERE s->>'kind' = 'lost') <> 1
     OR (SELECT count(*) FROM jsonb_array_elements(p_stages) s WHERE s->>'kind' = 'open') < 1 THEN
    RAISE EXCEPTION 'A pipeline needs at least one open stage, one won stage and one lost stage';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stages) s WHERE length(trim(coalesce(s->>'name', ''))) = 0) THEN
    RAISE EXCEPTION 'Every stage needs a name';
  END IF;
  IF (SELECT count(DISTINCT lower(trim(s->>'name'))) FROM jsonb_array_elements(p_stages) s) <> jsonb_array_length(p_stages) THEN
    RAISE EXCEPTION 'Stage names must be different';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_stages) s
    WHERE nullif(s->>'rot_days', '') IS NOT NULL
      AND (s->>'rot_days' !~ '^\d{1,3}$' OR (s->>'rot_days')::int NOT BETWEEN 1 AND 365)
  ) THEN
    RAISE EXCEPTION 'Days before a deal goes stale must be between 1 and 365';
  END IF;

  IF the_pipeline IS NULL THEN
    INSERT INTO crm.pipelines (tenant_id, name) VALUES (p_tenant, trim(p_name)) RETURNING id INTO the_pipeline;
  ELSE
    UPDATE crm.pipelines SET name = trim(p_name) WHERE id = the_pipeline AND tenant_id = p_tenant;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Not found';
    END IF;
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_stages) LOOP
    place := place + 1;
    saved_stage := nullif(item->>'id', '')::uuid;
    stale_days := CASE WHEN item->>'kind' = 'open' THEN nullif(item->>'rot_days', '')::int END;
    IF saved_stage IS NOT NULL THEN
      UPDATE crm.stages s
        SET name = trim(item->>'name'), position = place, probability = (item->>'probability')::int, kind = item->>'kind',
          rot_days = stale_days
        WHERE s.id = saved_stage AND s.pipeline_id = the_pipeline;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Not found';
      END IF;
    ELSE
      INSERT INTO crm.stages (tenant_id, pipeline_id, name, position, probability, kind, rot_days)
        VALUES (p_tenant, the_pipeline, trim(item->>'name'), place, (item->>'probability')::int, item->>'kind', stale_days)
        RETURNING id INTO saved_stage;
    END IF;
    kept := kept || saved_stage;
  END LOOP;

  SELECT s.name INTO gone
    FROM crm.stages s
    WHERE s.pipeline_id = the_pipeline AND NOT s.id = ANY(kept)
      AND EXISTS (SELECT 1 FROM crm.deals d WHERE d.stage_id = s.id)
    LIMIT 1;
  IF gone IS NOT NULL THEN
    RAISE EXCEPTION 'Move the deals out of % first', gone;
  END IF;

  DELETE FROM crm.stages s WHERE s.pipeline_id = the_pipeline AND NOT s.id = ANY(kept);
  RETURN the_pipeline;
END;
$function$;

-- Planned activities ----------------------------------------------------------

ALTER TABLE crm.activities ADD COLUMN due_time TIME;

-- Same as before, except a call, meeting or email with a date is planned rather than already done
CREATE OR REPLACE FUNCTION crm.prepare_activity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  deal crm.deals;
BEGIN
  IF NEW.deal_id IS NOT NULL THEN
    SELECT * INTO deal FROM crm.deals WHERE id = NEW.deal_id;
    NEW.contact_id := coalesce(NEW.contact_id, deal.contact_id);
    NEW.company_id := coalesce(NEW.company_id, deal.company_id);
  END IF;
  IF NEW.company_id IS NULL AND NEW.contact_id IS NOT NULL THEN
    SELECT company_id INTO NEW.company_id FROM crm.contacts WHERE id = NEW.contact_id;
  END IF;
  IF NEW.due_on IS NULL OR NEW.kind = 'note' THEN
    NEW.due_time := NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_by := auth.uid();
    NEW.owner_id := coalesce(NEW.owner_id, auth.uid());
    IF NEW.kind = 'note' OR (NEW.kind <> 'task' AND NEW.due_on IS NULL) THEN
      NEW.done_at := coalesce(NEW.done_at, now());
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

-- Marks an activity done, adds what happened, and can plan the next one on the same record
CREATE FUNCTION crm.finish_activity(p_tenant UUID, p_activity UUID, p_feedback TEXT, p_next JSONB)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  item crm.activities;
  next_id UUID;
  next_kind TEXT;
  next_subject TEXT;
  next_due DATE;
  next_time TIME;
BEGIN
  PERFORM accounting.require_member(p_tenant);

  SELECT * INTO item FROM crm.activities WHERE id = p_activity AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Activity not found';
  END IF;
  IF item.done_at IS NOT NULL THEN
    RAISE EXCEPTION 'This is already done';
  END IF;
  IF length(coalesce(p_feedback, '')) > 4000 THEN
    RAISE EXCEPTION 'Keep the notes under 4000 characters';
  END IF;

  IF p_next IS NOT NULL AND jsonb_typeof(p_next) = 'object' THEN
    next_kind := p_next->>'kind';
    next_subject := trim(coalesce(p_next->>'subject', ''));
    IF next_kind IS NULL OR next_kind NOT IN ('call', 'meeting', 'email', 'task') THEN
      RAISE EXCEPTION 'Choose what the next step is';
    END IF;
    IF next_subject = '' THEN
      RAISE EXCEPTION 'Say what the next step is';
    END IF;
    IF coalesce(p_next->>'due_on', '') !~ '^\d{4}-\d{2}-\d{2}$' THEN
      RAISE EXCEPTION 'Choose a date for the next step';
    END IF;
    next_due := (p_next->>'due_on')::date;
    IF coalesce(p_next->>'due_time', '') <> '' THEN
      IF p_next->>'due_time' !~ '^\d{2}:\d{2}(:\d{2})?$' THEN
        RAISE EXCEPTION 'Enter a valid time';
      END IF;
      next_time := (p_next->>'due_time')::time;
    END IF;
  END IF;

  UPDATE crm.activities
    SET done_at = now(),
      body = CASE WHEN length(trim(coalesce(p_feedback, ''))) = 0 THEN body
        WHEN body IS NULL OR body = '' THEN trim(p_feedback)
        ELSE body || E'\n\n' || trim(p_feedback) END
    WHERE id = item.id;

  IF next_kind IS NOT NULL THEN
    INSERT INTO crm.activities (tenant_id, kind, subject, due_on, due_time, contact_id, company_id, deal_id, lead_id, owner_id)
      VALUES (p_tenant, next_kind, left(next_subject, 200), next_due, next_time, item.contact_id, item.company_id, item.deal_id, item.lead_id,
        coalesce(nullif(p_next->>'owner_id', '')::uuid, item.owner_id, auth.uid()))
      RETURNING id INTO next_id;
  END IF;

  RETURN json_build_object('done', item.id, 'next', next_id);
END;
$$;
REVOKE EXECUTE ON FUNCTION crm.finish_activity(UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION crm.finish_activity(UUID, UUID, TEXT, JSONB) TO authenticated;

-- For each open deal: when it was last touched, whether it has gone stale, and its next planned activity.
-- Runs as the caller, so the usual row rules apply.
CREATE FUNCTION crm.deal_signals(p_tenant UUID)
RETURNS json
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH open_deals AS (
    SELECT d.id, coalesce(s.rot_days, 14) AS rot_days,
      greatest(d.stage_changed_at, (
        SELECT max(greatest(a.done_at, CASE WHEN a.automation_id IS NULL THEN a.created_at END))
        FROM crm.activities a WHERE a.deal_id = d.id
      )) AS last_touch
    FROM crm.deals d JOIN crm.stages s ON s.id = d.stage_id
    WHERE d.tenant_id = p_tenant AND s.kind = 'open'
  )
  SELECT coalesce(json_object_agg(o.id, json_build_object(
    'last_touch', o.last_touch,
    'idle_days', (current_date - o.last_touch::date),
    'rot_days', o.rot_days,
    'stale', o.last_touch < now() - make_interval(days => o.rot_days),
    'next', (
      SELECT json_build_object('id', a.id, 'kind', a.kind, 'subject', a.subject, 'due_on', a.due_on, 'due_time', a.due_time, 'owner_id', a.owner_id)
      FROM crm.activities a
      WHERE a.deal_id = o.id AND a.done_at IS NULL
      ORDER BY a.due_on NULLS LAST, a.due_time NULLS LAST, a.created_at
      LIMIT 1
    )
  )), '{}'::json)
  FROM open_deals o;
$$;
REVOKE EXECUTE ON FUNCTION crm.deal_signals(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION crm.deal_signals(UUID) TO authenticated;

-- Same as before; open calls and meetings now count with tasks, stale uses each stage's days, and tasks carry their type
CREATE OR REPLACE FUNCTION crm.overview(p_tenant uuid)
 RETURNS json
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  WITH open_deals AS (
    SELECT d.*, s.probability, s.name AS stage_name, s.position, s.pipeline_id, coalesce(s.rot_days, 14) AS rot_days,
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
    SELECT a.id, a.kind, a.subject, a.due_on, a.due_time, a.owner_id, a.deal_id, a.contact_id, a.company_id, a.lead_id,
      c.name AS contact_name, d.title AS deal_title, l.name AS lead_name
    FROM crm.activities a
    LEFT JOIN crm.contacts c ON c.id = a.contact_id
    LEFT JOIN crm.deals d ON d.id = a.deal_id
    LEFT JOIN crm.leads l ON l.id = a.lead_id
    WHERE a.tenant_id = p_tenant AND a.kind <> 'note' AND a.done_at IS NULL
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
      SELECT coalesce(json_agg(t ORDER BY t.due_on NULLS LAST, t.due_time NULLS LAST), '[]'::json) FROM (
        SELECT * FROM tasks WHERE owner_id = auth.uid() AND (due_on IS NULL OR due_on <= current_date)
        ORDER BY due_on NULLS LAST, due_time NULLS LAST LIMIT 20
      ) t
    ),
    'stale_deals', (
      SELECT coalesce(json_agg(d ORDER BY d.last_touch), '[]'::json) FROM (
        SELECT id, title, value, stage_name, last_touch FROM open_deals
        WHERE last_touch < now() - make_interval(days => rot_days)
        ORDER BY last_touch LIMIT 10
      ) d
    )
  );
$function$;

-- Same as before; the daily reminder also counts planned calls, meetings and emails
CREATE OR REPLACE FUNCTION crm.run_tenant(p_tenant uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    WHERE a.tenant_id = p_tenant AND a.kind <> 'note' AND a.done_at IS NULL AND a.due_on <= current_date
    GROUP BY a.owner_id
    ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;

  RETURN handled;
END;
$function$;

-- Changing many records at once -----------------------------------------------

CREATE FUNCTION crm.bulk_update(p_tenant UUID, p_entity TEXT, p_ids UUID[], p_action TEXT, p_value TEXT, p_reason TEXT)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  target TEXT;
  changed INT := 0;
  the_value UUID;
  stage_kind TEXT;
BEGIN
  PERFORM accounting.require_member(p_tenant);

  target := CASE p_entity WHEN 'contact' THEN 'contacts' WHEN 'company' THEN 'companies' WHEN 'lead' THEN 'leads' WHEN 'deal' THEN 'deals' END;
  IF target IS NULL THEN
    RAISE EXCEPTION 'Choose what to change';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RAISE EXCEPTION 'Select at least one row';
  END IF;
  IF cardinality(p_ids) > 500 THEN
    RAISE EXCEPTION 'Select up to 500 rows at a time';
  END IF;
  IF p_value IS NOT NULL AND p_value <> '' AND p_action IN ('owner', 'add_tag', 'remove_tag', 'stage') THEN
    IF p_value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Not found';
    END IF;
    the_value := p_value::uuid;
  END IF;

  IF p_action = 'owner' THEN
    -- The record's own check makes sure the person is on the team
    EXECUTE format('UPDATE crm.%I SET owner_id = $1, updated_at = now() WHERE tenant_id = $2 AND id = ANY($3) AND owner_id IS DISTINCT FROM $1', target)
      USING the_value, p_tenant, p_ids;
    GET DIAGNOSTICS changed = ROW_COUNT;

  ELSIF p_action IN ('add_tag', 'remove_tag') THEN
    IF the_value IS NULL OR NOT EXISTS (SELECT 1 FROM crm.tags WHERE id = the_value AND tenant_id = p_tenant) THEN
      RAISE EXCEPTION 'Tag not found';
    END IF;
    IF p_action = 'add_tag' THEN
      EXECUTE format('UPDATE crm.%I SET tags = tags || $1, updated_at = now() WHERE tenant_id = $2 AND id = ANY($3) AND NOT ($1 = ANY(tags))', target)
        USING the_value, p_tenant, p_ids;
    ELSE
      EXECUTE format('UPDATE crm.%I SET tags = array_remove(tags, $1), updated_at = now() WHERE tenant_id = $2 AND id = ANY($3) AND $1 = ANY(tags)', target)
        USING the_value, p_tenant, p_ids;
    END IF;
    GET DIAGNOSTICS changed = ROW_COUNT;

  ELSIF p_action = 'stage' THEN
    IF p_entity <> 'deal' THEN
      RAISE EXCEPTION 'Only deals have stages';
    END IF;
    SELECT kind INTO stage_kind FROM crm.stages WHERE id = the_value AND tenant_id = p_tenant;
    IF stage_kind IS NULL THEN
      RAISE EXCEPTION 'Stage not found';
    END IF;
    IF stage_kind = 'lost' AND length(trim(coalesce(p_reason, ''))) = 0 THEN
      RAISE EXCEPTION 'Say why these deals were lost';
    END IF;
    UPDATE crm.deals
      SET stage_id = the_value,
        lost_reason = CASE WHEN stage_kind = 'lost' THEN left(trim(p_reason), 200) ELSE lost_reason END
      WHERE tenant_id = p_tenant AND id = ANY(p_ids) AND stage_id IS DISTINCT FROM the_value;
    GET DIAGNOSTICS changed = ROW_COUNT;

  ELSIF p_action = 'status' THEN
    IF p_entity <> 'lead' THEN
      RAISE EXCEPTION 'Only leads have a status';
    END IF;
    IF p_value IS NULL OR p_value NOT IN ('new', 'working', 'disqualified') THEN
      RAISE EXCEPTION 'Choose a status';
    END IF;
    IF p_value = 'disqualified' AND length(trim(coalesce(p_reason, ''))) = 0 THEN
      RAISE EXCEPTION 'Say why these leads are disqualified';
    END IF;
    -- Converted leads stay as they are
    UPDATE crm.leads
      SET status = p_value,
        disqualified_reason = CASE WHEN p_value = 'disqualified' THEN left(trim(p_reason), 200) END
      WHERE tenant_id = p_tenant AND id = ANY(p_ids) AND status <> 'converted' AND status IS DISTINCT FROM p_value;
    GET DIAGNOSTICS changed = ROW_COUNT;

  ELSIF p_action = 'delete' THEN
    EXECUTE format('DELETE FROM crm.%I WHERE tenant_id = $1 AND id = ANY($2)', target) USING p_tenant, p_ids;
    GET DIAGNOSTICS changed = ROW_COUNT;

  ELSE
    RAISE EXCEPTION 'Choose what to change';
  END IF;

  RETURN json_build_object('changed', changed, 'selected', cardinality(p_ids));
END;
$$;
REVOKE EXECUTE ON FUNCTION crm.bulk_update(UUID, TEXT, UUID[], TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION crm.bulk_update(UUID, TEXT, UUID[], TEXT, TEXT, TEXT) TO authenticated;
