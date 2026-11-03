-- Links chat and social media to the CRM.
-- * A chat is linked to the CRM contact with the visitor's email (or one staff pick), and a closed
--   chat leaves one "Website chat" note with the transcript on that contact or lead. Closing it
--   again after it was reopened updates the same note.
-- * Campaign tracking: the chat page and the web form pass on the campaign from the link people
--   came in by (utm_campaign), and the social planner shows the results per campaign.

-- ---------- Chat: contact, timeline note and campaign ----------
ALTER TABLE chat.conversations
  ADD COLUMN IF NOT EXISTS contact_id UUID REFERENCES crm.contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS activity_id UUID REFERENCES crm.activities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS campaign TEXT CHECK (length(campaign) <= 100);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_contact ON chat.conversations (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_conversations_campaign ON chat.conversations (tenant_id, lower(campaign)) WHERE campaign IS NOT NULL;
-- Staff read conversations column by column (the visitor's token stays hidden)
GRANT SELECT (contact_id, activity_id, campaign) ON chat.conversations TO authenticated;

-- A campaign name from a link: trimmed, at most 100 characters, empty means none
CREATE OR REPLACE FUNCTION chat.clean_campaign(p_value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT nullif(left(btrim(coalesce(p_value, '')), 100), '');
$$;
REVOKE EXECUTE ON FUNCTION chat.clean_campaign(TEXT) FROM PUBLIC, anon, authenticated;

-- Links a chat to the company's CRM contact with the visitor's email, if there is one and the chat
-- isn't linked yet. The contact takes the chat's campaign if it has none.
CREATE OR REPLACE FUNCTION chat.match_contact(p_conversation UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  convo chat.conversations;
  v_found UUID;
BEGIN
  SELECT * INTO convo FROM chat.conversations WHERE id = p_conversation;
  IF NOT FOUND OR convo.contact_id IS NOT NULL OR convo.visitor_email IS NULL THEN
    RETURN convo.contact_id;
  END IF;
  SELECT c.id INTO v_found FROM crm.contacts c
    WHERE c.tenant_id = convo.tenant_id AND lower(c.email) = lower(convo.visitor_email)
    ORDER BY c.created_at, c.id LIMIT 1;
  IF v_found IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE chat.conversations SET contact_id = v_found WHERE id = convo.id;
  IF convo.campaign IS NOT NULL THEN
    UPDATE crm.contacts SET campaign = convo.campaign
      WHERE id = v_found AND nullif(btrim(coalesce(campaign, '')), '') IS NULL;
  END IF;
  RETURN v_found;
END;
$$;
REVOKE EXECUTE ON FUNCTION chat.match_contact(UUID) FROM PUBLIC, anon, authenticated;

-- A short transcript: "Who: text" per line, the last 60 messages, at most 4000 characters
CREATE OR REPLACE FUNCTION chat.transcript(p_conversation UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT left(coalesce(string_agg(
      CASE m.sender WHEN 'visitor' THEN chat.visitor_label(c) WHEN 'bot' THEN 'Bot' ELSE 'Team' END || ': ' || m.body,
      E'\n' ORDER BY m.id), 'No messages'), 4000)
  FROM chat.conversations c
  LEFT JOIN LATERAL (
    SELECT * FROM chat.messages WHERE conversation_id = c.id AND sender <> 'system' ORDER BY id DESC LIMIT 60
  ) m ON true
  WHERE c.id = p_conversation;
$$;
REVOKE EXECUTE ON FUNCTION chat.transcript(UUID) FROM PUBLIC, anon, authenticated;

-- Writes the chat's one "Website chat" note on its contact and/or lead, or updates it if it is
-- already there. A note left with neither (the contact was unlinked) is removed.
CREATE OR REPLACE FUNCTION chat.write_activity(p_conversation UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  convo chat.conversations;
  v_body TEXT;
  v_owner UUID;
  made UUID;
BEGIN
  SELECT * INTO convo FROM chat.conversations WHERE id = p_conversation;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF convo.activity_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM crm.activities WHERE id = convo.activity_id AND tenant_id = convo.tenant_id
  ) THEN
    convo.activity_id := NULL;
  END IF;

  IF convo.contact_id IS NULL AND convo.lead_id IS NULL THEN
    IF convo.activity_id IS NOT NULL THEN
      DELETE FROM crm.activities WHERE id = convo.activity_id AND tenant_id = convo.tenant_id;
      UPDATE chat.conversations SET activity_id = NULL WHERE id = convo.id;
    END IF;
    RETURN NULL;
  END IF;

  v_body := chat.transcript(convo.id);
  IF convo.activity_id IS NOT NULL THEN
    UPDATE crm.activities SET body = v_body, contact_id = convo.contact_id, lead_id = convo.lead_id
      WHERE id = convo.activity_id;
    made := convo.activity_id;
  ELSE
    v_owner := CASE WHEN EXISTS (SELECT 1 FROM public.tenant_members WHERE tenant_id = convo.tenant_id AND user_id = convo.assigned_to)
      THEN convo.assigned_to ELSE auth.uid() END;
    INSERT INTO crm.activities (tenant_id, kind, subject, body, contact_id, lead_id, owner_id)
      VALUES (convo.tenant_id, 'note', 'Website chat', v_body, convo.contact_id, convo.lead_id, v_owner)
      RETURNING id INTO made;
  END IF;
  UPDATE chat.conversations SET activity_id = made WHERE id = convo.id AND activity_id IS DISTINCT FROM made;
  RETURN made;
END;
$$;
REVOKE EXECUTE ON FUNCTION chat.write_activity(UUID) FROM PUBLIC, anon, authenticated;

-- Staff link a chat to a contact (or unlink it with no contact). Viewers can't.
CREATE OR REPLACE FUNCTION chat.link_contact(p_tenant UUID, p_conversation UUID, p_contact UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  convo chat.conversations := chat.staff_conversation(p_tenant, p_conversation);
  picked crm.contacts;
BEGIN
  IF p_contact IS NOT NULL THEN
    SELECT * INTO picked FROM crm.contacts WHERE id = p_contact AND tenant_id = p_tenant;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Contact not found';
    END IF;
  END IF;
  IF convo.contact_id IS NOT DISTINCT FROM p_contact THEN
    RETURN json_build_object('contact_id', p_contact, 'contact_name', picked.name);
  END IF;

  UPDATE chat.conversations SET contact_id = p_contact WHERE id = convo.id;
  IF p_contact IS NOT NULL AND convo.campaign IS NOT NULL AND nullif(btrim(coalesce(picked.campaign, '')), '') IS NULL THEN
    UPDATE crm.contacts SET campaign = convo.campaign WHERE id = p_contact;
  END IF;
  -- A closed chat goes on the timeline now; an open one when it is closed
  IF convo.status = 'closed' OR convo.activity_id IS NOT NULL THEN
    PERFORM chat.write_activity(convo.id);
  END IF;
  RETURN json_build_object('contact_id', p_contact, 'contact_name', picked.name);
END;
$$;
REVOKE EXECUTE ON FUNCTION chat.link_contact(UUID, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.link_contact(UUID, UUID, UUID) TO authenticated;

-- Closing a chat now also writes its note on the CRM timeline
CREATE OR REPLACE FUNCTION chat.set_status(p_tenant uuid, p_conversation uuid, p_status text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  convo chat.conversations := chat.staff_conversation(p_tenant, p_conversation);
BEGIN
  IF p_status NOT IN ('open', 'closed') THEN
    RAISE EXCEPTION 'Choose open or closed';
  END IF;
  IF p_status = convo.status THEN
    RETURN json_build_object('status', p_status);
  END IF;
  IF p_status = 'closed' THEN
    INSERT INTO chat.messages (conversation_id, tenant_id, sender, author_id, body)
      VALUES (convo.id, p_tenant, 'system', auth.uid(), 'This chat was closed. You can still send a message if you need more help.');
    UPDATE chat.conversations SET status = 'closed', closed_at = now(), staff_unread = 0 WHERE id = convo.id;
    PERFORM chat.write_activity(convo.id);
  ELSE
    UPDATE chat.conversations SET status = 'open', closed_at = NULL, alert_round = alert_round + 1 WHERE id = convo.id;
  END IF;
  RETURN json_build_object('status', p_status);
END;
$$;

-- Making a lead: as before, plus the campaign, and the chat's "Website chat" note goes on the lead
-- (it replaces the separate "Chatted on the website" note an earlier lead used to get).
CREATE OR REPLACE FUNCTION chat.make_lead(p_tenant uuid, p_conversation uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  convo chat.conversations := chat.staff_conversation(p_tenant, p_conversation);
  transcript TEXT;
  earlier crm.leads;
  v_owner UUID;
  made UUID;
BEGIN
  IF convo.lead_id IS NOT NULL AND EXISTS (SELECT 1 FROM crm.leads WHERE id = convo.lead_id AND tenant_id = p_tenant) THEN
    RETURN json_build_object('lead_id', convo.lead_id, 'existing', true);
  END IF;
  IF convo.visitor_email IS NULL THEN
    RAISE EXCEPTION 'Ask the visitor for their email first';
  END IF;

  SELECT left(string_agg(
      CASE m.sender WHEN 'visitor' THEN 'Visitor: ' WHEN 'bot' THEN 'Bot: ' WHEN 'staff' THEN 'Team: ' ELSE '' END || m.body,
      E'\n' ORDER BY m.id), 4000)
    INTO transcript
    FROM (SELECT * FROM chat.messages WHERE conversation_id = convo.id AND sender <> 'system' ORDER BY id DESC LIMIT 40) m;
  transcript := 'From the website chat' || coalesce(E':\n' || transcript, '');

  v_owner := CASE WHEN EXISTS (SELECT 1 FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = convo.assigned_to)
    THEN convo.assigned_to ELSE auth.uid() END;

  SELECT * INTO earlier FROM crm.leads l
    WHERE l.tenant_id = p_tenant AND l.email = lower(convo.visitor_email) AND l.status IN ('new', 'working')
    ORDER BY l.created_at LIMIT 1;

  PERFORM set_config('crm.trusted', 'on', true);
  IF earlier.id IS NOT NULL THEN
    IF convo.campaign IS NOT NULL AND nullif(btrim(coalesce(earlier.campaign, '')), '') IS NULL THEN
      UPDATE crm.leads SET campaign = convo.campaign WHERE id = earlier.id;
    END IF;
    made := earlier.id;
  ELSE
    INSERT INTO crm.leads (tenant_id, name, email, notes, source, owner_id, from_form, campaign)
      VALUES (p_tenant, coalesce(nullif(btrim(convo.visitor_name), ''), split_part(convo.visitor_email, '@', 1)),
        convo.visitor_email, transcript, 'Chat', v_owner, false, convo.campaign)
      RETURNING id INTO made;
  END IF;
  PERFORM set_config('crm.trusted', 'off', true);

  UPDATE chat.conversations SET lead_id = made WHERE id = convo.id;
  PERFORM chat.write_activity(convo.id);
  RETURN json_build_object('lead_id', made, 'existing', earlier.id IS NOT NULL);
END;
$$;

-- Visitors: the chat keeps the campaign from the link they came in by, and is linked to the
-- contact with their email
CREATE OR REPLACE FUNCTION public.chat_start(p_key text, p_visitor jsonb)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  setting chat.settings;
  v_name TEXT := nullif(btrim(coalesce(p_visitor->>'name', '')), '');
  v_email TEXT := chat.check_email(p_visitor->>'email');
  v_page TEXT := nullif(left(btrim(coalesce(p_visitor->>'page', '')), 500), '');
  v_campaign TEXT := chat.clean_campaign(p_visitor->>'campaign');
  v_token TEXT := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  made UUID;
BEGIN
  SELECT * INTO setting FROM chat.settings WHERE public_key = p_key AND enabled;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This chat is not available';
  END IF;
  IF char_length(coalesce(v_name, '')) > 100 THEN
    RAISE EXCEPTION 'Names can be up to 100 characters';
  END IF;
  PERFORM chat.use_quota(setting.tenant_id, 'conversation');

  INSERT INTO chat.conversations (tenant_id, token, visitor_name, visitor_email, started_on, campaign)
    VALUES (setting.tenant_id, v_token, v_name, v_email, v_page, v_campaign) RETURNING id INTO made;
  IF v_email IS NOT NULL THEN
    PERFORM chat.match_contact(made);
  END IF;
  IF setting.welcome_message <> '' THEN
    INSERT INTO chat.messages (conversation_id, tenant_id, sender, body) VALUES (made, setting.tenant_id, 'bot', setting.welcome_message);
  END IF;
  RETURN (jsonb_build_object('token', v_token) || chat.visitor_state(made, 0)::jsonb)::json;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_contact(p_key text, p_token text, p_name text, p_email text, p_after bigint)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  convo chat.conversations := chat.visitor_conversation(p_key, p_token);
  v_name TEXT := nullif(btrim(coalesce(p_name, '')), '');
  v_email TEXT := chat.check_email(p_email);
BEGIN
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'Enter your email';
  END IF;
  IF char_length(coalesce(v_name, '')) > 100 THEN
    RAISE EXCEPTION 'Names can be up to 100 characters';
  END IF;
  PERFORM chat.use_quota(convo.tenant_id, 'message');
  UPDATE chat.conversations SET visitor_name = coalesce(v_name, visitor_name), visitor_email = v_email
    WHERE id = convo.id;
  PERFORM chat.match_contact(convo.id);
  INSERT INTO chat.messages (conversation_id, tenant_id, sender, body)
    VALUES (convo.id, convo.tenant_id, 'system', 'Thanks. Someone will reply here soon. If you leave, we can reach you at ' || v_email || '.');
  RETURN chat.visitor_state(convo.id, p_after);
END;
$$;

-- ---------- Web form: campaign ----------
CREATE OR REPLACE FUNCTION public.capture_lead(p_key text, p_lead jsonb)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  setting crm.lead_settings;
  visitor TEXT := trim(coalesce(p_lead->>'name', ''));
  address TEXT := lower(trim(coalesce(p_lead->>'email', '')));
  phone_number TEXT := trim(coalesce(p_lead->>'phone', ''));
  business TEXT := trim(coalesce(p_lead->>'company', ''));
  message TEXT := nullif(trim(coalesce(p_lead->>'message', '')), '');
  v_campaign TEXT := nullif(left(btrim(coalesce(p_lead->>'campaign', '')), 100), '');
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
    -- The first campaign that brought them in stays
    IF v_campaign IS NOT NULL AND nullif(btrim(coalesce(earlier.campaign, '')), '') IS NULL THEN
      UPDATE crm.leads SET campaign = v_campaign WHERE id = earlier.id;
    END IF;
  ELSE
    INSERT INTO crm.leads (tenant_id, name, email, phone, company_name, notes, source, from_form, campaign)
      VALUES (setting.tenant_id, visitor, nullif(address, ''), nullif(phone_number, ''), nullif(business, ''), message, setting.form_source, true, v_campaign);
  END IF;

  RETURN json_build_object('thanks', setting.form_thanks);
END;
$$;

-- ---------- Social: results per campaign ----------
-- Campaign names match without regard to case or spaces at the ends; the most used spelling is shown
CREATE OR REPLACE FUNCTION social.campaign_results(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF social.role_in(p_tenant) IS NULL THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  RETURN coalesce((
    WITH posts AS (
      SELECT lower(btrim(p.campaign)) AS k, mode() WITHIN GROUP (ORDER BY btrim(p.campaign)) AS name, count(*) AS total,
        count(*) FILTER (WHERE p.status = 'posted' OR EXISTS (
          SELECT 1 FROM social.post_targets t WHERE t.post_id = p.id AND t.posted_at IS NOT NULL)) AS posted
      FROM social.posts p WHERE p.tenant_id = p_tenant AND nullif(btrim(coalesce(p.campaign, '')), '') IS NOT NULL
      GROUP BY 1
    ), leads AS (
      SELECT lower(btrim(campaign)) AS k, mode() WITHIN GROUP (ORDER BY btrim(campaign)) AS name, count(*) AS n
      FROM crm.leads WHERE tenant_id = p_tenant AND nullif(btrim(coalesce(campaign, '')), '') IS NOT NULL GROUP BY 1
    ), contacts AS (
      SELECT lower(btrim(campaign)) AS k, mode() WITHIN GROUP (ORDER BY btrim(campaign)) AS name, count(*) AS n
      FROM crm.contacts WHERE tenant_id = p_tenant AND nullif(btrim(coalesce(campaign, '')), '') IS NOT NULL GROUP BY 1
    ), chats AS (
      SELECT lower(btrim(campaign)) AS k, mode() WITHIN GROUP (ORDER BY btrim(campaign)) AS name, count(*) AS n
      FROM chat.conversations WHERE tenant_id = p_tenant AND nullif(btrim(coalesce(campaign, '')), '') IS NOT NULL GROUP BY 1
    ), won AS (
      SELECT lower(btrim(c.campaign)) AS k, count(*) AS n, coalesce(sum(d.value), 0) AS value
      FROM crm.deals d
      JOIN crm.contacts c ON c.id = d.contact_id AND c.tenant_id = p_tenant
      JOIN crm.stages s ON s.id = d.stage_id
      WHERE d.tenant_id = p_tenant AND s.kind = 'won' AND nullif(btrim(coalesce(c.campaign, '')), '') IS NOT NULL
      GROUP BY 1
    ), names AS (
      SELECT k FROM posts UNION SELECT k FROM leads UNION SELECT k FROM contacts UNION SELECT k FROM chats
    ), results AS (
      SELECT coalesce(p.name, l.name, c.name, ch.name) AS name, p.k IS NOT NULL AS has_posts,
        coalesce(p.total, 0) AS posts, coalesce(p.posted, 0) AS posted,
        coalesce(l.n, 0) AS leads, coalesce(c.n, 0) AS contacts, coalesce(ch.n, 0) AS chats,
        coalesce(w.n, 0) AS won_deals, coalesce(w.value, 0) AS won_value
      FROM names x
      LEFT JOIN posts p ON p.k = x.k LEFT JOIN leads l ON l.k = x.k LEFT JOIN contacts c ON c.k = x.k
      LEFT JOIN chats ch ON ch.k = x.k LEFT JOIN won w ON w.k = x.k
      ORDER BY (p.k IS NULL), lower(coalesce(p.name, l.name, c.name, ch.name))
      LIMIT 200
    )
    SELECT json_agg(row_to_json(r) ORDER BY NOT r.has_posts, lower(r.name)) FROM results r
  ), '[]'::json);
END;
$$;
REVOKE EXECUTE ON FUNCTION social.campaign_results(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION social.campaign_results(UUID) TO authenticated;
