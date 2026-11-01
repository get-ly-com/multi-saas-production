-- CRM core: companies, pipelines with your own stages, an activity timeline, tasks and a daily overview.
-- contacts.company and deals.stage stay until the new service is live, then 015 removes them.

CREATE TABLE crm.companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  website TEXT,
  industry TEXT,
  phone TEXT,
  notes TEXT,
  owner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_crm_companies_name ON crm.companies (tenant_id, lower(name));

CREATE TABLE crm.pipelines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_crm_pipelines_name ON crm.pipelines (tenant_id, lower(name));
CREATE UNIQUE INDEX uq_crm_pipelines_default ON crm.pipelines (tenant_id) WHERE is_default;

CREATE TABLE crm.stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  pipeline_id UUID NOT NULL REFERENCES crm.pipelines(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INT NOT NULL,
  probability INT NOT NULL CHECK (probability BETWEEN 0 AND 100),
  kind TEXT NOT NULL DEFAULT 'open' CHECK (kind IN ('open', 'won', 'lost'))
);
CREATE INDEX idx_crm_stages_pipeline ON crm.stages (pipeline_id, position);

ALTER TABLE crm.contacts
  ADD COLUMN company_id UUID REFERENCES crm.companies(id) ON DELETE SET NULL,
  ADD COLUMN job_title TEXT,
  ADD COLUMN owner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
CREATE INDEX idx_crm_contacts_company ON crm.contacts (company_id);
CREATE INDEX idx_crm_contacts_email ON crm.contacts (tenant_id, lower(email));

ALTER TABLE crm.deals
  ADD COLUMN stage_id UUID REFERENCES crm.stages(id),
  ADD COLUMN company_id UUID REFERENCES crm.companies(id) ON DELETE SET NULL,
  ADD COLUMN owner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN expected_close DATE,
  ADD COLUMN lost_reason TEXT,
  ADD COLUMN closed_at TIMESTAMP,
  ADD COLUMN stage_changed_at TIMESTAMP NOT NULL DEFAULT now();
CREATE INDEX idx_crm_deals_stage ON crm.deals (stage_id);
CREATE INDEX idx_crm_deals_company ON crm.deals (company_id);
CREATE INDEX idx_crm_deals_contact ON crm.deals (contact_id);

-- Deleting a contact used to delete their deals as well
ALTER TABLE crm.deals DROP CONSTRAINT deals_contact_id_fkey;
ALTER TABLE crm.deals ADD CONSTRAINT deals_contact_id_fkey
  FOREIGN KEY (contact_id) REFERENCES crm.contacts(id) ON DELETE SET NULL;

CREATE TABLE crm.activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('note', 'call', 'email', 'meeting', 'task')),
  subject TEXT NOT NULL CHECK (length(trim(subject)) > 0),
  body TEXT,
  due_on DATE,
  done_at TIMESTAMP,
  contact_id UUID REFERENCES crm.contacts(id) ON DELETE SET NULL,
  company_id UUID REFERENCES crm.companies(id) ON DELETE SET NULL,
  deal_id UUID REFERENCES crm.deals(id) ON DELETE SET NULL,
  owner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_activities_contact ON crm.activities (contact_id);
CREATE INDEX idx_crm_activities_company ON crm.activities (company_id);
CREATE INDEX idx_crm_activities_deal ON crm.activities (deal_id);
CREATE INDEX idx_crm_activities_open ON crm.activities (tenant_id, due_on) WHERE done_at IS NULL;

CREATE TABLE crm.deal_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES crm.deals(id) ON DELETE CASCADE,
  from_stage_id UUID REFERENCES crm.stages(id) ON DELETE SET NULL,
  to_stage_id UUID REFERENCES crm.stages(id) ON DELETE SET NULL,
  value NUMERIC,
  changed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_deal_history_deal ON crm.deal_history (deal_id);

ALTER TABLE crm.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.deal_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_rows ON crm.companies FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid())));
CREATE POLICY tenant_writes ON crm.companies FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid()) AND role <> 'viewer'))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid()) AND role <> 'viewer'));
CREATE POLICY tenant_rows ON crm.activities FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid())));
CREATE POLICY tenant_writes ON crm.activities FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid()) AND role <> 'viewer'))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid()) AND role <> 'viewer'));
CREATE POLICY tenant_rows ON crm.pipelines FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid())));
CREATE POLICY tenant_rows ON crm.stages FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid())));
CREATE POLICY tenant_rows ON crm.deal_history FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid())));

GRANT SELECT, INSERT, UPDATE, DELETE ON crm.companies, crm.activities TO authenticated;
GRANT SELECT ON crm.pipelines, crm.stages, crm.deal_history TO authenticated;

-- Every new company starts with one pipeline
CREATE FUNCTION crm.seed_pipeline(p_tenant UUID)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  new_pipeline UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM crm.pipelines WHERE tenant_id = p_tenant) THEN
    RETURN;
  END IF;
  INSERT INTO crm.pipelines (tenant_id, name, is_default) VALUES (p_tenant, 'Sales', true) RETURNING id INTO new_pipeline;
  INSERT INTO crm.stages (tenant_id, pipeline_id, name, position, probability, kind) VALUES
    (p_tenant, new_pipeline, 'Prospecting', 1, 10, 'open'),
    (p_tenant, new_pipeline, 'Qualified', 2, 30, 'open'),
    (p_tenant, new_pipeline, 'Proposal', 3, 60, 'open'),
    (p_tenant, new_pipeline, 'Won', 4, 100, 'won'),
    (p_tenant, new_pipeline, 'Lost', 5, 0, 'lost');
END;
$$;

CREATE FUNCTION crm.seed_pipeline_for_new_tenant()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM crm.seed_pipeline(NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER seed_pipeline AFTER INSERT ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION crm.seed_pipeline_for_new_tenant();

SELECT crm.seed_pipeline(id) FROM public.tenants;

-- Existing data moves to the new shape
INSERT INTO crm.companies (tenant_id, name)
  SELECT DISTINCT ON (tenant_id, lower(trim(company))) tenant_id, trim(company)
  FROM crm.contacts WHERE length(trim(coalesce(company, ''))) > 0
  ORDER BY tenant_id, lower(trim(company));

UPDATE crm.contacts c SET company_id = co.id
  FROM crm.companies co
  WHERE co.tenant_id = c.tenant_id AND lower(co.name) = lower(trim(c.company));

UPDATE crm.deals d SET stage_id = s.id
  FROM crm.stages s
  WHERE s.tenant_id = d.tenant_id AND lower(s.name) = lower(coalesce(d.stage, 'prospecting'));

UPDATE crm.deals d SET company_id = c.company_id FROM crm.contacts c WHERE c.id = d.contact_id;

UPDATE crm.deals d SET closed_at = coalesce(d.updated_at, now()::timestamp)
  FROM crm.stages s WHERE s.id = d.stage_id AND s.kind <> 'open';

ALTER TABLE crm.deals ALTER COLUMN stage_id SET NOT NULL;

INSERT INTO crm.deal_history (tenant_id, deal_id, to_stage_id, value, changed_at)
  SELECT tenant_id, id, stage_id, value, coalesce(created_at, now()::timestamp) FROM crm.deals;

-- A foreign key only proves the row exists. This proves it belongs to the same company.
CREATE FUNCTION crm.check_links()
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

CREATE TRIGGER a_check_links BEFORE INSERT OR UPDATE ON crm.companies FOR EACH ROW EXECUTE FUNCTION crm.check_links();
CREATE TRIGGER a_check_links BEFORE INSERT OR UPDATE ON crm.contacts FOR EACH ROW EXECUTE FUNCTION crm.check_links();
CREATE TRIGGER a_check_links BEFORE INSERT OR UPDATE ON crm.deals FOR EACH ROW EXECUTE FUNCTION crm.check_links();
CREATE TRIGGER a_check_links BEFORE INSERT OR UPDATE ON crm.activities FOR EACH ROW EXECUTE FUNCTION crm.check_links();

CREATE FUNCTION crm.prepare_deal()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  stage_kind TEXT;
BEGIN
  IF NEW.stage_id IS NULL THEN
    SELECT s.id INTO NEW.stage_id
      FROM crm.stages s JOIN crm.pipelines p ON p.id = s.pipeline_id
      WHERE s.tenant_id = NEW.tenant_id AND p.is_default AND s.kind = 'open'
      ORDER BY s.position LIMIT 1;
  END IF;
  SELECT kind INTO stage_kind FROM crm.stages WHERE id = NEW.stage_id;

  IF NEW.company_id IS NULL AND NEW.contact_id IS NOT NULL THEN
    SELECT company_id INTO NEW.company_id FROM crm.contacts WHERE id = NEW.contact_id;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.owner_id := coalesce(NEW.owner_id, auth.uid());
    NEW.stage_changed_at := now();
  ELSIF NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    NEW.stage_changed_at := now();
  END IF;

  IF stage_kind = 'open' THEN
    NEW.closed_at := NULL;
    NEW.lost_reason := NULL;
  ELSE
    IF TG_OP = 'INSERT' OR NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
      NEW.closed_at := now();
    END IF;
    IF stage_kind = 'won' THEN
      NEW.lost_reason := NULL;
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER b_prepare_deal BEFORE INSERT OR UPDATE ON crm.deals
  FOR EACH ROW EXECUTE FUNCTION crm.prepare_deal();

CREATE FUNCTION crm.log_deal_stage()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    INSERT INTO crm.deal_history (tenant_id, deal_id, from_stage_id, to_stage_id, value, changed_by)
      VALUES (NEW.tenant_id, NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.stage_id END, NEW.stage_id, NEW.value, auth.uid());
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER log_deal_stage AFTER INSERT OR UPDATE ON crm.deals
  FOR EACH ROW EXECUTE FUNCTION crm.log_deal_stage();

-- Something logged on a deal also shows on its contact and company
CREATE FUNCTION crm.prepare_activity()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
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

  IF TG_OP = 'INSERT' THEN
    NEW.created_by := auth.uid();
    NEW.owner_id := coalesce(NEW.owner_id, auth.uid());
    IF NEW.kind <> 'task' THEN
      NEW.done_at := coalesce(NEW.done_at, now());
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER b_prepare_activity BEFORE INSERT OR UPDATE ON crm.activities
  FOR EACH ROW EXECUTE FUNCTION crm.prepare_activity();

-- Stages are saved as one list, so a pipeline can never end up half changed
CREATE FUNCTION crm.save_pipeline(p_tenant UUID, p_pipeline UUID, p_name TEXT, p_stages JSONB)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  the_pipeline UUID := p_pipeline;
  item JSONB;
  place INT := 0;
  kept UUID[] := '{}';
  saved_stage UUID;
  gone TEXT;
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
    IF saved_stage IS NOT NULL THEN
      UPDATE crm.stages s
        SET name = trim(item->>'name'), position = place, probability = (item->>'probability')::int, kind = item->>'kind'
        WHERE s.id = saved_stage AND s.pipeline_id = the_pipeline;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Not found';
      END IF;
    ELSE
      INSERT INTO crm.stages (tenant_id, pipeline_id, name, position, probability, kind)
        VALUES (p_tenant, the_pipeline, trim(item->>'name'), place, (item->>'probability')::int, item->>'kind')
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
$$;

CREATE FUNCTION crm.delete_pipeline(p_tenant UUID, p_pipeline UUID)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  IF EXISTS (SELECT 1 FROM crm.pipelines WHERE id = p_pipeline AND tenant_id = p_tenant AND is_default) THEN
    RAISE EXCEPTION 'The default pipeline can''t be deleted';
  END IF;
  IF EXISTS (SELECT 1 FROM crm.deals d JOIN crm.stages s ON s.id = d.stage_id WHERE s.pipeline_id = p_pipeline) THEN
    RAISE EXCEPTION 'Move the deals out of this pipeline first';
  END IF;
  DELETE FROM crm.pipelines WHERE id = p_pipeline AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
END;
$$;

-- Rows matching an existing email are skipped. Company names are found or created.
CREATE FUNCTION crm.import_contacts(p_tenant UUID, p_rows JSONB)
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

-- What a salesperson needs to see first. Runs as the user, so policies apply.
CREATE FUNCTION crm.overview(p_tenant UUID)
RETURNS JSON
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH open_deals AS (
    SELECT d.*, s.probability, s.name AS stage_name, s.position, s.pipeline_id,
      greatest(d.stage_changed_at, (SELECT max(a.created_at) FROM crm.activities a WHERE a.deal_id = d.id)) AS last_touch
    FROM crm.deals d JOIN crm.stages s ON s.id = d.stage_id
    WHERE d.tenant_id = p_tenant AND s.kind = 'open'
  ), closed AS (
    SELECT s.kind, d.value, d.closed_at
    FROM crm.deals d JOIN crm.stages s ON s.id = d.stage_id
    WHERE d.tenant_id = p_tenant AND s.kind <> 'open'
  ), tasks AS (
    SELECT a.id, a.subject, a.due_on, a.owner_id, a.deal_id, a.contact_id, a.company_id,
      c.name AS contact_name, d.title AS deal_title
    FROM crm.activities a
    LEFT JOIN crm.contacts c ON c.id = a.contact_id
    LEFT JOIN crm.deals d ON d.id = a.deal_id
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

CREATE FUNCTION crm.search(p_tenant UUID, p_query TEXT)
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
    )
  );
$$;

REVOKE ALL ON FUNCTION
  crm.seed_pipeline(UUID),
  crm.seed_pipeline_for_new_tenant(),
  crm.check_links(),
  crm.prepare_deal(),
  crm.log_deal_stage(),
  crm.prepare_activity(),
  crm.save_pipeline(UUID, UUID, TEXT, JSONB),
  crm.delete_pipeline(UUID, UUID),
  crm.import_contacts(UUID, JSONB),
  crm.overview(UUID),
  crm.search(UUID, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  crm.save_pipeline(UUID, UUID, TEXT, JSONB),
  crm.delete_pipeline(UUID, UUID),
  crm.import_contacts(UUID, JSONB),
  crm.overview(UUID),
  crm.search(UUID, TEXT)
  TO authenticated;

NOTIFY pgrst, 'reload schema';
