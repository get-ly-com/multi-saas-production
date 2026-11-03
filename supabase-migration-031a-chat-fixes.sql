-- Chat fixes found in testing. A company's required CRM lead fields can't be known from a chat,
-- so the lead is saved leniently, the same way the public web form saves leads.
CREATE OR REPLACE FUNCTION chat.make_lead(p_tenant UUID, p_conversation UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
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
    INSERT INTO crm.activities (tenant_id, kind, subject, body, lead_id, owner_id)
      VALUES (p_tenant, 'note', 'Chatted on the website', transcript, earlier.id, earlier.owner_id);
    made := earlier.id;
  ELSE
    INSERT INTO crm.leads (tenant_id, name, email, notes, source, owner_id, from_form)
      VALUES (p_tenant, coalesce(nullif(btrim(convo.visitor_name), ''), split_part(convo.visitor_email, '@', 1)),
        convo.visitor_email, transcript, 'Chat', v_owner, false)
      RETURNING id INTO made;
  END IF;
  PERFORM set_config('crm.trusted', 'off', true);

  UPDATE chat.conversations SET lead_id = made WHERE id = convo.id;
  RETURN json_build_object('lead_id', made, 'existing', earlier.id IS NOT NULL);
END;
$$;

REVOKE EXECUTE ON FUNCTION chat.make_lead(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.make_lead(uuid, uuid) TO authenticated;
