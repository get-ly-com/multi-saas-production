-- Leads: capture from a public form or CSV, rule-based scoring, automatic assignment, conversion
-- to a contact, company and deal. Also duplicates and merging, custom fields and saved views.

CREATE TABLE crm.custom_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  entity TEXT NOT NULL CHECK (entity IN ('lead', 'contact', 'company', 'deal')),
  slug TEXT NOT NULL,
  label TEXT NOT NULL CHECK (length(trim(label)) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('text', 'number', 'date', 'select', 'checkbox')),
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  required BOOLEAN NOT NULL DEFAULT false,
  position INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity, slug)
);

ALTER TABLE crm.contacts ADD COLUMN custom JSONB NOT NULL DEFAULT '{}'::jsonb, ADD COLUMN source TEXT;
ALTER TABLE crm.companies ADD COLUMN custom JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE crm.deals ADD COLUMN custom JSONB NOT NULL DEFAULT '{}'::jsonb, ADD COLUMN source TEXT;

CREATE TABLE crm.leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  email TEXT,
  phone TEXT,
  company_name TEXT,
  job_title TEXT,
  source TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'working', 'disqualified', 'converted')),
  disqualified_reason TEXT,
  score INT NOT NULL DEFAULT 0,
  score_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  owner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  custom JSONB NOT NULL DEFAULT '{}'::jsonb,
  from_form BOOLEAN NOT NULL DEFAULT false,
  converted_contact_id UUID REFERENCES crm.contacts(id) ON DELETE SET NULL,
  converted_company_id UUID REFERENCES crm.companies(id) ON DELETE SET NULL,
  converted_deal_id UUID REFERENCES crm.deals(id) ON DELETE SET NULL,
  converted_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_leads_status ON crm.leads (tenant_id, status);
CREATE INDEX idx_crm_leads_email ON crm.leads (tenant_id, lower(email));
CREATE INDEX idx_crm_leads_owner ON crm.leads (owner_id);
CREATE INDEX idx_crm_leads_form ON crm.leads (tenant_id, created_at) WHERE from_form;
CREATE INDEX idx_crm_leads_contact ON crm.leads (converted_contact_id);
CREATE INDEX idx_crm_leads_company ON crm.leads (converted_company_id);
CREATE INDEX idx_crm_leads_deal ON crm.leads (converted_deal_id);

ALTER TABLE crm.activities ADD COLUMN lead_id UUID REFERENCES crm.leads(id) ON DELETE SET NULL;
CREATE INDEX idx_crm_activities_lead ON crm.activities (lead_id);

CREATE TABLE crm.lead_settings (
  tenant_id UUID PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  assign_mode TEXT NOT NULL DEFAULT 'creator' CHECK (assign_mode IN ('creator', 'round_robin')),
  assignees UUID[] NOT NULL DEFAULT '{}',
  next_turn INT NOT NULL DEFAULT 0,
  form_key TEXT NOT NULL UNIQUE,
  form_enabled BOOLEAN NOT NULL DEFAULT false,
  form_source TEXT NOT NULL DEFAULT 'Web form',
  form_thanks TEXT NOT NULL DEFAULT 'Thank you. We will be in touch soon.'
);

CREATE TABLE crm.score_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'phone', 'company', 'title_contains', 'source_is', 'activity')),
  match TEXT,
  points INT NOT NULL CHECK (points BETWEEN -100 AND 100)
);
CREATE INDEX idx_crm_score_rules_tenant ON crm.score_rules (tenant_id);

CREATE TABLE crm.saved_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  entity TEXT NOT NULL CHECK (entity IN ('lead', 'contact', 'company')),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  shared BOOLEAN NOT NULL DEFAULT false,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_crm_saved_views_name ON crm.saved_views (tenant_id, user_id, entity, lower(name));
CREATE INDEX idx_crm_saved_views_user ON crm.saved_views (user_id);

ALTER TABLE crm.custom_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.lead_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.score_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.saved_views ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_rows ON crm.leads FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid())));
CREATE POLICY tenant_writes ON crm.leads FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid()) AND role <> 'viewer'))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid()) AND role <> 'viewer'));
CREATE POLICY tenant_rows ON crm.custom_fields FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid())));
CREATE POLICY tenant_rows ON crm.lead_settings FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid())));
CREATE POLICY tenant_rows ON crm.score_rules FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid())));

-- A saved view belongs to the person who made it. Shared views can be used by the whole company.
CREATE POLICY tenant_rows ON crm.saved_views FOR SELECT TO authenticated
  USING ((shared OR user_id = (SELECT auth.uid()))
    AND tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid())));
CREATE POLICY own_writes ON crm.saved_views FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())
    AND tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid()) AND role <> 'viewer'))
  WITH CHECK (user_id = (SELECT auth.uid())
    AND tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid()) AND role <> 'viewer'));

GRANT SELECT, INSERT, UPDATE, DELETE ON crm.leads, crm.saved_views TO authenticated;
GRANT SELECT ON crm.custom_fields, crm.lead_settings, crm.score_rules TO authenticated;

-- Every company starts with a private form address and a simple set of scoring rules
CREATE FUNCTION crm.seed_leads(p_tenant UUID)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM crm.lead_settings WHERE tenant_id = p_tenant) THEN
    RETURN;
  END IF;
  INSERT INTO crm.lead_settings (tenant_id, form_key) VALUES (p_tenant, replace(gen_random_uuid()::text, '-', ''));
  INSERT INTO crm.score_rules (tenant_id, kind, match, points) VALUES
    (p_tenant, 'email', NULL, 10),
    (p_tenant, 'phone', NULL, 10),
    (p_tenant, 'company', NULL, 15),
    (p_tenant, 'title_contains', 'director', 15),
    (p_tenant, 'title_contains', 'owner', 15),
    (p_tenant, 'source_is', 'Referral', 25),
    (p_tenant, 'activity', NULL, 5);
END;
$$;

CREATE FUNCTION crm.seed_leads_for_new_tenant()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM crm.seed_leads(NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER seed_leads AFTER INSERT ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION crm.seed_leads_for_new_tenant();

SELECT crm.seed_leads(id) FROM public.tenants;

CREATE OR REPLACE FUNCTION crm.check_links()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  item JSONB := to_jsonb(NEW);
  earlier JSONB := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  link UUID;
BEGIN
  link := (item->>'company_id')::uuid;
  IF link IS NOT NULL AND NOT EXISTS (SELECT 1 FROM crm.companies WHERE id = link AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'Company not found';
  END IF;
  link := (item->>'contact_id')::uuid;
  IF link IS NOT NULL AND NOT EXISTS (SELECT 1 FROM crm.contacts WHERE id = link AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'Contact not found';
  END IF;
  link := (item->>'deal_id')::uuid;
  IF link IS NOT NULL AND NOT EXISTS (SELECT 1 FROM crm.deals WHERE id = link AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'Deal not found';
  END IF;
  link := (item->>'lead_id')::uuid;
  IF link IS NOT NULL AND NOT EXISTS (SELECT 1 FROM crm.leads WHERE id = link AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'Lead not found';
  END IF;
  link := (item->>'stage_id')::uuid;
  IF link IS NOT NULL AND NOT EXISTS (SELECT 1 FROM crm.stages WHERE id = link AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'Stage not found';
  END IF;

  -- Someone who has left can stay on old records, but can't be newly assigned
  link := (item->>'owner_id')::uuid;
  IF link IS NOT NULL AND link IS DISTINCT FROM (earlier->>'owner_id')::uuid AND NOT EXISTS (
    SELECT 1 FROM public.tenant_members WHERE tenant_id = NEW.tenant_id AND user_id = link
  ) THEN
    RAISE EXCEPTION 'That person is not on the team';
  END IF;
  RETURN NEW;
END;
$$;

-- Imports, the web form and conversion can't ask anyone to fill in a required field, so they
-- set crm.trusted for their transaction. Only database functions can set it.
CREATE FUNCTION crm.trusted()
RETURNS boolean
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT coalesce(current_setting('crm.trusted', true), '') = 'on';
$$;

-- Unknown keys are dropped. A value that hasn't changed stays, even if its option was removed later.
CREATE FUNCTION crm.check_custom()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  entity_name TEXT := TG_ARGV[0];
  lenient BOOLEAN := crm.trusted();
  field crm.custom_fields;
  entered TEXT;
  stored JSONB;
  clean JSONB := '{}'::jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.custom IS NOT DISTINCT FROM OLD.custom THEN
    RETURN NEW;
  END IF;
  IF jsonb_typeof(NEW.custom) <> 'object' THEN
    RAISE EXCEPTION 'Custom fields are not valid';
  END IF;

  FOR field IN SELECT * FROM crm.custom_fields f WHERE f.tenant_id = NEW.tenant_id AND f.entity = entity_name LOOP
    entered := nullif(trim(coalesce(NEW.custom->>field.slug, '')), '');
    stored := NULL;

    IF entered IS NULL THEN
      IF field.required AND NOT lenient THEN
        RAISE EXCEPTION '% is required', field.label;
      END IF;
      CONTINUE;
    END IF;

    IF TG_OP = 'UPDATE' AND (OLD.custom->field.slug) IS NOT DISTINCT FROM (NEW.custom->field.slug) THEN
      clean := clean || jsonb_build_object(field.slug, NEW.custom->field.slug);
      CONTINUE;
    END IF;

    IF field.kind = 'text' AND length(entered) <= 2000 THEN
      stored := to_jsonb(entered);
    ELSIF field.kind = 'number' AND entered ~ '^-?[0-9]{1,15}(\.[0-9]{1,6})?$' THEN
      stored := to_jsonb(entered::numeric);
    ELSIF field.kind = 'date' AND entered ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      BEGIN
        stored := to_jsonb(entered::date::text);
      EXCEPTION WHEN others THEN
        stored := NULL;
      END;
    ELSIF field.kind = 'select' AND field.options ? entered THEN
      stored := to_jsonb(entered);
    ELSIF field.kind = 'checkbox' AND entered IN ('true', 'false') THEN
      stored := to_jsonb(entered::boolean);
    END IF;

    IF stored IS NOT NULL THEN
      clean := clean || jsonb_build_object(field.slug, stored);
    ELSIF NOT lenient THEN
      RAISE EXCEPTION 'Enter a valid value for %', field.label;
    END IF;
  END LOOP;

  NEW.custom := clean;
  RETURN NEW;
END;
$$;

CREATE TRIGGER c_check_custom BEFORE INSERT OR UPDATE ON crm.contacts FOR EACH ROW EXECUTE FUNCTION crm.check_custom('contact');
CREATE TRIGGER c_check_custom BEFORE INSERT OR UPDATE ON crm.companies FOR EACH ROW EXECUTE FUNCTION crm.check_custom('company');
CREATE TRIGGER c_check_custom BEFORE INSERT OR UPDATE ON crm.deals FOR EACH ROW EXECUTE FUNCTION crm.check_custom('deal');

-- Round robin skips viewers and people who have left, so a lead never lands with nobody to work it
CREATE FUNCTION crm.next_owner(p_tenant UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  setting crm.lead_settings;
  team UUID[];
BEGIN
  SELECT * INTO setting FROM crm.lead_settings WHERE tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND OR setting.assign_mode <> 'round_robin' THEN
    RETURN NULL;
  END IF;

  SELECT array_agg(m.user_id ORDER BY array_position(setting.assignees, m.user_id)) INTO team
    FROM public.tenant_members m
    WHERE m.tenant_id = p_tenant AND m.role <> 'viewer' AND m.user_id = ANY(setting.assignees);
  IF team IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE crm.lead_settings SET next_turn = (setting.next_turn + 1) % array_length(team, 1) WHERE tenant_id = p_tenant;
  RETURN team[(setting.next_turn % array_length(team, 1)) + 1];
END;
$$;

CREATE FUNCTION crm.prepare_lead()
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
    SELECT count(*) INTO touches FROM crm.activities a WHERE a.lead_id = NEW.id;
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

CREATE TRIGGER a_check_links BEFORE INSERT OR UPDATE ON crm.leads FOR EACH ROW EXECUTE FUNCTION crm.check_links();
CREATE TRIGGER b_prepare_lead BEFORE INSERT OR UPDATE ON crm.leads FOR EACH ROW EXECUTE FUNCTION crm.prepare_lead();
CREATE TRIGGER c_check_custom BEFORE INSERT OR UPDATE ON crm.leads FOR EACH ROW EXECUTE FUNCTION crm.check_custom('lead');

-- Logging something on a lead changes its score
CREATE FUNCTION crm.rescore_lead()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF TG_OP <> 'DELETE' AND NEW.lead_id IS NOT NULL THEN
    UPDATE crm.leads SET status = status WHERE id = NEW.lead_id;
  END IF;
  IF TG_OP <> 'INSERT' AND OLD.lead_id IS NOT NULL AND OLD.lead_id IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN NEW.lead_id END) THEN
    UPDATE crm.leads SET status = status WHERE id = OLD.lead_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER rescore_lead AFTER INSERT OR DELETE OR UPDATE OF lead_id ON crm.activities
  FOR EACH ROW EXECUTE FUNCTION crm.rescore_lead();

CREATE FUNCTION crm.save_lead_settings(p_tenant UUID, p_settings JSONB)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  chosen UUID[];
  item JSONB;
BEGIN
  PERFORM accounting.require_manager(p_tenant);

  SELECT coalesce(array_agg(value::uuid), '{}') INTO chosen FROM jsonb_array_elements_text(coalesce(p_settings->'assignees', '[]'::jsonb));
  IF p_settings->>'assign_mode' NOT IN ('creator', 'round_robin') THEN
    RAISE EXCEPTION 'Choose how leads are assigned';
  END IF;
  IF p_settings->>'assign_mode' = 'round_robin' AND cardinality(chosen) = 0 THEN
    RAISE EXCEPTION 'Choose who takes turns';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(chosen) person
    WHERE NOT EXISTS (SELECT 1 FROM public.tenant_members m WHERE m.tenant_id = p_tenant AND m.user_id = person AND m.role <> 'viewer')
  ) THEN
    RAISE EXCEPTION 'That person is not on the team';
  END IF;
  IF length(trim(coalesce(p_settings->>'form_source', ''))) = 0 OR length(p_settings->>'form_source') > 100 THEN
    RAISE EXCEPTION 'Enter the source for form leads';
  END IF;
  IF length(trim(coalesce(p_settings->>'form_thanks', ''))) = 0 OR length(p_settings->>'form_thanks') > 500 THEN
    RAISE EXCEPTION 'Enter the thank you message';
  END IF;
  IF coalesce(jsonb_typeof(p_settings->'rules'), '') <> 'array' OR jsonb_array_length(p_settings->'rules') > 50 THEN
    RAISE EXCEPTION 'Scoring rules are not valid';
  END IF;

  UPDATE crm.lead_settings
    SET assign_mode = p_settings->>'assign_mode',
      assignees = chosen,
      form_enabled = coalesce((p_settings->>'form_enabled')::boolean, false),
      form_source = trim(p_settings->>'form_source'),
      form_thanks = trim(p_settings->>'form_thanks')
    WHERE tenant_id = p_tenant;

  DELETE FROM crm.score_rules WHERE tenant_id = p_tenant;
  FOR item IN SELECT value FROM jsonb_array_elements(p_settings->'rules') LOOP
    IF item->>'kind' IN ('title_contains', 'source_is') AND length(trim(coalesce(item->>'match', ''))) = 0 THEN
      RAISE EXCEPTION 'Every text rule needs words to match';
    END IF;
    INSERT INTO crm.score_rules (tenant_id, kind, match, points)
      VALUES (p_tenant, item->>'kind', CASE WHEN item->>'kind' IN ('title_contains', 'source_is') THEN trim(item->>'match') END, (item->>'points')::int);
  END LOOP;

  UPDATE crm.leads SET status = status WHERE tenant_id = p_tenant AND status IN ('new', 'working');
END;
$$;

CREATE FUNCTION crm.new_form_key(p_tenant UUID)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  fresh TEXT := replace(gen_random_uuid()::text, '-', '');
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  UPDATE crm.lead_settings SET form_key = fresh WHERE tenant_id = p_tenant;
  RETURN fresh;
END;
$$;

CREATE FUNCTION crm.save_custom_field(p_tenant UUID, p_field UUID, p_entity TEXT, p_label TEXT, p_kind TEXT, p_options JSONB, p_required BOOLEAN)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  base TEXT;
  candidate TEXT;
  attempt INT := 1;
  saved UUID;
  choices JSONB;
BEGIN
  PERFORM accounting.require_manager(p_tenant);

  IF length(trim(coalesce(p_label, ''))) = 0 OR length(p_label) > 80 THEN
    RAISE EXCEPTION 'Enter a field name';
  END IF;
  IF p_kind = 'select' THEN
    SELECT coalesce(jsonb_agg(DISTINCT trim(value)), '[]'::jsonb) INTO choices
      FROM jsonb_array_elements_text(coalesce(p_options, '[]'::jsonb)) WHERE length(trim(value)) > 0;
    IF jsonb_array_length(choices) = 0 THEN
      RAISE EXCEPTION 'Add at least one choice';
    END IF;
  ELSE
    choices := '[]'::jsonb;
  END IF;

  IF p_field IS NOT NULL THEN
    UPDATE crm.custom_fields f
      SET label = trim(p_label), options = choices, required = coalesce(p_required, false)
      WHERE f.id = p_field AND f.tenant_id = p_tenant AND f.kind = p_kind
      RETURNING f.id INTO saved;
    IF saved IS NULL THEN
      RAISE EXCEPTION 'Not found';
    END IF;
    RETURN saved;
  END IF;

  IF (SELECT count(*) FROM crm.custom_fields f WHERE f.tenant_id = p_tenant AND f.entity = p_entity) >= 30 THEN
    RAISE EXCEPTION 'Each record type can have up to 30 custom fields';
  END IF;

  base := coalesce(nullif(trim(BOTH '_' FROM regexp_replace(lower(p_label), '[^a-z0-9]+', '_', 'g')), ''), 'field');
  candidate := base;
  WHILE EXISTS (SELECT 1 FROM crm.custom_fields f WHERE f.tenant_id = p_tenant AND f.entity = p_entity AND f.slug = candidate) LOOP
    attempt := attempt + 1;
    candidate := base || '_' || attempt;
  END LOOP;

  INSERT INTO crm.custom_fields (tenant_id, entity, slug, label, kind, options, required, position)
    VALUES (p_tenant, p_entity, candidate, trim(p_label), p_kind, choices, coalesce(p_required, false),
      (SELECT coalesce(max(f.position), 0) + 1 FROM crm.custom_fields f WHERE f.tenant_id = p_tenant AND f.entity = p_entity))
    RETURNING id INTO saved;
  RETURN saved;
END;
$$;

CREATE FUNCTION crm.delete_custom_field(p_tenant UUID, p_field UUID)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  field crm.custom_fields;
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  PERFORM set_config('crm.trusted', 'on', true);

  DELETE FROM crm.custom_fields f WHERE f.id = p_field AND f.tenant_id = p_tenant RETURNING * INTO field;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;

  IF field.entity = 'lead' THEN
    UPDATE crm.leads SET custom = custom - field.slug WHERE tenant_id = p_tenant AND custom ? field.slug;
  ELSIF field.entity = 'contact' THEN
    UPDATE crm.contacts SET custom = custom - field.slug WHERE tenant_id = p_tenant AND custom ? field.slug;
  ELSIF field.entity = 'company' THEN
    UPDATE crm.companies SET custom = custom - field.slug WHERE tenant_id = p_tenant AND custom ? field.slug;
  ELSE
    UPDATE crm.deals SET custom = custom - field.slug WHERE tenant_id = p_tenant AND custom ? field.slug;
  END IF;
END;
$$;

-- Same rules as contacts, and a lead already in contacts or open leads is skipped
CREATE FUNCTION crm.import_leads(p_tenant UUID, p_rows JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  item JSONB;
  address TEXT;
  created INT := 0;
  skipped INT := 0;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  PERFORM set_config('crm.trusted', 'on', true);
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'Nothing to import';
  END IF;
  IF jsonb_array_length(p_rows) > 2000 THEN
    RAISE EXCEPTION 'Import up to 2000 leads at a time';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    address := nullif(lower(trim(coalesce(item->>'email', ''))), '');
    IF length(trim(coalesce(item->>'name', ''))) = 0
       OR (address IS NOT NULL AND (
         EXISTS (SELECT 1 FROM crm.contacts c WHERE c.tenant_id = p_tenant AND lower(c.email) = address)
         OR EXISTS (SELECT 1 FROM crm.leads l WHERE l.tenant_id = p_tenant AND lower(l.email) = address AND l.status IN ('new', 'working'))
       )) THEN
      skipped := skipped + 1;
      CONTINUE;
    END IF;

    INSERT INTO crm.leads (tenant_id, name, email, phone, company_name, job_title, source)
      VALUES (p_tenant, item->>'name', address, item->>'phone', item->>'company', item->>'job_title', coalesce(nullif(trim(coalesce(item->>'source', '')), ''), 'Import'));
    created := created + 1;
  END LOOP;

  RETURN json_build_object('created', created, 'skipped', skipped);
END;
$$;

CREATE OR REPLACE FUNCTION crm.import_contacts(p_tenant UUID, p_rows JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  item JSONB;
  address TEXT;
  company_name TEXT;
  found_company UUID;
  created INT := 0;
  skipped INT := 0;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  PERFORM set_config('crm.trusted', 'on', true);
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'Nothing to import';
  END IF;
  IF jsonb_array_length(p_rows) > 2000 THEN
    RAISE EXCEPTION 'Import up to 2000 contacts at a time';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    address := nullif(lower(trim(coalesce(item->>'email', ''))), '');
    IF length(trim(coalesce(item->>'name', ''))) = 0
       OR (address IS NOT NULL AND EXISTS (SELECT 1 FROM crm.contacts c WHERE c.tenant_id = p_tenant AND lower(c.email) = address)) THEN
      skipped := skipped + 1;
      CONTINUE;
    END IF;

    found_company := NULL;
    company_name := nullif(trim(coalesce(item->>'company', '')), '');
    IF company_name IS NOT NULL THEN
      SELECT c.id INTO found_company FROM crm.companies c WHERE c.tenant_id = p_tenant AND lower(c.name) = lower(company_name);
      IF found_company IS NULL THEN
        INSERT INTO crm.companies (tenant_id, name, owner_id) VALUES (p_tenant, company_name, auth.uid()) RETURNING id INTO found_company;
      END IF;
    END IF;

    INSERT INTO crm.contacts (tenant_id, name, email, phone, job_title, company_id, owner_id)
      VALUES (p_tenant, trim(item->>'name'), address, nullif(trim(coalesce(item->>'phone', '')), ''),
        nullif(trim(coalesce(item->>'job_title', '')), ''), found_company, auth.uid());
    created := created + 1;
  END LOOP;

  RETURN json_build_object('created', created, 'skipped', skipped);
END;
$$;

-- Moves a lead into the CRM proper. An email already in contacts links to that contact,
-- so converting can't create a second copy of someone.
CREATE FUNCTION crm.convert_lead(p_tenant UUID, p_lead UUID, p_contact UUID, p_company UUID, p_deal JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  lead crm.leads;
  the_contact UUID := p_contact;
  the_company UUID := p_company;
  the_deal UUID;
  found_new_contact BOOLEAN := false;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  PERFORM set_config('crm.trusted', 'on', true);

  SELECT * INTO lead FROM crm.leads l WHERE l.id = p_lead AND l.tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead not found';
  END IF;
  IF lead.status = 'converted' THEN
    RAISE EXCEPTION 'This lead has already been converted';
  END IF;

  IF the_contact IS NOT NULL AND NOT EXISTS (SELECT 1 FROM crm.contacts c WHERE c.id = the_contact AND c.tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'Contact not found';
  END IF;
  IF the_contact IS NULL AND lead.email IS NOT NULL THEN
    SELECT c.id INTO the_contact FROM crm.contacts c
      WHERE c.tenant_id = p_tenant AND lower(c.email) = lead.email ORDER BY c.created_at LIMIT 1;
  END IF;

  IF the_company IS NULL AND the_contact IS NOT NULL THEN
    SELECT c.company_id INTO the_company FROM crm.contacts c WHERE c.id = the_contact;
  END IF;
  IF the_company IS NULL AND lead.company_name IS NOT NULL THEN
    SELECT c.id INTO the_company FROM crm.companies c
      WHERE c.tenant_id = p_tenant AND lower(c.name) = lower(lead.company_name);
    IF the_company IS NULL THEN
      INSERT INTO crm.companies (tenant_id, name, owner_id, custom)
        VALUES (p_tenant, lead.company_name, lead.owner_id, lead.custom)
        RETURNING id INTO the_company;
    END IF;
  END IF;

  IF the_contact IS NULL THEN
    found_new_contact := true;
    INSERT INTO crm.contacts (tenant_id, name, email, phone, job_title, company_id, owner_id, notes, source, custom)
      VALUES (p_tenant, lead.name, lead.email, lead.phone, lead.job_title, the_company, lead.owner_id, lead.notes, lead.source, lead.custom)
      RETURNING id INTO the_contact;
  ELSE
    UPDATE crm.contacts c
      SET phone = coalesce(c.phone, lead.phone),
        job_title = coalesce(c.job_title, lead.job_title),
        company_id = coalesce(c.company_id, the_company),
        source = coalesce(c.source, lead.source),
        updated_at = now()
      WHERE c.id = the_contact
      RETURNING c.company_id INTO the_company;
  END IF;

  IF p_deal IS NOT NULL AND jsonb_typeof(p_deal) = 'object' THEN
    IF length(trim(coalesce(p_deal->>'title', ''))) = 0 THEN
      RAISE EXCEPTION 'Enter a deal title';
    END IF;
    IF coalesce(nullif(p_deal->>'value', '')::numeric, 0) < 0 THEN
      RAISE EXCEPTION 'Enter a valid deal value';
    END IF;
    INSERT INTO crm.deals (tenant_id, title, value, stage_id, contact_id, company_id, owner_id, expected_close, source, custom)
      VALUES (p_tenant, trim(p_deal->>'title'), nullif(p_deal->>'value', '')::numeric, nullif(p_deal->>'stage_id', '')::uuid,
        the_contact, the_company, lead.owner_id, nullif(p_deal->>'expected_close', '')::date, lead.source, lead.custom)
      RETURNING id INTO the_deal;
  END IF;

  UPDATE crm.activities a
    SET contact_id = the_contact, company_id = coalesce(a.company_id, the_company), deal_id = coalesce(a.deal_id, the_deal)
    WHERE a.lead_id = p_lead;

  UPDATE crm.leads l
    SET status = 'converted', converted_contact_id = the_contact, converted_company_id = the_company,
      converted_deal_id = the_deal, converted_at = now()
    WHERE l.id = p_lead;

  RETURN json_build_object('contact_id', the_contact, 'company_id', the_company, 'deal_id', the_deal, 'new_contact', found_new_contact);
END;
$$;

CREATE FUNCTION crm.digits(p_text TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT regexp_replace(coalesce(p_text, ''), '[^0-9]', '', 'g');
$$;

-- Runs as the user, so policies apply
CREATE FUNCTION crm.lead_matches(p_tenant UUID, p_lead UUID)
RETURNS JSON
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH lead AS (
    SELECT * FROM crm.leads l WHERE l.id = p_lead AND l.tenant_id = p_tenant
  )
  SELECT json_build_object(
    'contacts', (
      SELECT coalesce(json_agg(r), '[]'::json) FROM (
        SELECT c.id, c.name, c.email, c.phone, co.name AS company_name
        FROM crm.contacts c
        CROSS JOIN lead
        LEFT JOIN crm.companies co ON co.id = c.company_id
        WHERE c.tenant_id = p_tenant AND (
          lower(c.email) = lead.email
          OR (length(crm.digits(lead.phone)) >= 7 AND crm.digits(c.phone) = crm.digits(lead.phone))
          OR lower(c.name) = lower(lead.name)
        )
        ORDER BY c.name LIMIT 10
      ) r
    ),
    'leads', (
      SELECT coalesce(json_agg(r), '[]'::json) FROM (
        SELECT l.id, l.name, l.email, l.phone, l.company_name, l.status
        FROM crm.leads l
        CROSS JOIN lead
        WHERE l.tenant_id = p_tenant AND l.id <> lead.id AND l.status IN ('new', 'working') AND (
          l.email = lead.email
          OR (length(crm.digits(lead.phone)) >= 7 AND crm.digits(l.phone) = crm.digits(lead.phone))
          OR (lower(l.name) = lower(lead.name) AND lower(l.company_name) = lower(lead.company_name))
        )
        ORDER BY l.name LIMIT 10
      ) r
    )
  );
$$;

CREATE FUNCTION crm.duplicates(p_tenant UUID)
RETURNS JSON
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH contact_keys AS (
    SELECT c.id, 'email' AS reason, lower(c.email) AS match_key FROM crm.contacts c
      WHERE c.tenant_id = p_tenant AND length(trim(coalesce(c.email, ''))) > 0
    UNION ALL
    SELECT c.id, 'phone', crm.digits(c.phone) FROM crm.contacts c
      WHERE c.tenant_id = p_tenant AND length(crm.digits(c.phone)) >= 7
    UNION ALL
    SELECT c.id, 'name', lower(trim(c.name)) || '|' || coalesce(c.company_id::text, '') FROM crm.contacts c
      WHERE c.tenant_id = p_tenant
  ), contact_groups AS (
    SELECT DISTINCT ON (ids) reason, ids FROM (
      SELECT reason, array_agg(id ORDER BY id) AS ids FROM contact_keys GROUP BY reason, match_key HAVING count(*) > 1
    ) grouped
    ORDER BY ids, reason
    LIMIT 50
  ), lead_keys AS (
    SELECT l.id, 'email' AS reason, l.email AS match_key FROM crm.leads l
      WHERE l.tenant_id = p_tenant AND l.status IN ('new', 'working') AND l.email IS NOT NULL
    UNION ALL
    SELECT l.id, 'phone', crm.digits(l.phone) FROM crm.leads l
      WHERE l.tenant_id = p_tenant AND l.status IN ('new', 'working') AND length(crm.digits(l.phone)) >= 7
    UNION ALL
    SELECT l.id, 'name', lower(l.name) || '|' || lower(coalesce(l.company_name, '')) FROM crm.leads l
      WHERE l.tenant_id = p_tenant AND l.status IN ('new', 'working')
  ), lead_groups AS (
    SELECT DISTINCT ON (ids) reason, ids FROM (
      SELECT reason, array_agg(id ORDER BY id) AS ids FROM lead_keys GROUP BY reason, match_key HAVING count(*) > 1
    ) grouped
    ORDER BY ids, reason
    LIMIT 50
  )
  SELECT json_build_object(
    'contacts', (
      SELECT coalesce(json_agg(json_build_object('reason', g.reason, 'rows', (
        SELECT json_agg(json_build_object('id', c.id, 'name', c.name, 'email', c.email, 'phone', c.phone,
          'company_name', co.name, 'deals', (SELECT count(*) FROM crm.deals d WHERE d.contact_id = c.id)) ORDER BY c.created_at)
        FROM crm.contacts c LEFT JOIN crm.companies co ON co.id = c.company_id
        WHERE c.id = ANY(g.ids)
      ))), '[]'::json)
      FROM contact_groups g
    ),
    'leads', (
      SELECT coalesce(json_agg(json_build_object('reason', g.reason, 'rows', (
        SELECT json_agg(json_build_object('id', l.id, 'name', l.name, 'email', l.email, 'phone', l.phone,
          'company_name', l.company_name, 'score', l.score) ORDER BY l.created_at)
        FROM crm.leads l WHERE l.id = ANY(g.ids)
      ))), '[]'::json)
      FROM lead_groups g
    ),
    'leads_in_contacts', (
      SELECT coalesce(json_agg(r), '[]'::json) FROM (
        SELECT l.id, l.name, l.email, l.phone, c.id AS contact_id, c.name AS contact_name
        FROM crm.leads l
        JOIN crm.contacts c ON c.tenant_id = l.tenant_id AND (
          lower(c.email) = l.email
          OR (length(crm.digits(l.phone)) >= 7 AND crm.digits(c.phone) = crm.digits(l.phone))
        )
        WHERE l.tenant_id = p_tenant AND l.status IN ('new', 'working')
        ORDER BY l.name LIMIT 50
      ) r
    )
  );
$$;

CREATE FUNCTION crm.merge_contacts(p_tenant UUID, p_keep UUID, p_drop UUID)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  kept crm.contacts;
  dropped crm.contacts;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  PERFORM set_config('crm.trusted', 'on', true);

  IF p_keep = p_drop THEN
    RAISE EXCEPTION 'Choose two different contacts';
  END IF;
  SELECT * INTO kept FROM crm.contacts c WHERE c.id = p_keep AND c.tenant_id = p_tenant FOR UPDATE;
  SELECT * INTO dropped FROM crm.contacts c WHERE c.id = p_drop AND c.tenant_id = p_tenant FOR UPDATE;
  IF kept.id IS NULL OR dropped.id IS NULL THEN
    RAISE EXCEPTION 'Contact not found';
  END IF;
  IF kept.customer_id IS NOT NULL AND dropped.customer_id IS NOT NULL AND kept.customer_id <> dropped.customer_id THEN
    RAISE EXCEPTION 'These contacts are linked to different Accounting customers, so they can''t be merged';
  END IF;

  UPDATE crm.deals d SET contact_id = p_keep WHERE d.contact_id = p_drop;
  UPDATE crm.quotes q SET contact_id = p_keep WHERE q.contact_id = p_drop;
  UPDATE crm.activities a SET contact_id = p_keep WHERE a.contact_id = p_drop;
  UPDATE crm.leads l SET converted_contact_id = p_keep WHERE l.converted_contact_id = p_drop;

  UPDATE crm.contacts c
    SET email = coalesce(kept.email, dropped.email),
      phone = coalesce(kept.phone, dropped.phone),
      job_title = coalesce(kept.job_title, dropped.job_title),
      company_id = coalesce(kept.company_id, dropped.company_id),
      owner_id = coalesce(kept.owner_id, dropped.owner_id),
      customer_id = coalesce(kept.customer_id, dropped.customer_id),
      source = coalesce(kept.source, dropped.source),
      notes = nullif(concat_ws(E'\n\n', kept.notes, dropped.notes), ''),
      custom = dropped.custom || kept.custom,
      updated_at = now()
    WHERE c.id = p_keep;

  DELETE FROM crm.contacts c WHERE c.id = p_drop;

  INSERT INTO crm.activities (tenant_id, kind, subject, body, contact_id)
    VALUES (p_tenant, 'note', 'Merged in a duplicate contact', trim(concat_ws(' ', dropped.name, dropped.email, dropped.phone)), p_keep);
END;
$$;

CREATE FUNCTION crm.merge_leads(p_tenant UUID, p_keep UUID, p_drop UUID)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  kept crm.leads;
  dropped crm.leads;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  PERFORM set_config('crm.trusted', 'on', true);

  IF p_keep = p_drop THEN
    RAISE EXCEPTION 'Choose two different leads';
  END IF;
  SELECT * INTO kept FROM crm.leads l WHERE l.id = p_keep AND l.tenant_id = p_tenant FOR UPDATE;
  SELECT * INTO dropped FROM crm.leads l WHERE l.id = p_drop AND l.tenant_id = p_tenant FOR UPDATE;
  IF kept.id IS NULL OR dropped.id IS NULL THEN
    RAISE EXCEPTION 'Lead not found';
  END IF;
  IF kept.status = 'converted' OR dropped.status = 'converted' THEN
    RAISE EXCEPTION 'A converted lead can''t be merged';
  END IF;

  UPDATE crm.activities a SET lead_id = p_keep WHERE a.lead_id = p_drop;

  UPDATE crm.leads l
    SET email = coalesce(kept.email, dropped.email),
      phone = coalesce(kept.phone, dropped.phone),
      company_name = coalesce(kept.company_name, dropped.company_name),
      job_title = coalesce(kept.job_title, dropped.job_title),
      source = coalesce(kept.source, dropped.source),
      owner_id = coalesce(kept.owner_id, dropped.owner_id),
      notes = nullif(concat_ws(E'\n\n', kept.notes, dropped.notes), ''),
      custom = dropped.custom || kept.custom
    WHERE l.id = p_keep;

  DELETE FROM crm.leads l WHERE l.id = p_drop;
END;
$$;

CREATE FUNCTION crm.lead_summary(p_tenant UUID)
RETURNS JSON
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH open_leads AS (
    SELECT * FROM crm.leads l WHERE l.tenant_id = p_tenant AND l.status IN ('new', 'working')
  )
  SELECT json_build_object(
    'open', (SELECT count(*) FROM open_leads),
    'new', (SELECT count(*) FROM open_leads WHERE status = 'new'),
    'unassigned', (SELECT count(*) FROM open_leads WHERE owner_id IS NULL),
    'top', (
      SELECT coalesce(json_agg(r), '[]'::json) FROM (
        SELECT id, name, company_name, score, status FROM open_leads
        WHERE owner_id = auth.uid() OR owner_id IS NULL
        ORDER BY score DESC, created_at DESC LIMIT 5
      ) r
    )
  );
$$;

CREATE OR REPLACE FUNCTION crm.search(p_tenant UUID, p_query TEXT)
RETURNS JSON
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH pattern AS (
    SELECT '%' || replace(replace(replace(trim(coalesce(p_query, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%' AS needle
  )
  SELECT json_build_object(
    'contacts', (
      SELECT coalesce(json_agg(r), '[]'::json) FROM (
        SELECT c.id, c.name, c.email FROM crm.contacts c, pattern p
        WHERE c.tenant_id = p_tenant AND (c.name ILIKE p.needle OR c.email ILIKE p.needle OR c.phone ILIKE p.needle)
        ORDER BY c.name LIMIT 8
      ) r
    ),
    'companies', (
      SELECT coalesce(json_agg(r), '[]'::json) FROM (
        SELECT c.id, c.name FROM crm.companies c, pattern p
        WHERE c.tenant_id = p_tenant AND c.name ILIKE p.needle ORDER BY c.name LIMIT 8
      ) r
    ),
    'deals', (
      SELECT coalesce(json_agg(r), '[]'::json) FROM (
        SELECT d.id, d.title, d.value FROM crm.deals d, pattern p
        WHERE d.tenant_id = p_tenant AND d.title ILIKE p.needle ORDER BY d.title LIMIT 8
      ) r
    ),
    'leads', (
      SELECT coalesce(json_agg(r), '[]'::json) FROM (
        SELECT l.id, l.name, l.email FROM crm.leads l, pattern p
        WHERE l.tenant_id = p_tenant AND l.status <> 'converted'
          AND (l.name ILIKE p.needle OR l.email ILIKE p.needle OR l.phone ILIKE p.needle OR l.company_name ILIKE p.needle)
        ORDER BY l.name LIMIT 8
      ) r
    )
  );
$$;

-- The public web form. There is no signed-in user, so these look a company up by its private key.
CREATE FUNCTION public.form_info(p_key TEXT)
RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT json_build_object('company', t.name)
  FROM crm.lead_settings s JOIN public.tenants t ON t.id = s.tenant_id
  WHERE s.form_key = p_key AND s.form_enabled;
$$;

CREATE FUNCTION public.capture_lead(p_key TEXT, p_lead JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  setting crm.lead_settings;
  visitor TEXT := trim(coalesce(p_lead->>'name', ''));
  address TEXT := lower(trim(coalesce(p_lead->>'email', '')));
  phone_number TEXT := trim(coalesce(p_lead->>'phone', ''));
  business TEXT := trim(coalesce(p_lead->>'company', ''));
  message TEXT := nullif(trim(coalesce(p_lead->>'message', '')), '');
  earlier crm.leads;
BEGIN
  SELECT * INTO setting FROM crm.lead_settings s WHERE s.form_key = p_key AND s.form_enabled;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This form is not available';
  END IF;
  PERFORM set_config('crm.trusted', 'on', true);

  IF length(visitor) = 0 OR length(visitor) > 200 THEN
    RAISE EXCEPTION 'Enter your name';
  END IF;
  IF length(address) = 0 AND length(phone_number) = 0 THEN
    RAISE EXCEPTION 'Enter an email or phone number';
  END IF;
  IF length(address) > 254 OR (length(address) > 0 AND address !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') THEN
    RAISE EXCEPTION 'Enter a valid email';
  END IF;
  IF length(phone_number) > 40 OR length(business) > 200 OR length(coalesce(message, '')) > 2000 THEN
    RAISE EXCEPTION 'That is too long';
  END IF;

  -- A spam attack stops here instead of filling the database
  IF (SELECT count(*) FROM crm.leads l WHERE l.tenant_id = setting.tenant_id AND l.from_form AND l.created_at > now() - interval '1 day') >= 500
     OR (SELECT count(*) FROM crm.activities a WHERE a.tenant_id = setting.tenant_id AND a.subject = 'Filled in the web form again' AND a.created_at > now() - interval '1 day') >= 500 THEN
    RAISE EXCEPTION 'This form is busy. Please try again tomorrow.';
  END IF;

  IF length(address) > 0 THEN
    SELECT * INTO earlier FROM crm.leads l
      WHERE l.tenant_id = setting.tenant_id AND l.email = address AND l.status IN ('new', 'working')
      ORDER BY l.created_at LIMIT 1;
  END IF;

  IF earlier.id IS NOT NULL THEN
    INSERT INTO crm.activities (tenant_id, kind, subject, body, lead_id, owner_id)
      VALUES (setting.tenant_id, 'note', 'Filled in the web form again', message, earlier.id, earlier.owner_id);
  ELSE
    INSERT INTO crm.leads (tenant_id, name, email, phone, company_name, notes, source, from_form)
      VALUES (setting.tenant_id, visitor, nullif(address, ''), nullif(phone_number, ''), nullif(business, ''), message, setting.form_source, true);
  END IF;

  RETURN json_build_object('thanks', setting.form_thanks);
END;
$$;

REVOKE ALL ON FUNCTION
  crm.seed_leads(UUID),
  crm.seed_leads_for_new_tenant(),
  crm.trusted(),
  crm.check_custom(),
  crm.next_owner(UUID),
  crm.prepare_lead(),
  crm.rescore_lead(),
  crm.save_lead_settings(UUID, JSONB),
  crm.new_form_key(UUID),
  crm.save_custom_field(UUID, UUID, TEXT, TEXT, TEXT, JSONB, BOOLEAN),
  crm.delete_custom_field(UUID, UUID),
  crm.import_leads(UUID, JSONB),
  crm.convert_lead(UUID, UUID, UUID, UUID, JSONB),
  crm.digits(TEXT),
  crm.lead_matches(UUID, UUID),
  crm.duplicates(UUID),
  crm.merge_contacts(UUID, UUID, UUID),
  crm.merge_leads(UUID, UUID, UUID),
  crm.lead_summary(UUID),
  public.form_info(TEXT),
  public.capture_lead(TEXT, JSONB)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  crm.save_lead_settings(UUID, JSONB),
  crm.new_form_key(UUID),
  crm.save_custom_field(UUID, UUID, TEXT, TEXT, TEXT, JSONB, BOOLEAN),
  crm.delete_custom_field(UUID, UUID),
  crm.import_leads(UUID, JSONB),
  crm.convert_lead(UUID, UUID, UUID, UUID, JSONB),
  crm.digits(TEXT),
  crm.lead_matches(UUID, UUID),
  crm.duplicates(UUID),
  crm.merge_contacts(UUID, UUID, UUID),
  crm.merge_leads(UUID, UUID, UUID),
  crm.lead_summary(UUID)
  TO authenticated;

GRANT EXECUTE ON FUNCTION public.form_info(TEXT), public.capture_lead(TEXT, JSONB) TO anon;

NOTIFY pgrst, 'reload schema';
