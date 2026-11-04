-- WhatsApp in the chat inbox, through the WhatsApp Business Cloud API.
-- * Each company saves its WhatsApp phone number id in chat settings. Incoming messages for that
--   number land in that company's inbox, as chats with channel 'whatsapp'.
-- * Meta signs every webhook with the app secret (X-Hub-Signature-256). The gateway checks it, and
--   public.whatsapp_receive checks it again here with the same secret, kept in Supabase Vault
--   under the name 'whatsapp_app_secret'. Without that secret nothing is accepted.
-- * Each WhatsApp message id is saved once, so Meta's retries never repeat a message.
-- * Staff replies are sent by chatbot-service. It records WhatsApp's message id, or why sending
--   failed, with chat.whatsapp_sent. Delivery updates from Meta (delivered, read, failed) are kept
--   on the message.
-- * chat.booking_link_token gives staff who can manage bookings the customer's own
--   reschedule/cancel link, to send in a WhatsApp reminder.

-- =====================================================================================
-- Columns
-- =====================================================================================
ALTER TABLE chat.settings
  ADD COLUMN whatsapp_phone_number_id TEXT CHECK (whatsapp_phone_number_id ~ '^[0-9]{5,30}$'),
  ADD COLUMN whatsapp_last_received_at TIMESTAMPTZ;
CREATE UNIQUE INDEX idx_chat_settings_whatsapp ON chat.settings (whatsapp_phone_number_id)
  WHERE whatsapp_phone_number_id IS NOT NULL;

ALTER TABLE chat.conversations
  ADD COLUMN channel TEXT NOT NULL DEFAULT 'web' CHECK (channel IN ('web', 'whatsapp')),
  ADD COLUMN visitor_phone TEXT CHECK (visitor_phone ~ '^[0-9]{5,20}$'),
  -- When the customer last wrote on WhatsApp. Free-form replies are allowed for 24 hours after it.
  ADD COLUMN last_visitor_at TIMESTAMPTZ;
CREATE INDEX idx_chat_conversations_whatsapp ON chat.conversations (tenant_id, visitor_phone, last_message_at DESC)
  WHERE channel = 'whatsapp';
GRANT SELECT (channel, visitor_phone, last_visitor_at) ON chat.conversations TO authenticated;

ALTER TABLE chat.messages
  ADD COLUMN external_id TEXT CHECK (char_length(external_id) <= 200),
  ADD COLUMN wa_status TEXT CHECK (wa_status IN ('sent', 'delivered', 'read', 'failed')),
  ADD COLUMN send_error TEXT CHECK (char_length(send_error) <= 300);
CREATE UNIQUE INDEX idx_chat_messages_external ON chat.messages (tenant_id, external_id) WHERE external_id IS NOT NULL;

-- =====================================================================================
-- Helpers
-- =====================================================================================
CREATE FUNCTION chat.phone_digits(p_value TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT nullif(regexp_replace(coalesce(p_value, ''), '[^0-9]', '', 'g'), '');
$$;

-- What a WhatsApp message says, in words for the inbox. Anything that isn't text gets a label.
CREATE FUNCTION chat.whatsapp_text(p_message JSONB)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
  kind TEXT := coalesce(p_message->>'type', '');
  caption TEXT := nullif(btrim(coalesce(p_message->kind->>'caption', '')), '');
  label TEXT;
BEGIN
  IF kind = 'text' THEN
    RETURN left(nullif(btrim(coalesce(p_message->'text'->>'body', '')), ''), 4000);
  END IF;
  IF kind = 'button' THEN
    RETURN left(nullif(btrim(coalesce(p_message->'button'->>'text', '')), ''), 4000);
  END IF;
  IF kind = 'interactive' THEN
    RETURN left(coalesce(nullif(p_message->'interactive'->'button_reply'->>'title', ''),
      nullif(p_message->'interactive'->'list_reply'->>'title', ''), '[choice]'), 4000);
  END IF;
  label := CASE kind
    WHEN 'image' THEN '[photo]'
    WHEN 'video' THEN '[video]'
    WHEN 'audio' THEN CASE WHEN (p_message->'audio'->>'voice')::boolean THEN '[voice message]' ELSE '[audio]' END
    WHEN 'document' THEN '[document' || coalesce(': ' || nullif(p_message->'document'->>'filename', ''), '') || ']'
    WHEN 'sticker' THEN '[sticker]'
    WHEN 'location' THEN '[location' || coalesce(': ' || nullif(p_message->'location'->>'name', ''), '') || ']'
    WHEN 'contacts' THEN '[contact card]'
    WHEN 'reaction' THEN '[reaction ' || coalesce(nullif(p_message->'reaction'->>'emoji', ''), 'removed') || ']'
    ELSE '[message WhatsApp can''t show here]'
  END;
  RETURN left(label || coalesce(' ' || caption, ''), 4000);
END;
$$;

-- One incoming WhatsApp message for a company. Returns 'received', 'duplicate' or 'ignored'.
CREATE FUNCTION chat.whatsapp_message(p_setting chat.settings, p_message JSONB, p_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  wamid TEXT := left(nullif(p_message->>'id', ''), 200);
  v_phone TEXT := chat.phone_digits(p_message->>'from');
  v_body TEXT := chat.whatsapp_text(p_message);
  v_name TEXT := nullif(left(btrim(coalesce(p_name, '')), 100), '');
  sent_at TIMESTAMPTZ;
  convo chat.conversations;
  v_contact UUID;
  saved BIGINT;
BEGIN
  IF wamid IS NULL OR v_phone IS NULL OR char_length(v_phone) NOT BETWEEN 5 AND 20 OR v_body IS NULL THEN
    RETURN 'ignored';
  END IF;
  IF EXISTS (SELECT 1 FROM chat.messages WHERE tenant_id = p_setting.tenant_id AND external_id = wamid) THEN
    RETURN 'duplicate';
  END IF;
  sent_at := CASE WHEN coalesce(p_message->>'timestamp', '') ~ '^[0-9]{9,11}$'
    THEN least(to_timestamp((p_message->>'timestamp')::bigint), now()) ELSE now() END;

  -- The customer's chat that is still going, or a new one
  SELECT * INTO convo FROM chat.conversations
    WHERE tenant_id = p_setting.tenant_id AND channel = 'whatsapp' AND visitor_phone = v_phone AND status <> 'closed'
    ORDER BY last_message_at DESC LIMIT 1
    FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM chat.use_quota(p_setting.tenant_id, 'conversation');
    -- The same phone number on a CRM contact links the chat to them
    SELECT c.id INTO v_contact FROM crm.contacts c
      WHERE c.tenant_id = p_setting.tenant_id AND chat.phone_digits(c.phone) IS NOT NULL
        AND (chat.phone_digits(c.phone) = v_phone
          OR (char_length(ltrim(chat.phone_digits(c.phone), '0')) >= 7 AND right(v_phone, char_length(ltrim(chat.phone_digits(c.phone), '0'))) = ltrim(chat.phone_digits(c.phone), '0')))
      ORDER BY c.created_at, c.id LIMIT 1;
    INSERT INTO chat.conversations (tenant_id, token, channel, visitor_name, visitor_phone, started_on, contact_id, status)
      VALUES (p_setting.tenant_id, encode(extensions.gen_random_bytes(32), 'hex'), 'whatsapp', v_name, v_phone, 'WhatsApp', v_contact, 'waiting')
      RETURNING * INTO convo;
  END IF;
  PERFORM chat.use_quota(p_setting.tenant_id, 'message');

  INSERT INTO chat.messages (conversation_id, tenant_id, sender, body, external_id)
    VALUES (convo.id, p_setting.tenant_id, 'visitor', v_body, wamid)
    ON CONFLICT (tenant_id, external_id) WHERE external_id IS NOT NULL DO NOTHING
    RETURNING id INTO saved;
  IF saved IS NULL THEN
    RETURN 'duplicate';
  END IF;

  -- There is no bot on WhatsApp: every message waits for a person
  UPDATE chat.conversations SET status = 'waiting', wants_person = true, closed_at = NULL,
    visitor_name = coalesce(visitor_name, v_name),
    staff_unread = staff_unread + 1, visitor_messages = visitor_messages + 1,
    last_message = left(v_body, 200), last_message_at = now(),
    last_visitor_at = greatest(coalesce(last_visitor_at, sent_at), sent_at)
  WHERE id = convo.id RETURNING * INTO convo;
  UPDATE chat.settings SET whatsapp_last_received_at = now() WHERE tenant_id = p_setting.tenant_id;

  PERFORM chat.alert_staff(convo,
    coalesce(convo.visitor_name, '+' || v_phone) || ' sent a WhatsApp message', v_body);
  RETURN 'received';
END;
$$;

-- =====================================================================================
-- Incoming webhook, called by chatbot-service with Meta's raw body and signature
-- =====================================================================================
CREATE FUNCTION public.whatsapp_receive(p_body TEXT, p_signature TEXT)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  app_secret TEXT;
  payload JSONB;
  entry JSONB;
  change JSONB;
  v_value JSONB;
  msg JSONB;
  st JSONB;
  setting chat.settings;
  names JSONB;
  outcome TEXT;
  received INT := 0;
  duplicates INT := 0;
  ignored INT := 0;
  rank_of JSONB := '{"sent": 1, "delivered": 2, "read": 3, "failed": 4}';
BEGIN
  IF p_body IS NULL OR octet_length(p_body) > 1000000 THEN
    RAISE EXCEPTION 'That is too large';
  END IF;
  SELECT decrypted_secret INTO app_secret FROM vault.decrypted_secrets WHERE name = 'whatsapp_app_secret' LIMIT 1;
  IF coalesce(app_secret, '') = '' THEN
    RAISE EXCEPTION 'WhatsApp is not set up: save the app secret in Supabase Vault as whatsapp_app_secret';
  END IF;
  IF coalesce(p_signature, '') <> 'sha256=' || encode(extensions.hmac(convert_to(p_body, 'UTF8'), convert_to(app_secret, 'UTF8'), 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'The signature does not match';
  END IF;
  BEGIN
    payload := p_body::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'That is not a WhatsApp message';
  END;
  IF jsonb_typeof(payload->'entry') <> 'array' THEN
    RETURN json_build_object('received', 0, 'duplicates', 0, 'ignored', 0);
  END IF;

  FOR entry IN SELECT * FROM jsonb_array_elements(payload->'entry') LOOP
    CONTINUE WHEN jsonb_typeof(entry->'changes') IS DISTINCT FROM 'array';
    FOR change IN SELECT * FROM jsonb_array_elements(entry->'changes') LOOP
      v_value := change->'value';
      CONTINUE WHEN coalesce(change->>'field', 'messages') <> 'messages' OR jsonb_typeof(v_value) IS DISTINCT FROM 'object';
      SELECT * INTO setting FROM chat.settings WHERE whatsapp_phone_number_id = v_value->'metadata'->>'phone_number_id';
      IF NOT FOUND THEN
        ignored := ignored + CASE WHEN jsonb_typeof(v_value->'messages') = 'array' THEN jsonb_array_length(v_value->'messages') ELSE 0 END;
        CONTINUE;
      END IF;

      -- The customer's WhatsApp profile name, by their WhatsApp id
      SELECT coalesce(jsonb_object_agg(c.item->>'wa_id', c.item->'profile'->>'name') FILTER (WHERE c.item->>'wa_id' IS NOT NULL), '{}')
        INTO names FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_value->'contacts') = 'array' THEN v_value->'contacts' ELSE '[]' END) AS c(item);

      IF jsonb_typeof(v_value->'messages') = 'array' THEN
        FOR msg IN SELECT * FROM jsonb_array_elements(v_value->'messages') LOOP
          BEGIN
            outcome := chat.whatsapp_message(setting, msg, names->>(msg->>'from'));
          EXCEPTION WHEN raise_exception THEN
            -- Our own limits (too many chats today): retrying would not help
            outcome := 'ignored';
          END;
          received := received + (outcome = 'received')::int;
          duplicates := duplicates + (outcome = 'duplicate')::int;
          ignored := ignored + (outcome = 'ignored')::int;
        END LOOP;
      END IF;

      -- Delivery updates for replies we sent. A status never moves backwards.
      IF jsonb_typeof(v_value->'statuses') = 'array' THEN
        FOR st IN SELECT * FROM jsonb_array_elements(v_value->'statuses') LOOP
          CONTINUE WHEN NOT rank_of ? coalesce(st->>'status', '') OR nullif(st->>'id', '') IS NULL;
          UPDATE chat.messages m SET wa_status = st->>'status',
            send_error = CASE WHEN st->>'status' = 'failed'
              THEN left(coalesce(st->'errors'->0->'error_data'->>'details', st->'errors'->0->>'title', 'WhatsApp could not deliver it'), 300)
              ELSE m.send_error END
          WHERE m.tenant_id = setting.tenant_id AND m.external_id = left(st->>'id', 200) AND m.sender = 'staff'
            AND coalesce((rank_of->>m.wa_status)::int, 0) < (rank_of->>(st->>'status'))::int;
        END LOOP;
      END IF;
    END LOOP;
  END LOOP;
  RETURN json_build_object('received', received, 'duplicates', duplicates, 'ignored', ignored);
END;
$$;

-- =====================================================================================
-- Staff side
-- =====================================================================================
-- After chatbot-service sent a reply (or could not), it records WhatsApp's id or the reason
CREATE FUNCTION chat.whatsapp_sent(p_tenant UUID, p_message BIGINT, p_wamid TEXT, p_error TEXT)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  saved chat.messages;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  UPDATE chat.messages m SET
    external_id = CASE WHEN p_error IS NULL THEN left(nullif(btrim(coalesce(p_wamid, '')), ''), 200) ELSE m.external_id END,
    wa_status = CASE WHEN p_error IS NULL THEN 'sent' ELSE 'failed' END,
    send_error = CASE WHEN p_error IS NULL THEN NULL ELSE left(p_error, 300) END
  FROM chat.conversations c
  WHERE m.id = p_message AND m.tenant_id = p_tenant AND m.sender = 'staff' AND m.author_id = auth.uid()
    AND c.id = m.conversation_id AND c.channel = 'whatsapp'
  RETURNING m.* INTO saved;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Message not found';
  END IF;
  RETURN json_build_object('id', saved.id, 'wa_status', saved.wa_status, 'send_error', saved.send_error);
END;
$$;

-- Whether WhatsApp can receive messages for this company, for the settings page
CREATE FUNCTION chat.whatsapp_status(p_tenant UUID)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  setting chat.settings;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  SELECT * INTO setting FROM chat.settings WHERE tenant_id = p_tenant;
  RETURN json_build_object(
    'phone_number_id', setting.whatsapp_phone_number_id,
    'last_received_at', setting.whatsapp_last_received_at,
    'secret_saved', EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'whatsapp_app_secret'));
END;
$$;

-- The customer's own reschedule/cancel link for a booking, for staff who manage bookings
CREATE FUNCTION chat.booking_link_token(p_tenant UUID, p_booking UUID)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  found_token TEXT;
BEGIN
  PERFORM scheduler.require_staff(p_tenant);
  SELECT k.token INTO found_token FROM scheduler.booking_tokens k
    JOIN scheduler.bookings b ON b.id = k.booking_id
    WHERE b.id = p_booking AND b.tenant_id = p_tenant AND b.status = 'booked';
  IF found_token IS NULL THEN
    RAISE EXCEPTION 'Booking not found';
  END IF;
  RETURN json_build_object('token', found_token);
END;
$$;

-- Saving settings also takes the WhatsApp phone number id (empty disconnects it)
CREATE OR REPLACE FUNCTION chat.save_settings(p_tenant uuid, p_data jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  saved chat.settings;
  v_hours JSONB;
  v_sla JSONB;
  v_whatsapp TEXT;
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  IF char_length(coalesce(p_data->>'welcome_message', '')) > 500 OR char_length(coalesce(p_data->>'handoff_message', '')) > 500
     OR char_length(coalesce(p_data->>'offline_message', '')) > 500 THEN
    RAISE EXCEPTION 'Messages can be up to 500 characters';
  END IF;
  IF char_length(coalesce(p_data->>'opening_hours', '')) > 200 THEN
    RAISE EXCEPTION 'Opening hours can be up to 200 characters';
  END IF;
  IF p_data ? 'colour' AND coalesce(p_data->>'colour', '') !~ '^#[0-9a-fA-F]{6}$' THEN
    RAISE EXCEPTION 'Choose a colour';
  END IF;
  IF p_data ? 'handoff_message' AND btrim(coalesce(p_data->>'handoff_message', '')) = '' THEN
    RAISE EXCEPTION 'Enter what the bot says when it hands over to a person';
  END IF;
  IF p_data ? 'offline_message' AND btrim(coalesce(p_data->>'offline_message', '')) = '' THEN
    RAISE EXCEPTION 'Enter what the chat says when your team is away';
  END IF;
  IF p_data ? 'hours_timezone' AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = btrim(coalesce(p_data->>'hours_timezone', ''))
  ) THEN
    RAISE EXCEPTION 'Choose a valid time zone';
  END IF;
  IF p_data ? 'weekly_hours' THEN
    v_hours := chat.check_hours(p_data->'weekly_hours');
  END IF;
  IF p_data ? 'sla_hours' THEN
    v_sla := chat.check_sla(p_data->'sla_hours');
  END IF;
  IF p_data ? 'whatsapp_phone_number_id' THEN
    v_whatsapp := nullif(btrim(coalesce(p_data->>'whatsapp_phone_number_id', '')), '');
    IF v_whatsapp IS NOT NULL AND v_whatsapp !~ '^[0-9]{5,30}$' THEN
      RAISE EXCEPTION 'The phone number ID is the long number from Meta''s WhatsApp setup page, digits only';
    END IF;
    IF v_whatsapp IS NOT NULL AND EXISTS (
      SELECT 1 FROM chat.settings WHERE whatsapp_phone_number_id = v_whatsapp AND tenant_id <> p_tenant
    ) THEN
      RAISE EXCEPTION 'That WhatsApp number is already connected to another company';
    END IF;
  END IF;
  UPDATE chat.settings SET
    enabled = coalesce((p_data->>'enabled')::boolean, enabled),
    bot_enabled = coalesce((p_data->>'bot_enabled')::boolean, bot_enabled),
    welcome_message = CASE WHEN p_data ? 'welcome_message' THEN btrim(coalesce(p_data->>'welcome_message', '')) ELSE welcome_message END,
    handoff_message = CASE WHEN p_data ? 'handoff_message' THEN btrim(p_data->>'handoff_message') ELSE handoff_message END,
    opening_hours = CASE WHEN p_data ? 'opening_hours' THEN btrim(coalesce(p_data->>'opening_hours', '')) ELSE opening_hours END,
    colour = CASE WHEN p_data ? 'colour' THEN lower(p_data->>'colour') ELSE colour END,
    hours_enabled = coalesce((p_data->>'hours_enabled')::boolean, hours_enabled),
    hours_timezone = CASE WHEN p_data ? 'hours_timezone' THEN btrim(p_data->>'hours_timezone') ELSE hours_timezone END,
    weekly_hours = coalesce(v_hours, weekly_hours),
    offline_message = CASE WHEN p_data ? 'offline_message' THEN btrim(p_data->>'offline_message') ELSE offline_message END,
    ask_rating = coalesce((p_data->>'ask_rating')::boolean, ask_rating),
    sla_hours = coalesce(v_sla, sla_hours),
    whatsapp_phone_number_id = CASE WHEN p_data ? 'whatsapp_phone_number_id' THEN v_whatsapp ELSE whatsapp_phone_number_id END,
    updated_at = now()
  WHERE tenant_id = p_tenant RETURNING * INTO saved;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  RETURN row_to_json(saved);
END;
$function$;

-- =====================================================================================
-- Grants: helpers stay closed, staff functions for signed-in users, the webhook for the gateway path
-- =====================================================================================
REVOKE EXECUTE ON FUNCTION chat.phone_digits(TEXT), chat.whatsapp_text(JSONB),
  chat.whatsapp_message(chat.settings, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION chat.whatsapp_sent(UUID, BIGINT, TEXT, TEXT), chat.whatsapp_status(UUID),
  chat.booking_link_token(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.whatsapp_sent(UUID, BIGINT, TEXT, TEXT), chat.whatsapp_status(UUID),
  chat.booking_link_token(UUID, UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.whatsapp_receive(TEXT, TEXT) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_receive(TEXT, TEXT) TO anon, service_role;
