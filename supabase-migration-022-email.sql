-- Email from the CRM. The service sends through the provider; the database decides who may be
-- emailed, keeps the daily limits and logs each sent email on the record's timeline.
-- Only the address on the contact or lead can be emailed, so our sending domain can't be used
-- to write to arbitrary people.

CREATE TABLE crm.emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES crm.contacts(id) ON DELETE SET NULL,
  lead_id UUID REFERENCES crm.leads(id) ON DELETE SET NULL,
  deal_id UUID REFERENCES crm.deals(id) ON DELETE SET NULL,
  company_id UUID REFERENCES crm.companies(id) ON DELETE SET NULL,
  activity_id UUID REFERENCES crm.activities(id) ON DELETE SET NULL,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  status TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  provider_id TEXT,
  error TEXT,
  sent_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  sent_at TIMESTAMP
);
CREATE INDEX idx_crm_emails_tenant_created ON crm.emails (tenant_id, created_at);
CREATE INDEX idx_crm_emails_created ON crm.emails (created_at);
CREATE INDEX idx_crm_emails_contact ON crm.emails (contact_id);
CREATE INDEX idx_crm_emails_lead ON crm.emails (lead_id);
CREATE INDEX idx_crm_emails_deal ON crm.emails (deal_id);
CREATE INDEX idx_crm_emails_company ON crm.emails (company_id);
CREATE INDEX idx_crm_emails_activity ON crm.emails (activity_id);
CREATE INDEX idx_crm_emails_sent_by ON crm.emails (sent_by);
ALTER TABLE crm.emails ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON crm.emails FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid())));
GRANT SELECT ON crm.emails TO authenticated;

CREATE TABLE crm.email_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_crm_email_templates_name ON crm.email_templates (tenant_id, lower(name));
CREATE INDEX idx_crm_email_templates_created_by ON crm.email_templates (created_by);
ALTER TABLE crm.email_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON crm.email_templates FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid())));
CREATE POLICY tenant_writes ON crm.email_templates FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid()) AND role <> 'viewer'))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid()) AND role <> 'viewer'));
GRANT SELECT, DELETE ON crm.email_templates TO authenticated;
GRANT INSERT (tenant_id, name, subject, body) ON crm.email_templates TO authenticated;
GRANT UPDATE (name, subject, body, updated_at) ON crm.email_templates TO authenticated;

-- Limits that keep the free sending plan and our domain's reputation safe
CREATE FUNCTION crm.email_limits()
RETURNS JSON
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT json_build_object('per_company_day', 40, 'platform_day', 95, 'per_company_month', 500) $$;

-- How many a company has sent and may still send today
CREATE FUNCTION crm.email_usage(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  limits JSON := crm.email_limits();
  today_count INT;
  month_count INT;
  platform_count INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  SELECT count(*) INTO today_count FROM crm.emails
    WHERE tenant_id = p_tenant AND status <> 'failed' AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC');
  SELECT count(*) INTO month_count FROM crm.emails
    WHERE tenant_id = p_tenant AND status <> 'failed' AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC');
  SELECT count(*) INTO platform_count FROM crm.emails
    WHERE status <> 'failed' AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC');
  RETURN json_build_object(
    'today', today_count, 'month', month_count,
    'day_limit', (limits->>'per_company_day')::int, 'month_limit', (limits->>'per_company_month')::int,
    'left_today', greatest(0, least(
      (limits->>'per_company_day')::int - today_count,
      (limits->>'per_company_month')::int - month_count,
      (limits->>'platform_day')::int - platform_count))
  );
END;
$$;

-- Checks the recipient and limits, and records the email as sending. The service sends it,
-- then calls finish_email with the result.
CREATE FUNCTION crm.start_email(
  p_tenant UUID, p_contact UUID, p_lead UUID, p_deal UUID, p_to TEXT, p_subject TEXT, p_body TEXT
)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  address TEXT := lower(btrim(coalesce(p_to, '')));
  allowed TEXT[] := '{}';
  deal crm.deals;
  usage JSON;
  company UUID;
  new_id UUID;
  tenant_name TEXT;
  sender_email TEXT;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  IF num_nonnulls(p_contact, p_lead, p_deal) = 0 THEN
    RAISE EXCEPTION 'Send from a contact, lead or deal';
  END IF;
  IF p_contact IS NOT NULL AND p_lead IS NOT NULL THEN
    RAISE EXCEPTION 'Send to a contact or a lead, not both';
  END IF;
  IF length(btrim(coalesce(p_subject, ''))) = 0 OR length(p_subject) > 200 THEN
    RAISE EXCEPTION 'Enter a subject of up to 200 characters';
  END IF;
  IF length(btrim(coalesce(p_body, ''))) = 0 OR length(p_body) > 20000 THEN
    RAISE EXCEPTION 'Write a message of up to 20,000 characters';
  END IF;

  IF p_deal IS NOT NULL THEN
    SELECT * INTO deal FROM crm.deals WHERE id = p_deal AND tenant_id = p_tenant;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Deal not found';
    END IF;
    company := deal.company_id;
    -- A deal's email goes to its contact unless another contact is chosen
    IF p_contact IS NULL AND p_lead IS NULL THEN
      p_contact := deal.contact_id;
    END IF;
  END IF;

  IF p_contact IS NOT NULL THEN
    SELECT array_remove(ARRAY[lower(btrim(email))], NULL), coalesce(company, company_id) INTO allowed, company
      FROM crm.contacts WHERE id = p_contact AND tenant_id = p_tenant;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Contact not found';
    END IF;
  ELSIF p_lead IS NOT NULL THEN
    SELECT array_remove(ARRAY[lower(btrim(email))], NULL) INTO allowed
      FROM crm.leads WHERE id = p_lead AND tenant_id = p_tenant;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Lead not found';
    END IF;
  END IF;

  IF cardinality(allowed) = 0 THEN
    RAISE EXCEPTION 'Add an email address to this record first';
  END IF;
  IF address = '' THEN
    address := allowed[1];
  END IF;
  IF NOT address = ANY (allowed) THEN
    RAISE EXCEPTION 'You can only email the address saved on this record';
  END IF;
  IF address !~ '^[^@\s<>,;"]+@[^@\s<>,;"]+\.[^@\s<>,;"]+$' THEN
    RAISE EXCEPTION 'That email address doesn''t look right';
  END IF;

  -- One sender at a time per company, so two sends can't both slip under the limit
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 7));
  PERFORM pg_advisory_xact_lock(hashtextextended('crm-email-platform', 7));
  usage := crm.email_usage(p_tenant);
  IF (usage->>'left_today')::int <= 0 THEN
    RAISE EXCEPTION 'Your company has reached today''s email limit. Try again tomorrow.';
  END IF;

  INSERT INTO crm.emails (tenant_id, contact_id, lead_id, deal_id, company_id, to_address, subject, body, sent_by)
    VALUES (p_tenant, p_contact, p_lead, p_deal, company, address, btrim(p_subject), p_body, auth.uid())
    RETURNING id INTO new_id;

  SELECT name INTO tenant_name FROM public.tenants WHERE id = p_tenant;
  SELECT email INTO sender_email FROM auth.users WHERE id = auth.uid();
  RETURN json_build_object('id', new_id, 'to', address, 'subject', btrim(p_subject), 'body', p_body,
    'from_name', tenant_name, 'reply_to', sender_email);
END;
$$;

-- Records what the provider said. A sent email becomes a done email activity on the timeline.
CREATE FUNCTION crm.finish_email(p_tenant UUID, p_email UUID, p_provider_id TEXT, p_error TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  sent crm.emails;
  activity UUID;
BEGIN
  SELECT * INTO sent FROM crm.emails
    WHERE id = p_email AND tenant_id = p_tenant AND sent_by = auth.uid() AND status = 'sending' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Email not found';
  END IF;

  IF p_error IS NOT NULL THEN
    UPDATE crm.emails SET status = 'failed', error = left(p_error, 500) WHERE id = sent.id;
    RETURN json_build_object('id', sent.id, 'status', 'failed', 'error', left(p_error, 500));
  END IF;

  INSERT INTO crm.activities (tenant_id, kind, subject, body, done_at, contact_id, company_id, deal_id, lead_id, owner_id, created_by)
    VALUES (sent.tenant_id, 'email', 'Sent: ' || sent.subject, 'To ' || sent.to_address || E'\n\n' || sent.body, now(),
      sent.contact_id, sent.company_id, sent.deal_id, sent.lead_id, auth.uid(), auth.uid())
    RETURNING id INTO activity;
  UPDATE crm.emails SET status = 'sent', provider_id = left(p_provider_id, 200), sent_at = now(), activity_id = activity
    WHERE id = sent.id;
  RETURN json_build_object('id', sent.id, 'status', 'sent', 'activity_id', activity);
END;
$$;

REVOKE EXECUTE ON FUNCTION crm.email_usage(UUID), crm.start_email(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT),
  crm.finish_email(UUID, UUID, TEXT, TEXT), crm.email_limits() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION crm.email_usage(UUID), crm.start_email(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT),
  crm.finish_email(UUID, UUID, TEXT, TEXT) TO authenticated;
