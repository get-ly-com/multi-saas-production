-- Chat and social media, closer to Odoo's Live Chat, Helpdesk and Social Marketing. Nothing here
-- needs an outside service.
-- Chat:
-- * Saved replies: staff type "/" and a shortcut in the reply box to insert a prepared answer.
-- * Opening hours by weekday in the company's time zone. Outside them the chat page says the team
--   is away, and the bot asks for a name and email with the away message.
-- * Visitors rate a chat (1 to 5, with an optional comment) once it is closed. A low rating alerts
--   the person who had the chat. Ratings are summed up per person.
-- * "Typing..." both ways, and "Seen" on the visitor's side, by the checks the pages already make.
-- * Tickets: a chat, or a request staff type in, becomes a ticket with a number, status, priority,
--   person looking after it, a due time from the company's response targets, and a notes log.
-- Social:
-- * A content library of saved text and hashtag sets to insert into posts.
-- * Copying a post, and repeating it daily, weekly or monthly (up to 12 at a time). Copies share
--   the image, so an image is only removed once no post uses it.
-- * Comments on a post, so the team can discuss it before approval.
-- * Results typed in from each platform (likes, comments, shares, clicks, views), and best times to
--   post worked out from the company's own posted history.

-- =====================================================================================
-- CHAT
-- =====================================================================================

ALTER TABLE chat.settings
  ADD COLUMN IF NOT EXISTS hours_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hours_timezone TEXT NOT NULL DEFAULT 'UTC' CHECK (char_length(hours_timezone) BETWEEN 1 AND 64),
  -- Monday first; each day is {"from": "HH:MM", "to": "HH:MM"} or null for closed
  ADD COLUMN IF NOT EXISTS weekly_hours JSONB NOT NULL DEFAULT
    '[{"from":"09:00","to":"17:00"},{"from":"09:00","to":"17:00"},{"from":"09:00","to":"17:00"},{"from":"09:00","to":"17:00"},{"from":"09:00","to":"17:00"},null,null]'
    CHECK (jsonb_typeof(weekly_hours) = 'array' AND jsonb_array_length(weekly_hours) = 7),
  ADD COLUMN IF NOT EXISTS offline_message TEXT NOT NULL
    DEFAULT 'We''re away right now. Leave your name and email and we''ll reply as soon as we''re back.'
    CHECK (char_length(btrim(offline_message)) BETWEEN 1 AND 500),
  ADD COLUMN IF NOT EXISTS ask_rating BOOLEAN NOT NULL DEFAULT true,
  -- Hours to deal with a ticket, by priority; 0 means no target
  ADD COLUMN IF NOT EXISTS sla_hours JSONB NOT NULL DEFAULT '{"urgent": 4, "high": 8, "normal": 24, "low": 72}'
    CHECK (jsonb_typeof(sla_hours) = 'object');

ALTER TABLE chat.conversations
  ADD COLUMN IF NOT EXISTS rating SMALLINT CHECK (rating BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS rating_comment TEXT CHECK (char_length(rating_comment) <= 500),
  ADD COLUMN IF NOT EXISTS rated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS visitor_typing_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS staff_typing_at TIMESTAMPTZ,
  -- The newest message staff have seen, for "Seen" on the visitor's page
  ADD COLUMN IF NOT EXISTS staff_read_id BIGINT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_chat_conversations_rated ON chat.conversations (tenant_id, rated_at) WHERE rated_at IS NOT NULL;
GRANT SELECT (rating, rating_comment, rated_at, visitor_typing_at, staff_typing_at, staff_read_id) ON chat.conversations TO authenticated;

-- Saved replies
CREATE TABLE chat.canned_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  shortcut TEXT NOT NULL CHECK (shortcut ~ '^[a-z0-9][a-z0-9_-]{0,29}$'),
  body TEXT NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, shortcut)
);
CREATE INDEX idx_chat_canned_created_by ON chat.canned_replies (created_by);
ALTER TABLE chat.canned_replies ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON chat.canned_replies FOR SELECT TO authenticated USING (chat.is_member(tenant_id));
GRANT SELECT ON chat.canned_replies TO authenticated;

-- Tickets
CREATE TABLE chat.tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  number INT NOT NULL CHECK (number > 0),
  subject TEXT NOT NULL CHECK (char_length(btrim(subject)) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
  -- new; in_progress; waiting: on the customer; solved
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'waiting', 'solved')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES chat.conversations(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES crm.contacts(id) ON DELETE SET NULL,
  customer_name TEXT CHECK (char_length(customer_name) <= 100),
  customer_email TEXT CHECK (char_length(customer_email) <= 254),
  due_at TIMESTAMPTZ,
  solved_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);
CREATE INDEX idx_chat_tickets_list ON chat.tickets (tenant_id, status, due_at);
CREATE INDEX idx_chat_tickets_assigned ON chat.tickets (assigned_to);
CREATE INDEX idx_chat_tickets_conversation ON chat.tickets (conversation_id);
CREATE INDEX idx_chat_tickets_contact ON chat.tickets (contact_id);
CREATE INDEX idx_chat_tickets_created_by ON chat.tickets (created_by);
ALTER TABLE chat.tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON chat.tickets FOR SELECT TO authenticated USING (chat.is_member(tenant_id));
GRANT SELECT ON chat.tickets TO authenticated;

CREATE TABLE chat.ticket_notes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id UUID NOT NULL REFERENCES chat.tickets(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  author_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- note: typed by someone; change: written by the app when status, priority or person changes
  kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'change')),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_ticket_notes_ticket ON chat.ticket_notes (ticket_id, id);
CREATE INDEX idx_chat_ticket_notes_tenant ON chat.ticket_notes (tenant_id);
CREATE INDEX idx_chat_ticket_notes_author ON chat.ticket_notes (author_id);
ALTER TABLE chat.ticket_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON chat.ticket_notes FOR SELECT TO authenticated USING (chat.is_member(tenant_id));
GRANT SELECT ON chat.ticket_notes TO authenticated;

-- ---------- Opening hours ----------

-- Whether the team is in, by the company's weekly hours. With hours off it is always open.
CREATE FUNCTION chat.is_open(p_setting chat.settings)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
DECLARE
  local_now TIMESTAMP;
  day_hours JSONB;
BEGIN
  IF p_setting.tenant_id IS NULL OR NOT p_setting.hours_enabled THEN
    RETURN true;
  END IF;
  local_now := now() AT TIME ZONE p_setting.hours_timezone;
  day_hours := p_setting.weekly_hours -> (extract(isodow FROM local_now)::int - 1);
  IF day_hours IS NULL OR jsonb_typeof(day_hours) <> 'object' THEN
    RETURN false;
  END IF;
  RETURN local_now::time >= (day_hours->>'from')::time AND local_now::time < (day_hours->>'to')::time;
EXCEPTION WHEN others THEN
  -- A broken setting never stops the chat
  RETURN true;
END;
$$;

-- Checks a week of hours from the settings page and gives it back tidy
CREATE FUNCTION chat.check_hours(p_hours JSONB)
RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
  tidy JSONB := '[]'::jsonb;
  day_hours JSONB;
  v_from TEXT;
  v_to TEXT;
BEGIN
  IF jsonb_typeof(p_hours) IS DISTINCT FROM 'array' OR jsonb_array_length(p_hours) <> 7 THEN
    RAISE EXCEPTION 'Give opening hours for each day of the week';
  END IF;
  FOR i IN 0..6 LOOP
    day_hours := p_hours -> i;
    IF day_hours IS NULL OR jsonb_typeof(day_hours) = 'null' THEN
      tidy := tidy || 'null'::jsonb;
      CONTINUE;
    END IF;
    v_from := btrim(coalesce(day_hours->>'from', ''));
    v_to := btrim(coalesce(day_hours->>'to', ''));
    IF v_from !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' OR v_to !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$' THEN
      RAISE EXCEPTION 'Enter opening times as HH:MM, for example 09:00 to 17:30';
    END IF;
    IF v_from::time >= v_to::time THEN
      RAISE EXCEPTION 'Each day must close after it opens';
    END IF;
    tidy := tidy || jsonb_build_array(jsonb_build_object('from', v_from, 'to', v_to));
  END LOOP;
  RETURN tidy;
END;
$$;

CREATE FUNCTION chat.check_sla(p_sla JSONB)
RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
  tidy JSONB := '{}'::jsonb;
  level TEXT;
  hours TEXT;
BEGIN
  IF jsonb_typeof(p_sla) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Give a response target for each priority';
  END IF;
  FOREACH level IN ARRAY ARRAY['urgent', 'high', 'normal', 'low'] LOOP
    hours := coalesce(p_sla->>level, '0');
    IF hours !~ '^[0-9]{1,3}$' OR hours::int > 720 THEN
      RAISE EXCEPTION 'Response targets are whole hours from 0 to 720 (0 means no target)';
    END IF;
    tidy := tidy || jsonb_build_object(level, hours::int);
  END LOOP;
  RETURN tidy;
END;
$$;

-- Settings: everything from before, plus hours, the away message, ratings and ticket targets
CREATE OR REPLACE FUNCTION chat.save_settings(p_tenant UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  saved chat.settings;
  v_hours JSONB;
  v_sla JSONB;
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
    updated_at = now()
  WHERE tenant_id = p_tenant RETURNING * INTO saved;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  RETURN row_to_json(saved);
END;
$$;

-- What the bot says when it hands over: the usual message in hours, the away message outside them
CREATE FUNCTION chat.handoff_text(p_setting chat.settings)
RETURNS TEXT
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT CASE WHEN chat.is_open(p_setting)
    THEN p_setting.handoff_message || CASE WHEN p_setting.opening_hours <> '' THEN ' Our hours: ' || p_setting.opening_hours ELSE '' END
    ELSE p_setting.offline_message END;
$$;

-- ---------- Visitor page ----------

CREATE OR REPLACE FUNCTION public.chat_info(p_key TEXT)
RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT json_build_object('company', t.name, 'welcome', s.welcome_message, 'hours', s.opening_hours,
    'colour', s.colour, 'bot', s.bot_enabled, 'online', chat.is_open(s),
    'away', CASE WHEN chat.is_open(s) THEN NULL ELSE s.offline_message END)
  FROM chat.settings s JOIN public.tenants t ON t.id = s.tenant_id
  WHERE s.public_key = p_key AND s.enabled;
$$;

-- As before, plus: whether the team is in, staff typing, the newest message staff have seen,
-- and whether the visitor can rate the chat
CREATE OR REPLACE FUNCTION chat.visitor_state(p_conversation UUID, p_after BIGINT)
RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT json_build_object(
    'status', c.status,
    'needs_contact', c.wants_person AND c.visitor_email IS NULL,
    'name', c.visitor_name,
    'email', c.visitor_email,
    'online', chat.is_open(s),
    'staff_typing', coalesce(c.staff_typing_at > now() - interval '6 seconds', false),
    'seen_up_to', c.staff_read_id,
    'can_rate', s.ask_rating AND c.status = 'closed' AND (c.rated_at IS NULL OR c.rated_at < c.closed_at),
    'rating', c.rating,
    'messages', (
      SELECT coalesce(json_agg(json_build_object('id', m.id, 'from', m.sender, 'body', m.body, 'at', m.created_at) ORDER BY m.id), '[]'::json)
      FROM (
        SELECT * FROM chat.messages
        WHERE conversation_id = c.id AND id > greatest(coalesce(p_after, 0), 0)
        ORDER BY CASE WHEN coalesce(p_after, 0) <= 0 THEN -id ELSE id END
        LIMIT 200
      ) m
    )
  )
  FROM chat.conversations c JOIN chat.settings s ON s.tenant_id = c.tenant_id
  WHERE c.id = p_conversation;
$$;

-- As before, except the hand-over text follows the opening hours, and outside them a chat with the
-- bot off (or already with staff) asks for contact details once
CREATE OR REPLACE FUNCTION public.chat_send(p_key TEXT, p_token TEXT, p_body TEXT, p_after BIGINT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  convo chat.conversations := chat.visitor_conversation(p_key, p_token);
  setting chat.settings;
  body TEXT := btrim(coalesce(p_body, ''));
  best RECORD;
  picked chat.answers;
  words TEXT[];
  needs_person BOOLEAN := false;
  wants BOOLEAN := convo.wants_person;
  new_status TEXT := CASE WHEN convo.status = 'closed' THEN 'open' ELSE convo.status END;
BEGIN
  IF body = '' THEN
    RAISE EXCEPTION 'Type a message';
  END IF;
  IF char_length(body) > 1000 THEN
    RAISE EXCEPTION 'Messages can be up to 1000 characters';
  END IF;
  IF (SELECT count(*) FROM chat.messages
      WHERE conversation_id = convo.id AND sender = 'visitor' AND created_at > now() - interval '1 day') >= 100 THEN
    RAISE EXCEPTION 'You have sent a lot of messages today. Please wait for a reply.';
  END IF;
  PERFORM chat.use_quota(convo.tenant_id, 'message');
  SELECT * INTO setting FROM chat.settings WHERE tenant_id = convo.tenant_id;

  INSERT INTO chat.messages (conversation_id, tenant_id, sender, body) VALUES (convo.id, convo.tenant_id, 'visitor', body);

  -- The bot steps back once the visitor asked for a person or staff have replied
  IF NOT setting.bot_enabled OR convo.wants_person
     OR EXISTS (SELECT 1 FROM chat.messages WHERE conversation_id = convo.id AND sender = 'staff') THEN
    needs_person := true;
    IF NOT convo.wants_person AND NOT chat.is_open(setting) THEN
      INSERT INTO chat.messages (conversation_id, tenant_id, sender, body)
        VALUES (convo.id, convo.tenant_id, 'bot', setting.offline_message);
      wants := true;
    END IF;
  ELSE
    words := chat.words(body);
    SELECT * INTO best FROM chat.find_answer(convo.tenant_id, body);
    IF best.answer_id IS NOT NULL AND best.score >= 0.4 THEN
      SELECT * INTO picked FROM chat.answers WHERE id = best.answer_id;
      INSERT INTO chat.messages (conversation_id, tenant_id, sender, answer_id, body)
        VALUES (convo.id, convo.tenant_id, 'bot', picked.id, picked.answer);
      UPDATE chat.answers SET times_used = times_used + 1, last_used_at = now() WHERE id = picked.id;
    ELSIF cardinality(words) = 0 THEN
      INSERT INTO chat.messages (conversation_id, tenant_id, sender, body) VALUES (convo.id, convo.tenant_id, 'bot',
        'Could you tell me a little more about what you need? You can also ask to talk to a person.');
    ELSE
      INSERT INTO chat.unanswered AS u (tenant_id, question, terms_key, conversation_id)
        SELECT convo.tenant_id, body, array_to_string(words, ' '), convo.id
        WHERE (SELECT count(*) FROM chat.unanswered WHERE tenant_id = convo.tenant_id) < 500
           OR EXISTS (SELECT 1 FROM chat.unanswered WHERE tenant_id = convo.tenant_id AND terms_key = array_to_string(words, ' '))
        ON CONFLICT (tenant_id, terms_key) DO UPDATE
          SET times = u.times + 1, last_asked_at = now(), question = EXCLUDED.question, conversation_id = EXCLUDED.conversation_id;
      INSERT INTO chat.messages (conversation_id, tenant_id, sender, body)
        VALUES (convo.id, convo.tenant_id, 'bot', chat.handoff_text(setting));
      wants := true;
      needs_person := true;
    END IF;
  END IF;

  IF needs_person THEN
    new_status := 'waiting';
  END IF;
  UPDATE chat.conversations SET status = new_status, wants_person = wants, closed_at = NULL,
    staff_unread = staff_unread + 1, visitor_messages = visitor_messages + 1,
    last_message = left(body, 200), last_message_at = now(), visitor_typing_at = NULL
  WHERE id = convo.id RETURNING * INTO convo;

  IF needs_person THEN
    PERFORM chat.alert_staff(convo,
      CASE WHEN wants AND NOT coalesce((SELECT bool_or(sender = 'staff') FROM chat.messages WHERE conversation_id = convo.id), false)
        THEN chat.visitor_label(convo) || ' wants to talk to a person'
        ELSE chat.visitor_label(convo) || ' is waiting in chat' END,
      body);
  END IF;
  RETURN chat.visitor_state(convo.id, p_after);
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_person(p_key TEXT, p_token TEXT, p_after BIGINT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  convo chat.conversations := chat.visitor_conversation(p_key, p_token);
  setting chat.settings;
BEGIN
  IF convo.wants_person AND convo.status = 'waiting' THEN
    RETURN chat.visitor_state(convo.id, p_after);
  END IF;
  PERFORM chat.use_quota(convo.tenant_id, 'message');
  SELECT * INTO setting FROM chat.settings WHERE tenant_id = convo.tenant_id;
  INSERT INTO chat.messages (conversation_id, tenant_id, sender, body)
    VALUES (convo.id, convo.tenant_id, 'bot', chat.handoff_text(setting));
  UPDATE chat.conversations SET wants_person = true, status = 'waiting', closed_at = NULL, last_message_at = now()
    WHERE id = convo.id RETURNING * INTO convo;
  PERFORM chat.alert_staff(convo, chat.visitor_label(convo) || ' wants to talk to a person', coalesce(convo.last_message, ''));
  RETURN chat.visitor_state(convo.id, p_after);
END;
$$;

-- The visitor rates a closed chat, once each time it is closed
CREATE FUNCTION public.chat_rate(p_key TEXT, p_token TEXT, p_rating INT, p_comment TEXT, p_after BIGINT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  convo chat.conversations := chat.visitor_conversation(p_key, p_token);
  setting chat.settings;
  v_comment TEXT := nullif(btrim(coalesce(p_comment, '')), '');
BEGIN
  SELECT * INTO setting FROM chat.settings WHERE tenant_id = convo.tenant_id;
  IF NOT setting.ask_rating THEN
    RAISE EXCEPTION 'Ratings are turned off for this chat';
  END IF;
  IF convo.status <> 'closed' THEN
    RAISE EXCEPTION 'You can rate the chat once it has ended';
  END IF;
  IF convo.rated_at IS NOT NULL AND convo.rated_at >= convo.closed_at THEN
    RAISE EXCEPTION 'Thanks, you have already rated this chat';
  END IF;
  IF p_rating IS NULL OR p_rating NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION 'Choose a rating from 1 to 5';
  END IF;
  IF char_length(coalesce(v_comment, '')) > 500 THEN
    RAISE EXCEPTION 'Comments can be up to 500 characters';
  END IF;
  PERFORM chat.use_quota(convo.tenant_id, 'message');
  UPDATE chat.conversations SET rating = p_rating, rating_comment = v_comment, rated_at = now()
    WHERE id = convo.id RETURNING * INTO convo;
  INSERT INTO chat.messages (conversation_id, tenant_id, sender, body)
    VALUES (convo.id, convo.tenant_id, 'system', 'Rated ' || p_rating || ' out of 5' || coalesce(': ' || v_comment, '') || '. Thank you!');
  -- A low rating goes to the person who had the chat, or owners and admins when nobody did
  IF p_rating <= 2 THEN
    INSERT INTO crm.notifications (tenant_id, user_id, title, body, link, dedupe_key)
    SELECT convo.tenant_id, tm.user_id, left(chat.visitor_label(convo) || ' rated a chat ' || p_rating || ' out of 5', 200),
      left(coalesce(v_comment, 'No comment'), 200), '/saas/chat?c=' || convo.id,
      'chat:' || convo.id || ':rating:' || extract(epoch FROM convo.rated_at)::bigint
    FROM public.tenant_members tm
    WHERE tm.tenant_id = convo.tenant_id
      AND (tm.user_id = convo.assigned_to
        OR (tm.role IN ('owner', 'admin') AND NOT EXISTS (
          SELECT 1 FROM public.tenant_members x WHERE x.tenant_id = convo.tenant_id AND x.user_id = convo.assigned_to)))
    ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
  END IF;
  RETURN chat.visitor_state(convo.id, p_after);
END;
$$;

-- "Typing..." from the visitor. Quietly does nothing for a chat that isn't there.
CREATE FUNCTION public.chat_typing(p_key TEXT, p_token TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF coalesce(p_token, '') ~ '^[0-9a-f]{64}$' THEN
    UPDATE chat.conversations c SET visitor_typing_at = now()
      FROM chat.settings s
      WHERE s.tenant_id = c.tenant_id AND c.token = p_token AND s.public_key = p_key AND s.enabled
        AND (c.visitor_typing_at IS NULL OR c.visitor_typing_at < now() - interval '2 seconds');
  END IF;
  RETURN json_build_object('success', true);
END;
$$;

-- ---------- Staff ----------

-- As before, plus the newest message staff have seen, and staff stop "typing" once they send
CREATE OR REPLACE FUNCTION chat.reply(p_tenant UUID, p_conversation UUID, p_body TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  convo chat.conversations := chat.staff_conversation(p_tenant, p_conversation);
  body TEXT := btrim(coalesce(p_body, ''));
  saved chat.messages;
BEGIN
  IF body = '' THEN
    RAISE EXCEPTION 'Type a reply';
  END IF;
  IF char_length(body) > 2000 THEN
    RAISE EXCEPTION 'Replies can be up to 2000 characters';
  END IF;
  INSERT INTO chat.messages (conversation_id, tenant_id, sender, author_id, body)
    VALUES (convo.id, p_tenant, 'staff', auth.uid(), body) RETURNING * INTO saved;
  -- The first person to reply takes the chat if nobody has it
  UPDATE chat.conversations SET
    status = 'open', closed_at = NULL, staff_unread = 0, alert_round = alert_round + 1,
    assigned_to = CASE WHEN EXISTS (SELECT 1 FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = convo.assigned_to)
      THEN convo.assigned_to ELSE auth.uid() END,
    last_message = left(body, 200), last_message_at = now(),
    staff_read_id = greatest(staff_read_id, saved.id), staff_typing_at = NULL
  WHERE id = convo.id;
  RETURN json_build_object('id', saved.id, 'from', saved.sender, 'body', saved.body, 'at', saved.created_at);
END;
$$;

CREATE OR REPLACE FUNCTION chat.mark_read(p_tenant UUID, p_conversation UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_member(p_tenant);
  UPDATE chat.conversations c SET staff_unread = 0,
    staff_read_id = greatest(c.staff_read_id, coalesce((SELECT max(m.id) FROM chat.messages m WHERE m.conversation_id = c.id), 0))
  WHERE c.id = p_conversation AND c.tenant_id = p_tenant AND c.staff_unread <> 0;
END;
$$;

-- "Typing..." from staff. Viewers can't reply, so they can't type either.
CREATE FUNCTION chat.typing(p_tenant UUID, p_conversation UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_member(p_tenant);
  UPDATE chat.conversations SET staff_typing_at = now()
    WHERE id = p_conversation AND tenant_id = p_tenant
      AND (staff_typing_at IS NULL OR staff_typing_at < now() - interval '2 seconds');
END;
$$;

-- Saved replies. Anyone who can reply can add, change and remove them; up to 200 per company.
CREATE FUNCTION chat.save_canned(p_tenant UUID, p_reply UUID, p_shortcut TEXT, p_body TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_shortcut TEXT := lower(btrim(regexp_replace(coalesce(p_shortcut, ''), '^/+', '')));
  v_body TEXT := btrim(coalesce(p_body, ''));
  saved chat.canned_replies;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  IF v_shortcut !~ '^[a-z0-9][a-z0-9_-]{0,29}$' THEN
    RAISE EXCEPTION 'Shortcuts are up to 30 letters, numbers, - or _, with no spaces';
  END IF;
  IF v_body = '' OR char_length(v_body) > 2000 THEN
    RAISE EXCEPTION 'Enter the reply, up to 2000 characters';
  END IF;
  IF p_reply IS NULL THEN
    IF (SELECT count(*) FROM chat.canned_replies WHERE tenant_id = p_tenant) >= 200 THEN
      RAISE EXCEPTION 'You can have up to 200 saved replies. Remove some you no longer use.';
    END IF;
    INSERT INTO chat.canned_replies (tenant_id, shortcut, body, created_by)
      VALUES (p_tenant, v_shortcut, v_body, auth.uid()) RETURNING * INTO saved;
  ELSE
    UPDATE chat.canned_replies SET shortcut = v_shortcut, body = v_body, updated_at = now()
      WHERE id = p_reply AND tenant_id = p_tenant RETURNING * INTO saved;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Saved reply not found';
    END IF;
  END IF;
  RETURN row_to_json(saved);
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'The shortcut /% is already used', v_shortcut;
END;
$$;

CREATE FUNCTION chat.delete_canned(p_tenant UUID, p_reply UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_member(p_tenant);
  DELETE FROM chat.canned_replies WHERE id = p_reply AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Saved reply not found';
  END IF;
END;
$$;

-- Ratings over the last p_days days: average, how many of each score, per person, latest comments
CREATE FUNCTION chat.rating_stats(p_tenant UUID, p_days INT)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_days INT := least(greatest(coalesce(p_days, 30), 1), 365);
BEGIN
  IF NOT chat.is_member(p_tenant) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  RETURN (
    WITH rated AS (
      SELECT c.* FROM chat.conversations c
      WHERE c.tenant_id = p_tenant AND c.rated_at IS NOT NULL AND c.rated_at > now() - make_interval(days => v_days)
    )
    SELECT json_build_object(
      'days', v_days,
      'count', (SELECT count(*) FROM rated),
      'average', (SELECT round(avg(rating), 2) FROM rated),
      'happy_percent', (SELECT round(100.0 * count(*) FILTER (WHERE rating >= 4) / nullif(count(*), 0)) FROM rated),
      'scores', (SELECT json_object_agg(s, (SELECT count(*) FROM rated WHERE rating = s)) FROM generate_series(1, 5) s),
      'closed', (SELECT count(*) FROM chat.conversations WHERE tenant_id = p_tenant AND closed_at > now() - make_interval(days => v_days)),
      'by_person', coalesce((
        SELECT json_agg(json_build_object('user_id', r.assigned_to, 'email', u.email, 'count', r.n, 'average', r.average)
          ORDER BY r.n DESC)
        FROM (SELECT assigned_to, count(*) AS n, round(avg(rating), 2) AS average FROM rated GROUP BY assigned_to) r
        LEFT JOIN auth.users u ON u.id = r.assigned_to), '[]'::json),
      'recent', coalesce((
        SELECT json_agg(json_build_object('conversation_id', x.id, 'visitor', chat.visitor_label(x), 'rating', x.rating,
          'comment', x.rating_comment, 'rated_at', x.rated_at, 'assigned_to', x.assigned_to) ORDER BY x.rated_at DESC)
        FROM (SELECT * FROM rated ORDER BY rated_at DESC LIMIT 20) x), '[]'::json)
    )
  );
END;
$$;

-- ---------- Tickets ----------

-- Checks ticket fields and gives them back tidy
CREATE FUNCTION chat.clean_ticket(p_tenant UUID, p_data JSONB)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_subject TEXT := btrim(coalesce(p_data->>'subject', ''));
  v_description TEXT := btrim(coalesce(p_data->>'description', ''));
  v_priority TEXT := coalesce(nullif(btrim(coalesce(p_data->>'priority', '')), ''), 'normal');
  v_name TEXT := nullif(btrim(coalesce(p_data->>'customer_name', '')), '');
  v_email TEXT := chat.check_email(p_data->>'customer_email');
  v_assignee UUID;
  v_contact UUID;
BEGIN
  IF char_length(v_subject) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Enter a subject, up to 200 characters';
  END IF;
  IF char_length(v_description) > 4000 THEN
    RAISE EXCEPTION 'Descriptions can be up to 4000 characters';
  END IF;
  IF v_priority NOT IN ('low', 'normal', 'high', 'urgent') THEN
    RAISE EXCEPTION 'Choose a priority';
  END IF;
  IF char_length(coalesce(v_name, '')) > 100 THEN
    RAISE EXCEPTION 'Names can be up to 100 characters';
  END IF;
  IF nullif(p_data->>'assigned_to', '') IS NOT NULL THEN
    v_assignee := social.uuid_or_null(p_data->>'assigned_to');
    IF v_assignee IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = v_assignee AND role <> 'viewer'
    ) THEN
      RAISE EXCEPTION 'That person is not on the team';
    END IF;
  END IF;
  IF nullif(p_data->>'contact_id', '') IS NOT NULL THEN
    v_contact := social.uuid_or_null(p_data->>'contact_id');
    IF v_contact IS NULL OR NOT EXISTS (SELECT 1 FROM crm.contacts WHERE id = v_contact AND tenant_id = p_tenant) THEN
      RAISE EXCEPTION 'Contact not found';
    END IF;
  END IF;
  RETURN jsonb_build_object('subject', v_subject, 'description', v_description, 'priority', v_priority,
    'assigned_to', v_assignee, 'contact_id', v_contact, 'customer_name', v_name, 'customer_email', v_email);
END;
$$;

-- When a ticket is due: its start plus the company's target hours for the priority, or none
CREATE FUNCTION chat.ticket_due(p_tenant UUID, p_priority TEXT, p_from TIMESTAMPTZ)
RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE WHEN coalesce((s.sla_hours->>p_priority)::int, 0) > 0
    THEN p_from + make_interval(hours => (s.sla_hours->>p_priority)::int) END
  FROM chat.settings s WHERE s.tenant_id = p_tenant;
$$;

-- Alerts a person in the company about a ticket, never the person who did it
CREATE FUNCTION chat.ticket_alert(p_ticket chat.tickets, p_user UUID, p_title TEXT, p_body TEXT, p_key TEXT)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO crm.notifications (tenant_id, user_id, title, body, link, dedupe_key)
  SELECT p_ticket.tenant_id, tm.user_id, left(p_title, 200), left(coalesce(p_body, ''), 200),
    '/saas/chat/tickets?t=' || p_ticket.id, 'ticket:' || p_ticket.id || ':' || p_key
  FROM public.tenant_members tm
  WHERE tm.tenant_id = p_ticket.tenant_id AND tm.user_id = p_user AND p_user IS DISTINCT FROM auth.uid()
  ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
$$;

-- Makes a ticket from tidy fields (see clean_ticket). Up to 2000 unsolved and 20000 in all.
CREATE FUNCTION chat.create_ticket(p_tenant UUID, p_fields JSONB, p_conversation UUID)
RETURNS chat.tickets
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_number INT;
  made chat.tickets;
BEGIN
  -- One new ticket at a time per company, so numbers don't clash
  PERFORM pg_advisory_xact_lock(hashtextextended('chat.tickets:' || p_tenant::text, 0));
  IF (SELECT count(*) FROM chat.tickets WHERE tenant_id = p_tenant AND status <> 'solved') >= 2000 THEN
    RAISE EXCEPTION 'You have 2000 open tickets. Solve some before adding more.';
  END IF;
  IF (SELECT count(*) FROM chat.tickets WHERE tenant_id = p_tenant) >= 20000 THEN
    RAISE EXCEPTION 'You have reached 20000 tickets. Delete old solved ones to make room.';
  END IF;
  SELECT coalesce(max(number), 0) + 1 INTO v_number FROM chat.tickets WHERE tenant_id = p_tenant;
  INSERT INTO chat.tickets (tenant_id, number, subject, description, priority, assigned_to, conversation_id, contact_id,
      customer_name, customer_email, due_at, created_by)
    VALUES (p_tenant, v_number, p_fields->>'subject', p_fields->>'description', p_fields->>'priority',
      (p_fields->>'assigned_to')::uuid, p_conversation, (p_fields->>'contact_id')::uuid,
      p_fields->>'customer_name', p_fields->>'customer_email',
      chat.ticket_due(p_tenant, p_fields->>'priority', now()), auth.uid())
    RETURNING * INTO made;
  INSERT INTO chat.ticket_notes (ticket_id, tenant_id, author_id, kind, body)
    VALUES (made.id, p_tenant, auth.uid(), 'change',
      CASE WHEN p_conversation IS NULL THEN 'Ticket opened' ELSE 'Ticket opened from a chat' END);
  IF made.assigned_to IS NOT NULL THEN
    PERFORM chat.ticket_alert(made, made.assigned_to, 'Ticket #' || made.number || ' was given to you: ' || made.subject,
      'Priority ' || made.priority, 'assigned:' || made.assigned_to || ':' || extract(epoch FROM clock_timestamp())::bigint);
  END IF;
  RETURN made;
END;
$$;

-- Adds a ticket (p_ticket null) or changes one. Changes to priority and person go in the log; a new
-- priority moves the due time, counted from when the ticket was opened.
CREATE FUNCTION chat.save_ticket(p_tenant UUID, p_ticket UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v JSONB;
  old chat.tickets;
  saved chat.tickets;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  v := chat.clean_ticket(p_tenant, p_data);
  IF p_ticket IS NULL THEN
    saved := chat.create_ticket(p_tenant, v, NULL);
    RETURN row_to_json(saved);
  END IF;
  SELECT * INTO old FROM chat.tickets WHERE id = p_ticket AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;
  UPDATE chat.tickets SET subject = v->>'subject', description = v->>'description', priority = v->>'priority',
    assigned_to = (v->>'assigned_to')::uuid, contact_id = (v->>'contact_id')::uuid,
    customer_name = v->>'customer_name', customer_email = v->>'customer_email',
    due_at = CASE WHEN v->>'priority' = old.priority THEN old.due_at ELSE chat.ticket_due(p_tenant, v->>'priority', old.created_at) END,
    updated_at = now()
  WHERE id = old.id RETURNING * INTO saved;
  IF saved.priority <> old.priority THEN
    INSERT INTO chat.ticket_notes (ticket_id, tenant_id, author_id, kind, body)
      VALUES (saved.id, p_tenant, auth.uid(), 'change', 'Priority: ' || old.priority || ' to ' || saved.priority);
  END IF;
  IF saved.assigned_to IS DISTINCT FROM old.assigned_to THEN
    INSERT INTO chat.ticket_notes (ticket_id, tenant_id, author_id, kind, body)
      VALUES (saved.id, p_tenant, auth.uid(), 'change', 'Given to ' ||
        coalesce((SELECT email FROM auth.users WHERE id = saved.assigned_to), 'nobody'));
    IF saved.assigned_to IS NOT NULL THEN
      PERFORM chat.ticket_alert(saved, saved.assigned_to, 'Ticket #' || saved.number || ' was given to you: ' || saved.subject,
        'Priority ' || saved.priority, 'assigned:' || saved.assigned_to || ':' || extract(epoch FROM clock_timestamp())::bigint);
    END IF;
  END IF;
  RETURN row_to_json(saved);
END;
$$;

CREATE FUNCTION chat.set_ticket_status(p_tenant UUID, p_ticket UUID, p_status TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  old chat.tickets;
  saved chat.tickets;
  labels JSONB := '{"new": "New", "in_progress": "In progress", "waiting": "Waiting on customer", "solved": "Solved"}';
BEGIN
  PERFORM accounting.require_member(p_tenant);
  IF coalesce(p_status, '') NOT IN ('new', 'in_progress', 'waiting', 'solved') THEN
    RAISE EXCEPTION 'Choose a status';
  END IF;
  SELECT * INTO old FROM chat.tickets WHERE id = p_ticket AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;
  IF old.status = p_status THEN
    RETURN row_to_json(old);
  END IF;
  -- Reopening a solved ticket counts toward the open limit
  IF old.status = 'solved' AND (SELECT count(*) FROM chat.tickets WHERE tenant_id = p_tenant AND status <> 'solved') >= 2000 THEN
    RAISE EXCEPTION 'You have 2000 open tickets. Solve some before reopening this one.';
  END IF;
  UPDATE chat.tickets SET status = p_status, solved_at = CASE WHEN p_status = 'solved' THEN now() END,
    -- Someone working on a ticket nobody had takes it
    assigned_to = CASE WHEN p_status = 'in_progress' AND assigned_to IS NULL
      AND EXISTS (SELECT 1 FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = auth.uid()) THEN auth.uid() ELSE assigned_to END,
    updated_at = now()
  WHERE id = old.id RETURNING * INTO saved;
  INSERT INTO chat.ticket_notes (ticket_id, tenant_id, author_id, kind, body)
    VALUES (saved.id, p_tenant, auth.uid(), 'change', 'Status: ' || (labels->>old.status) || ' to ' || (labels->>p_status));
  IF saved.assigned_to IS NOT NULL THEN
    PERFORM chat.ticket_alert(saved, saved.assigned_to, 'Ticket #' || saved.number || ' is now ' || lower(labels->>p_status),
      saved.subject, 'status:' || extract(epoch FROM clock_timestamp())::bigint);
  END IF;
  RETURN row_to_json(saved);
END;
$$;

-- A note on a ticket. Up to 200 per ticket.
CREATE FUNCTION chat.add_ticket_note(p_tenant UUID, p_ticket UUID, p_body TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_body TEXT := btrim(coalesce(p_body, ''));
  ticket chat.tickets;
  saved chat.ticket_notes;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  IF v_body = '' OR char_length(v_body) > 2000 THEN
    RAISE EXCEPTION 'Write a note of up to 2000 characters';
  END IF;
  SELECT * INTO ticket FROM chat.tickets WHERE id = p_ticket AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;
  IF (SELECT count(*) FROM chat.ticket_notes WHERE ticket_id = ticket.id) >= 200 THEN
    RAISE EXCEPTION 'This ticket has 200 notes, the most it can have';
  END IF;
  INSERT INTO chat.ticket_notes (ticket_id, tenant_id, author_id, kind, body)
    VALUES (ticket.id, p_tenant, auth.uid(), 'note', v_body) RETURNING * INTO saved;
  UPDATE chat.tickets SET updated_at = now() WHERE id = ticket.id;
  IF ticket.assigned_to IS NOT NULL THEN
    PERFORM chat.ticket_alert(ticket, ticket.assigned_to, 'New note on ticket #' || ticket.number || ': ' || ticket.subject,
      v_body, 'note:' || saved.id);
  END IF;
  RETURN row_to_json(saved);
END;
$$;

-- Turns a chat into a ticket, with the transcript as its description. A chat with an unsolved
-- ticket gives that ticket back instead.
CREATE FUNCTION chat.ticket_from_chat(p_tenant UUID, p_conversation UUID, p_priority TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  convo chat.conversations := chat.staff_conversation(p_tenant, p_conversation);
  earlier chat.tickets;
  first_words TEXT;
  made chat.tickets;
BEGIN
  SELECT * INTO earlier FROM chat.tickets
    WHERE tenant_id = p_tenant AND conversation_id = convo.id AND status <> 'solved' ORDER BY created_at LIMIT 1;
  IF FOUND THEN
    RETURN json_build_object('ticket', row_to_json(earlier), 'existing', true);
  END IF;
  SELECT body INTO first_words FROM chat.messages WHERE conversation_id = convo.id AND sender = 'visitor' ORDER BY id LIMIT 1;
  made := chat.create_ticket(p_tenant, chat.clean_ticket(p_tenant, jsonb_build_object(
      'subject', coalesce(nullif(left(regexp_replace(btrim(coalesce(first_words, '')), '\s+', ' ', 'g'), 120), ''),
        'Chat with ' || chat.visitor_label(convo)),
      'description', left(chat.transcript(convo.id), 4000),
      'priority', coalesce(nullif(p_priority, ''), 'normal'),
      'assigned_to', CASE WHEN EXISTS (SELECT 1 FROM public.tenant_members
          WHERE tenant_id = p_tenant AND user_id = convo.assigned_to AND role <> 'viewer') THEN convo.assigned_to ELSE auth.uid() END,
      'contact_id', convo.contact_id,
      'customer_name', convo.visitor_name,
      'customer_email', convo.visitor_email)), convo.id);
  RETURN json_build_object('ticket', row_to_json(made), 'existing', false);
END;
$$;

-- Owners and admins only
CREATE FUNCTION chat.delete_ticket(p_tenant UUID, p_ticket UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  DELETE FROM chat.tickets WHERE id = p_ticket AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;
END;
$$;

-- As before, plus: whether the team is in now, ticket counts and the 30-day rating
CREATE OR REPLACE FUNCTION chat.overview(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  member_role TEXT;
  setting chat.settings;
BEGIN
  SELECT role INTO member_role FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = auth.uid();
  IF member_role IS NULL THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  SELECT * INTO setting FROM chat.settings WHERE tenant_id = p_tenant;
  RETURN json_build_object(
    'waiting', (SELECT count(*) FROM chat.conversations WHERE tenant_id = p_tenant AND status = 'waiting'),
    'open', (SELECT count(*) FROM chat.conversations WHERE tenant_id = p_tenant AND status = 'open'),
    'closed', (SELECT count(*) FROM chat.conversations WHERE tenant_id = p_tenant AND status = 'closed'),
    'unread', (SELECT coalesce(sum(staff_unread), 0) FROM chat.conversations WHERE tenant_id = p_tenant AND status <> 'closed'),
    'mine', (SELECT count(*) FROM chat.conversations WHERE tenant_id = p_tenant AND status <> 'closed' AND assigned_to = auth.uid()),
    'answers', (SELECT count(*) FROM chat.answers WHERE tenant_id = p_tenant),
    'unanswered', (SELECT count(*) FROM chat.unanswered WHERE tenant_id = p_tenant),
    'messages_today', coalesce((SELECT messages FROM chat.daily_usage WHERE tenant_id = p_tenant AND day = current_date), 0),
    'enabled', coalesce(setting.enabled, false),
    'bot_enabled', coalesce(setting.bot_enabled, false),
    'public_key', setting.public_key,
    'me', auth.uid(),
    'can_reply', member_role <> 'viewer',
    'is_manager', member_role IN ('owner', 'admin'),
    'online', chat.is_open(setting),
    'hours_enabled', coalesce(setting.hours_enabled, false),
    'tickets_open', (SELECT count(*) FROM chat.tickets WHERE tenant_id = p_tenant AND status <> 'solved'),
    'tickets_overdue', (SELECT count(*) FROM chat.tickets WHERE tenant_id = p_tenant AND status IN ('new', 'in_progress') AND due_at < now()),
    'tickets_mine', (SELECT count(*) FROM chat.tickets WHERE tenant_id = p_tenant AND status <> 'solved' AND assigned_to = auth.uid()),
    'rating_average', (SELECT round(avg(rating), 2) FROM chat.conversations
      WHERE tenant_id = p_tenant AND rated_at > now() - interval '30 days'),
    'rating_count', (SELECT count(*) FROM chat.conversations WHERE tenant_id = p_tenant AND rated_at > now() - interval '30 days')
  );
END;
$$;

DO $$
DECLARE
  fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY['chat.is_open(chat.settings)', 'chat.check_hours(jsonb)', 'chat.check_sla(jsonb)',
      'chat.handoff_text(chat.settings)', 'chat.clean_ticket(uuid, jsonb)', 'chat.ticket_due(uuid, text, timestamptz)',
      'chat.ticket_alert(chat.tickets, uuid, text, text, text)', 'chat.create_ticket(uuid, jsonb, uuid)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
  END LOOP;
  FOREACH fn IN ARRAY ARRAY['chat.save_settings(uuid, jsonb)', 'chat.reply(uuid, uuid, text)', 'chat.mark_read(uuid, uuid)',
      'chat.typing(uuid, uuid)', 'chat.save_canned(uuid, uuid, text, text)', 'chat.delete_canned(uuid, uuid)',
      'chat.rating_stats(uuid, integer)', 'chat.save_ticket(uuid, uuid, jsonb)', 'chat.set_ticket_status(uuid, uuid, text)',
      'chat.add_ticket_note(uuid, uuid, text)', 'chat.ticket_from_chat(uuid, uuid, text)', 'chat.delete_ticket(uuid, uuid)',
      'chat.overview(uuid)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
  END LOOP;
  FOREACH fn IN ARRAY ARRAY['public.chat_info(text)', 'public.chat_send(text, text, text, bigint)',
      'public.chat_person(text, text, bigint)', 'public.chat_rate(text, text, integer, text, bigint)',
      'public.chat_typing(text, text)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon', fn);
  END LOOP;
  -- Replaced above; keep the original access
  REVOKE EXECUTE ON FUNCTION chat.visitor_state(uuid, bigint) FROM PUBLIC, anon, authenticated;
END;
$$;

-- =====================================================================================
-- SOCIAL
-- =====================================================================================

-- Copies of a post share its image, so the image no longer has to be unique
ALTER TABLE social.posts DROP CONSTRAINT IF EXISTS posts_image_path_key;
CREATE INDEX IF NOT EXISTS idx_social_posts_image ON social.posts (image_path) WHERE image_path IS NOT NULL;
ALTER TABLE social.posts
  ADD COLUMN IF NOT EXISTS series_id UUID,
  ADD COLUMN IF NOT EXISTS copied_from UUID REFERENCES social.posts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_social_posts_series ON social.posts (series_id) WHERE series_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_social_posts_copied_from ON social.posts (copied_from);

-- Results typed in from the platform
ALTER TABLE social.post_targets
  ADD COLUMN IF NOT EXISTS likes INT CHECK (likes BETWEEN 0 AND 1000000000),
  ADD COLUMN IF NOT EXISTS comments INT CHECK (comments BETWEEN 0 AND 1000000000),
  ADD COLUMN IF NOT EXISTS shares INT CHECK (shares BETWEEN 0 AND 1000000000),
  ADD COLUMN IF NOT EXISTS clicks INT CHECK (clicks BETWEEN 0 AND 1000000000),
  ADD COLUMN IF NOT EXISTS views INT CHECK (views BETWEEN 0 AND 1000000000),
  ADD COLUMN IF NOT EXISTS stats_at TIMESTAMPTZ;

-- Content library: saved text and hashtag sets
CREATE TABLE social.snippets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'hashtags')),
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  body TEXT NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 3000),
  created_by UUID DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_social_snippets_name ON social.snippets (tenant_id, kind, lower(name));
CREATE INDEX idx_social_snippets_created_by ON social.snippets (created_by);
ALTER TABLE social.snippets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON social.snippets FOR SELECT TO authenticated USING (social.is_member(tenant_id));
GRANT SELECT ON social.snippets TO authenticated;

-- Comments on a post
CREATE TABLE social.post_comments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  post_id UUID NOT NULL REFERENCES social.posts(id) ON DELETE CASCADE,
  author_id UUID DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  body TEXT NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_social_post_comments_post ON social.post_comments (post_id, id);
CREATE INDEX idx_social_post_comments_tenant ON social.post_comments (tenant_id);
CREATE INDEX idx_social_post_comments_author ON social.post_comments (author_id);
ALTER TABLE social.post_comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON social.post_comments FOR SELECT TO authenticated USING (social.is_member(tenant_id));
GRANT SELECT ON social.post_comments TO authenticated;

-- Saving a post: as before, except an image that another post (a copy) still uses isn't given back
-- for removal
CREATE OR REPLACE FUNCTION social.save_post(p_tenant UUID, p_post UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_role TEXT := social.require_editor(p_tenant);
  manager BOOLEAN := v_role IN ('owner', 'admin');
  approval BOOLEAN := social.needs_approval(p_tenant);
  old social.posts;
  saved social.posts;
  v_title TEXT := btrim(coalesce(p_data->>'title', ''));
  v_campaign TEXT := nullif(btrim(coalesce(p_data->>'campaign', '')), '');
  v_link TEXT := nullif(btrim(coalesce(p_data->>'link_url', '')), '');
  v_notes TEXT := nullif(btrim(coalesce(p_data->>'notes', '')), '');
  v_image TEXT := nullif(btrim(coalesce(p_data->>'image_path', '')), '');
  v_tags_in JSONB := coalesce(p_data->'tags', '[]'::jsonb);
  v_targets JSONB := coalesce(p_data->'targets', '[]'::jsonb);
  v_prefix TEXT := p_tenant::text || '/';
  v_when TIMESTAMPTZ;
  v_assignee UUID;
  v_tags TEXT[];
  v_meta JSONB;
  v_size BIGINT;
  v_mime TEXT;
  v_removed TEXT;
  v_before TEXT;
  v_reset BOOLEAN := false;
  v_target JSONB;
  v_account social.accounts;
  v_body TEXT;
  v_keep UUID[] := '{}';
BEGIN
  IF length(v_title) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Enter a name for the post, up to 200 characters';
  END IF;
  IF length(v_campaign) > 100 THEN
    RAISE EXCEPTION 'Campaign names can be up to 100 characters';
  END IF;
  IF v_link IS NOT NULL AND NOT social.is_web_link(v_link) THEN
    RAISE EXCEPTION 'Enter the link starting with https://';
  END IF;
  IF length(v_notes) > 2000 THEN
    RAISE EXCEPTION 'Notes can be up to 2000 characters';
  END IF;
  BEGIN
    v_when := nullif(btrim(coalesce(p_data->>'scheduled_at', '')), '')::timestamptz;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Choose a valid date and time';
  END;
  IF v_when IS NOT NULL AND (v_when < '2000-01-01' OR v_when > now() + interval '5 years') THEN
    RAISE EXCEPTION 'Choose a date within the next 5 years';
  END IF;

  IF jsonb_typeof(v_tags_in) <> 'array' OR jsonb_typeof(v_targets) <> 'array' THEN
    RAISE EXCEPTION 'Tags and accounts must be lists';
  END IF;
  SELECT coalesce(array_agg(DISTINCT tag ORDER BY tag), '{}') INTO v_tags
    FROM (SELECT lower(left(btrim(regexp_replace(value, '^#+', '')), 50)) AS tag
          FROM jsonb_array_elements_text(v_tags_in) AS value) s
    WHERE tag <> '';
  IF cardinality(v_tags) > 20 THEN
    RAISE EXCEPTION 'A post can have up to 20 tags';
  END IF;
  IF jsonb_array_length(v_targets) > 10 THEN
    RAISE EXCEPTION 'Choose up to 10 accounts';
  END IF;

  IF p_post IS NOT NULL THEN
    SELECT * INTO old FROM social.posts WHERE id = p_post AND tenant_id = p_tenant FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Post not found';
    END IF;
    IF old.status = 'posted' THEN
      RAISE EXCEPTION 'This post is already out. Undo "posted" on an account first to change it.';
    END IF;
    v_before := social.post_fingerprint(p_post);
  END IF;

  IF nullif(btrim(coalesce(p_data->>'assigned_to', '')), '') IS NOT NULL THEN
    v_assignee := social.uuid_or_null(btrim(p_data->>'assigned_to'));
    IF v_assignee IS NULL OR (v_assignee IS DISTINCT FROM old.assigned_to AND NOT EXISTS (
        SELECT 1 FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = v_assignee)) THEN
      RAISE EXCEPTION 'Choose someone in your company to look after this post';
    END IF;
  END IF;

  -- Image
  IF v_image IS NOT NULL AND v_image IS DISTINCT FROM old.image_path THEN
    IF length(v_image) > 500 OR left(v_image, length(v_prefix)) <> v_prefix OR length(v_image) = length(v_prefix)
        OR position('/' IN substr(v_image, length(v_prefix) + 1)) > 0 THEN
      RAISE EXCEPTION 'The image isn''t in the right place';
    END IF;
    SELECT metadata INTO v_meta FROM storage.objects WHERE bucket_id = 'social-media' AND name = v_image;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The image wasn''t uploaded. Please try again.';
    END IF;
    v_size := (v_meta->>'size')::bigint;
    v_mime := v_meta->>'mimetype';
    IF v_size IS NULL OR v_size <= 0 OR v_size > 5242880 THEN
      RAISE EXCEPTION 'Images can be up to 5 MB';
    END IF;
    IF v_mime IS NULL OR v_mime NOT IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp') THEN
      RAISE EXCEPTION 'Upload a JPEG, PNG, GIF or WebP image';
    END IF;
    IF EXISTS (SELECT 1 FROM social.posts WHERE image_path = v_image) THEN
      RAISE EXCEPTION 'That image is already on another post';
    END IF;
    -- One company adds one image at a time, so the space check can't be raced
    PERFORM pg_advisory_xact_lock(hashtextextended('social.images:' || p_tenant::text, 0));
    IF social.image_space_used(p_tenant) > 104857600 THEN
      RAISE EXCEPTION 'Your company has used its 100 MB of image space. Remove images from old posts to make room.';
    END IF;
  ELSIF v_image IS NOT NULL THEN
    v_size := old.image_size;
    v_mime := old.image_mime;
  END IF;
  IF old.image_path IS NOT NULL AND v_image IS DISTINCT FROM old.image_path
      AND NOT EXISTS (SELECT 1 FROM social.posts WHERE image_path = old.image_path AND id <> old.id) THEN
    v_removed := old.image_path;
  END IF;

  IF p_post IS NULL THEN
    INSERT INTO social.posts (tenant_id, title, campaign, tags, link_url, scheduled_at, status, assigned_to,
      image_path, image_size, image_mime, notes, created_by)
    VALUES (p_tenant, v_title, v_campaign, v_tags, v_link, v_when, 'draft', v_assignee,
      v_image, v_size, v_mime, v_notes, auth.uid())
    RETURNING * INTO saved;
  ELSE
    UPDATE social.posts SET title = v_title, campaign = v_campaign, tags = v_tags, link_url = v_link,
      scheduled_at = v_when, assigned_to = v_assignee, image_path = v_image, image_size = v_size,
      image_mime = v_mime, notes = v_notes, updated_at = now(),
      status = CASE WHEN status IN ('approved', 'scheduled')
        THEN CASE WHEN v_when IS NULL THEN 'approved' ELSE 'scheduled' END ELSE status END
      WHERE id = p_post
      RETURNING * INTO saved;
  END IF;

  -- Accounts and their text. Accounts left out are removed from the post.
  FOR v_target IN SELECT value FROM jsonb_array_elements(v_targets) LOOP
    SELECT * INTO v_account FROM social.accounts
      WHERE id = social.uuid_or_null(v_target->>'account_id') AND tenant_id = p_tenant;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Account not found';
    END IF;
    IF v_account.id = ANY (v_keep) THEN
      RAISE EXCEPTION 'Each account can be chosen once';
    END IF;
    IF NOT v_account.is_active AND NOT EXISTS (
        SELECT 1 FROM social.post_targets WHERE post_id = saved.id AND account_id = v_account.id) THEN
      RAISE EXCEPTION '% is turned off. Turn it on under Accounts to post to it.', v_account.handle;
    END IF;
    v_body := coalesce(v_target->>'body', '');
    IF char_length(v_body) > social.char_limit(v_account.platform) THEN
      RAISE EXCEPTION 'The text for % is % characters. % allows %.', v_account.handle, char_length(v_body),
        social.platform_name(v_account.platform), social.char_limit(v_account.platform);
    END IF;
    INSERT INTO social.post_targets (tenant_id, post_id, account_id, platform, body)
    VALUES (p_tenant, saved.id, v_account.id, v_account.platform, v_body)
    ON CONFLICT (post_id, account_id) DO UPDATE SET body = EXCLUDED.body;
    v_keep := v_keep || v_account.id;
  END LOOP;
  DELETE FROM social.post_targets WHERE post_id = saved.id AND NOT (account_id = ANY (v_keep));

  IF p_post IS NOT NULL THEN
    IF approval AND NOT manager AND saved.status IN ('approved', 'scheduled')
        AND v_before IS DISTINCT FROM social.post_fingerprint(saved.id) THEN
      UPDATE social.posts SET status = 'draft', approved_by = NULL, approved_at = NULL WHERE id = saved.id;
      v_reset := true;
    END IF;
    PERFORM social.refresh_posted(saved.id);
  END IF;

  IF v_assignee IS NOT NULL AND v_assignee IS DISTINCT FROM old.assigned_to THEN
    PERFORM social.notify(p_tenant, ARRAY[v_assignee], 'A post was given to you: ' || v_title,
      CASE WHEN v_when IS NULL THEN 'No date yet' ELSE 'Planned for ' || to_char(v_when AT TIME ZONE coalesce(
        (SELECT timezone FROM social.settings WHERE tenant_id = p_tenant), 'UTC'), 'FMDD Mon YYYY, HH24:MI') END,
      saved.id, 'social:' || saved.id || ':assigned:' || v_assignee || ':' || extract(epoch FROM clock_timestamp())::bigint);
  END IF;

  SELECT * INTO saved FROM social.posts WHERE id = saved.id;
  RETURN json_build_object('post', row_to_json(saved), 'removed_image', v_removed, 'approval_reset', v_reset);
END;
$$;

-- Deleting a post: its image is only given back for removal when no other post uses it
CREATE OR REPLACE FUNCTION social.delete_post(p_tenant UUID, p_post UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_image TEXT;
BEGIN
  PERFORM social.require_editor(p_tenant);
  DELETE FROM social.posts WHERE id = p_post AND tenant_id = p_tenant RETURNING image_path INTO v_image;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Post not found';
  END IF;
  IF v_image IS NOT NULL AND EXISTS (SELECT 1 FROM social.posts WHERE image_path = v_image) THEN
    v_image := NULL;
  END IF;
  RETURN json_build_object('success', true, 'removed_image', v_image);
END;
$$;

-- Copies a post. With p_every (day, week or month) it makes p_count repeats (1 to 12) after the
-- post's date, in the same series; without, one copy with no date. Copies keep the text for each
-- account that is still on, the image, link, campaign and tags. A copy of a post that was ready to go
-- is scheduled straight away, unless approval is on and the person isn't an owner or admin, in which
-- case the copies are drafts to send for approval.
CREATE FUNCTION social.copy_post(p_tenant UUID, p_post UUID, p_every TEXT, p_count INT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_role TEXT := social.require_editor(p_tenant);
  manager BOOLEAN := v_role IN ('owner', 'admin');
  approval BOOLEAN := social.needs_approval(p_tenant);
  src social.posts;
  v_count INT := coalesce(p_count, 1);
  v_step INTERVAL;
  v_series UUID;
  v_ready BOOLEAN;
  v_when TIMESTAMPTZ;
  made social.posts;
  v_ids UUID[] := '{}';
BEGIN
  SELECT * INTO src FROM social.posts WHERE id = p_post AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Post not found';
  END IF;
  IF p_every IS NULL THEN
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'Choose how often the post repeats';
    END IF;
  ELSIF p_every NOT IN ('day', 'week', 'month') THEN
    RAISE EXCEPTION 'Choose daily, weekly or monthly';
  ELSE
    IF v_count NOT BETWEEN 1 AND 12 THEN
      RAISE EXCEPTION 'Make 1 to 12 repeats at a time';
    END IF;
    IF src.scheduled_at IS NULL THEN
      RAISE EXCEPTION 'Give the post a date first, so the repeats can follow it';
    END IF;
    v_step := ('1 ' || p_every)::interval;
    IF src.scheduled_at + v_step * v_count > now() + interval '5 years' THEN
      RAISE EXCEPTION 'Repeats can go up to 5 years ahead';
    END IF;
  END IF;
  IF (SELECT count(*) FROM social.posts WHERE tenant_id = p_tenant) + v_count > 5000 THEN
    RAISE EXCEPTION 'Your company has 5000 posts, the most it can have. Delete old ones to make room.';
  END IF;

  v_ready := p_every IS NOT NULL AND src.status IN ('approved', 'scheduled', 'posted') AND (NOT approval OR manager)
    AND EXISTS (SELECT 1 FROM social.post_targets t JOIN social.accounts a ON a.id = t.account_id
      WHERE t.post_id = src.id AND a.is_active);
  IF p_every IS NOT NULL THEN
    v_series := coalesce(src.series_id, src.id);
    UPDATE social.posts SET series_id = v_series WHERE id = src.id AND series_id IS NULL;
  END IF;

  FOR i IN 1..v_count LOOP
    v_when := CASE WHEN p_every IS NULL THEN NULL ELSE src.scheduled_at + v_step * i END;
    INSERT INTO social.posts (tenant_id, title, campaign, tags, link_url, scheduled_at, status, assigned_to,
      image_path, image_size, image_mime, notes, created_by, series_id, copied_from,
      submitted_by, submitted_at, approved_by, approved_at)
    VALUES (p_tenant, CASE WHEN p_every IS NULL THEN left('Copy of ' || src.title, 200) ELSE src.title END,
      src.campaign, src.tags, src.link_url, v_when, CASE WHEN v_ready THEN 'scheduled' ELSE 'draft' END,
      CASE WHEN EXISTS (SELECT 1 FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = src.assigned_to)
        THEN src.assigned_to END,
      src.image_path, src.image_size, src.image_mime, src.notes, auth.uid(), v_series, src.id,
      CASE WHEN v_ready THEN auth.uid() END, CASE WHEN v_ready THEN now() END,
      CASE WHEN v_ready AND approval THEN auth.uid() END, CASE WHEN v_ready AND approval THEN now() END)
    RETURNING * INTO made;
    INSERT INTO social.post_targets (tenant_id, post_id, account_id, platform, body)
      SELECT p_tenant, made.id, t.account_id, t.platform, t.body
      FROM social.post_targets t JOIN social.accounts a ON a.id = t.account_id
      WHERE t.post_id = src.id AND a.is_active;
    v_ids := v_ids || made.id;
  END LOOP;
  RETURN json_build_object('created', v_count, 'ids', to_json(v_ids), 'first_id', v_ids[1],
    'status', CASE WHEN v_ready THEN 'scheduled' ELSE 'draft' END);
END;
$$;

-- Content library. Hashtag sets are tidied to "#one #two", up to 30 tags. Up to 300 items.
CREATE FUNCTION social.save_snippet(p_tenant UUID, p_snippet UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_kind TEXT := p_data->>'kind';
  v_name TEXT := btrim(coalesce(p_data->>'name', ''));
  v_body TEXT := btrim(coalesce(p_data->>'body', ''));
  v_tags TEXT[];
  saved social.snippets;
BEGIN
  PERFORM social.require_editor(p_tenant);
  IF v_kind IS NULL OR v_kind NOT IN ('text', 'hashtags') THEN
    RAISE EXCEPTION 'Choose text or hashtags';
  END IF;
  IF char_length(v_name) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Enter a name, up to 100 characters';
  END IF;
  IF v_kind = 'hashtags' THEN
    SELECT array_agg('#' || tag ORDER BY first_at) INTO v_tags FROM (
      SELECT lower(tag) AS key, min(tag) AS tag, min(n) AS first_at
      FROM (SELECT regexp_replace(w, '^#+', '') AS tag, n
            FROM regexp_split_to_table(v_body, '[[:space:],]+') WITH ORDINALITY AS s(w, n)) words
      WHERE tag <> '' GROUP BY lower(tag)
    ) tags;
    IF v_tags IS NULL THEN
      RAISE EXCEPTION 'Enter at least one hashtag';
    END IF;
    IF cardinality(v_tags) > 30 THEN
      RAISE EXCEPTION 'A hashtag set can have up to 30 hashtags';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(v_tags) t WHERE t !~ '^#[[:alnum:]_]{1,50}$') THEN
      RAISE EXCEPTION 'Hashtags can only have letters, numbers and _';
    END IF;
    v_body := array_to_string(v_tags, ' ');
  END IF;
  IF char_length(v_body) NOT BETWEEN 1 AND 3000 THEN
    RAISE EXCEPTION 'Enter the text, up to 3000 characters';
  END IF;
  IF p_snippet IS NULL THEN
    IF (SELECT count(*) FROM social.snippets WHERE tenant_id = p_tenant) >= 300 THEN
      RAISE EXCEPTION 'Your library has 300 items, the most it can have. Remove some you no longer use.';
    END IF;
    INSERT INTO social.snippets (tenant_id, kind, name, body, created_by)
      VALUES (p_tenant, v_kind, v_name, v_body, auth.uid()) RETURNING * INTO saved;
  ELSE
    UPDATE social.snippets SET kind = v_kind, name = v_name, body = v_body, updated_at = now()
      WHERE id = p_snippet AND tenant_id = p_tenant RETURNING * INTO saved;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Library item not found';
    END IF;
  END IF;
  RETURN row_to_json(saved);
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'There is already one called %', v_name;
END;
$$;

CREATE FUNCTION social.delete_snippet(p_tenant UUID, p_snippet UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM social.require_editor(p_tenant);
  DELETE FROM social.snippets WHERE id = p_snippet AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Library item not found';
  END IF;
  RETURN json_build_object('success', true);
END;
$$;

-- A comment on a post. Alerts the people on the post, everyone who commented before, and owners
-- and admins while it waits for approval. Up to 200 per post.
CREATE FUNCTION social.add_comment(p_tenant UUID, p_post UUID, p_body TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_body TEXT := btrim(coalesce(p_body, ''));
  post social.posts;
  saved social.post_comments;
BEGIN
  PERFORM social.require_editor(p_tenant);
  IF char_length(v_body) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Write a comment of up to 1000 characters';
  END IF;
  SELECT * INTO post FROM social.posts WHERE id = p_post AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Post not found';
  END IF;
  IF (SELECT count(*) FROM social.post_comments WHERE post_id = post.id) >= 200 THEN
    RAISE EXCEPTION 'This post has 200 comments, the most it can have';
  END IF;
  INSERT INTO social.post_comments (tenant_id, post_id, author_id, body)
    VALUES (p_tenant, post.id, auth.uid(), v_body) RETURNING * INTO saved;
  PERFORM social.notify(p_tenant,
    ARRAY[post.created_by, post.assigned_to, post.submitted_by]
      || ARRAY(SELECT DISTINCT author_id FROM social.post_comments WHERE post_id = post.id AND author_id IS NOT NULL)
      || CASE WHEN post.status = 'needs_approval'
        THEN ARRAY(SELECT user_id FROM public.tenant_members WHERE tenant_id = p_tenant AND role IN ('owner', 'admin'))
        ELSE '{}'::uuid[] END,
    'New comment on ' || post.title, v_body, post.id, 'social:' || post.id || ':comment:' || saved.id);
  RETURN row_to_json(saved);
END;
$$;

-- The person who wrote a comment, or an owner or admin, can remove it
CREATE FUNCTION social.delete_comment(p_tenant UUID, p_comment BIGINT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_role TEXT := social.require_editor(p_tenant);
BEGIN
  DELETE FROM social.post_comments
    WHERE id = p_comment AND tenant_id = p_tenant AND (author_id = auth.uid() OR v_role IN ('owner', 'admin'));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'You can only remove your own comments';
  END IF;
  RETURN json_build_object('success', true);
END;
$$;

-- Results typed in from the platform for one posted account. Empty boxes clear that number.
CREATE FUNCTION social.save_stats(p_tenant UUID, p_target UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  target social.post_targets;
  v_values INT[] := '{}';
  v_text TEXT;
  field TEXT;
BEGIN
  PERFORM social.require_editor(p_tenant);
  SELECT * INTO target FROM social.post_targets WHERE id = p_target AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF target.posted_at IS NULL THEN
    RAISE EXCEPTION 'Mark it as posted before adding its results';
  END IF;
  FOREACH field IN ARRAY ARRAY['likes', 'comments', 'shares', 'clicks', 'views'] LOOP
    v_text := btrim(coalesce(p_data->>field, ''));
    IF v_text <> '' AND (v_text !~ '^[0-9]{1,10}$' OR v_text::bigint > 1000000000) THEN
      RAISE EXCEPTION 'Results are whole numbers from 0 up to 1,000,000,000';
    END IF;
    v_values := v_values || CASE WHEN v_text = '' THEN NULL ELSE v_text::int END;
  END LOOP;
  UPDATE social.post_targets SET likes = v_values[1], comments = v_values[2], shares = v_values[3],
    clicks = v_values[4], views = v_values[5],
    stats_at = CASE WHEN array_remove(v_values, NULL) = '{}' THEN NULL ELSE now() END
  WHERE id = target.id RETURNING * INTO target;
  RETURN row_to_json(target);
END;
$$;

-- When the company's posts do best, from what it posted in the last year, in its time zone.
-- A post's time is its planned time, or when it was marked posted. "Interactions" are likes,
-- comments, shares and clicks typed in from the platforms. Days run Monday (1) to Sunday (7);
-- hours are grouped in 3-hour blocks.
CREATE FUNCTION social.best_times(p_tenant UUID, p_platform TEXT)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  tz TEXT := coalesce((SELECT timezone FROM social.settings WHERE tenant_id = p_tenant), 'UTC');
BEGIN
  IF social.role_in(p_tenant) IS NULL THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF p_platform IS NOT NULL AND p_platform NOT IN ('x', 'linkedin', 'facebook', 'instagram') THEN
    RAISE EXCEPTION 'Choose a platform';
  END IF;
  RETURN (
    WITH done AS (
      SELECT t.platform, t.stats_at IS NOT NULL AS has_stats,
        coalesce(t.likes, 0) + coalesce(t.comments, 0) + coalesce(t.shares, 0) + coalesce(t.clicks, 0) AS interactions,
        t.views,
        coalesce(p.scheduled_at, t.posted_at AT TIME ZONE 'UTC') AT TIME ZONE tz AS local_at
      FROM social.post_targets t JOIN social.posts p ON p.id = t.post_id
      WHERE t.tenant_id = p_tenant AND t.posted_at IS NOT NULL AND t.posted_at > (now() AT TIME ZONE 'UTC') - interval '365 days'
        AND (p_platform IS NULL OR t.platform = p_platform)
    ), slots AS (
      SELECT extract(isodow FROM local_at)::int AS weekday, (extract(hour FROM local_at)::int / 3) * 3 AS hour,
        count(*) AS posts, count(*) FILTER (WHERE has_stats) AS with_stats,
        round(avg(interactions) FILTER (WHERE has_stats), 1) AS average
      FROM done GROUP BY 1, 2
    )
    SELECT json_build_object(
      'timezone', tz,
      'posted', (SELECT count(*) FROM done),
      'with_stats', (SELECT count(*) FROM done WHERE has_stats),
      'enough', (SELECT count(*) FROM done WHERE has_stats) >= 5,
      'best', coalesce((SELECT json_agg(row_to_json(b)) FROM (
        SELECT weekday, hour, posts, with_stats, average FROM slots WHERE with_stats > 0
        ORDER BY average DESC, with_stats DESC, weekday, hour LIMIT 3) b), '[]'::json),
      'slots', coalesce((SELECT json_agg(row_to_json(s) ORDER BY s.weekday, s.hour) FROM slots s), '[]'::json),
      'by_weekday', (SELECT json_agg(json_build_object('weekday', d,
          'posts', (SELECT count(*) FROM done WHERE extract(isodow FROM local_at) = d),
          'average', (SELECT round(avg(interactions), 1) FROM done WHERE has_stats AND extract(isodow FROM local_at) = d))
        ORDER BY d) FROM generate_series(1, 7) d),
      'by_platform', coalesce((SELECT json_agg(row_to_json(x) ORDER BY x.platform) FROM (
        SELECT platform, count(*) AS posts, count(*) FILTER (WHERE has_stats) AS with_stats,
          round(avg(interactions) FILTER (WHERE has_stats), 1) AS average,
          sum(interactions) FILTER (WHERE has_stats) AS interactions, sum(views) AS views
        FROM done GROUP BY platform) x), '[]'::json)
    )
  );
END;
$$;

DO $$
DECLARE
  fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY['social.save_post(uuid, uuid, jsonb)', 'social.delete_post(uuid, uuid)',
      'social.copy_post(uuid, uuid, text, integer)', 'social.save_snippet(uuid, uuid, jsonb)',
      'social.delete_snippet(uuid, uuid)', 'social.add_comment(uuid, uuid, text)', 'social.delete_comment(uuid, bigint)',
      'social.save_stats(uuid, uuid, jsonb)', 'social.best_times(uuid, text)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
