-- Customer chat: a public chat page each company can link to or embed. A bot answers from the
-- company's own questions and answers (full-text and keyword match, 'simple' config so any language
-- works); when it can't, it hands over to a person. Staff read and reply in a team inbox, assign,
-- close, and turn visitors into CRM leads. Visitors have no login: they reach their conversation
-- with the company's public key plus the conversation's secret token, only through the public
-- functions at the end, which also enforce the message caps.

CREATE SCHEMA IF NOT EXISTS chat;
GRANT USAGE ON SCHEMA chat TO authenticated, service_role;

-- Role checks
CREATE FUNCTION chat.is_member(p_tenant UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = auth.uid());
$$;

CREATE FUNCTION chat.is_manager(p_tenant UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.tenant_members
    WHERE tenant_id = p_tenant AND user_id = auth.uid() AND role IN ('owner', 'admin'));
$$;

-- Settings, one row per company
CREATE TABLE chat.settings (
  tenant_id UUID PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL UNIQUE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  bot_enabled BOOLEAN NOT NULL DEFAULT true,
  welcome_message TEXT NOT NULL DEFAULT 'Hi! Ask us anything and we''ll do our best to help.'
    CHECK (char_length(welcome_message) <= 500),
  handoff_message TEXT NOT NULL DEFAULT 'I''ll get a person to help. Please leave your name and email so we can get back to you, even if you leave this page.'
    CHECK (char_length(btrim(handoff_message)) BETWEEN 1 AND 500),
  opening_hours TEXT NOT NULL DEFAULT '' CHECK (char_length(opening_hours) <= 200),
  colour TEXT NOT NULL DEFAULT '#1f5eff' CHECK (colour ~ '^#[0-9a-fA-F]{6}$'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The knowledge base
CREATE TABLE chat.answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  question TEXT NOT NULL CHECK (char_length(btrim(question)) BETWEEN 1 AND 300),
  answer TEXT NOT NULL CHECK (char_length(btrim(answer)) BETWEEN 1 AND 4000),
  keywords TEXT NOT NULL DEFAULT '' CHECK (char_length(keywords) <= 500),
  is_active BOOLEAN NOT NULL DEFAULT true,
  terms TEXT[] NOT NULL DEFAULT '{}',
  search TSVECTOR,
  times_used INT NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_answers_tenant ON chat.answers (tenant_id);
CREATE INDEX idx_chat_answers_search ON chat.answers USING gin (search);
CREATE INDEX idx_chat_answers_created_by ON chat.answers (created_by);

CREATE TABLE chat.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE CHECK (token ~ '^[0-9a-f]{64}$'),
  -- open: talking (bot or staff); waiting: the visitor needs a person to reply; closed
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting', 'closed')),
  visitor_name TEXT CHECK (char_length(visitor_name) <= 100),
  visitor_email TEXT CHECK (char_length(visitor_email) <= 254),
  started_on TEXT CHECK (char_length(started_on) <= 500),
  wants_person BOOLEAN NOT NULL DEFAULT false,
  assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  lead_id UUID REFERENCES crm.leads(id) ON DELETE SET NULL,
  staff_unread INT NOT NULL DEFAULT 0,
  visitor_messages INT NOT NULL DEFAULT 0,
  -- Goes up each time staff reply, so one alert is sent per stretch of waiting
  alert_round INT NOT NULL DEFAULT 0,
  last_message TEXT,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);
CREATE INDEX idx_chat_conversations_inbox ON chat.conversations (tenant_id, status, last_message_at DESC);
CREATE INDEX idx_chat_conversations_assigned ON chat.conversations (assigned_to);
CREATE INDEX idx_chat_conversations_lead ON chat.conversations (lead_id);

CREATE TABLE chat.messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES chat.conversations(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('visitor', 'bot', 'staff', 'system')),
  author_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  answer_id UUID REFERENCES chat.answers(id) ON DELETE SET NULL,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_messages_conversation ON chat.messages (conversation_id, id);
CREATE INDEX idx_chat_messages_tenant ON chat.messages (tenant_id, created_at);
CREATE INDEX idx_chat_messages_answer ON chat.messages (answer_id);
CREATE INDEX idx_chat_messages_author ON chat.messages (author_id);

-- Questions the bot couldn't answer, grouped by their words, so the company can add answers
CREATE TABLE chat.unanswered (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  question TEXT NOT NULL CHECK (char_length(question) <= 1000),
  terms_key TEXT NOT NULL,
  times INT NOT NULL DEFAULT 1,
  conversation_id UUID REFERENCES chat.conversations(id) ON DELETE SET NULL,
  first_asked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_asked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, terms_key)
);
CREATE INDEX idx_chat_unanswered_conversation ON chat.unanswered (conversation_id);

-- Daily counters behind the per-company caps. Only the chat functions read or write them.
CREATE TABLE chat.daily_usage (
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  messages INT NOT NULL DEFAULT 0,
  conversations INT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);

ALTER TABLE chat.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.unanswered ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.daily_usage ENABLE ROW LEVEL SECURITY;

-- Everyone in the company can read; every change goes through the functions below
CREATE POLICY tenant_rows ON chat.settings FOR SELECT TO authenticated USING (chat.is_member(tenant_id));
CREATE POLICY tenant_rows ON chat.answers FOR SELECT TO authenticated USING (chat.is_member(tenant_id));
CREATE POLICY tenant_rows ON chat.conversations FOR SELECT TO authenticated USING (chat.is_member(tenant_id));
CREATE POLICY tenant_rows ON chat.messages FOR SELECT TO authenticated USING (chat.is_member(tenant_id));
CREATE POLICY tenant_rows ON chat.unanswered FOR SELECT TO authenticated USING (chat.is_member(tenant_id));

GRANT SELECT ON chat.settings, chat.answers, chat.messages, chat.unanswered TO authenticated;
-- The visitor's secret token stays hidden from staff, so nobody can write as the visitor
GRANT SELECT (id, tenant_id, status, visitor_name, visitor_email, started_on, wants_person, assigned_to, lead_id,
  staff_unread, visitor_messages, last_message, last_message_at, created_at, closed_at) ON chat.conversations TO authenticated;

-- Every company gets settings with a private public key; chat starts switched off
CREATE FUNCTION chat.new_public_key()
RETURNS TEXT
LANGUAGE sql VOLATILE SET search_path = ''
AS $$
  SELECT replace(gen_random_uuid()::text, '-', '');
$$;

CREATE FUNCTION chat.seed_defaults(p_tenant UUID)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO chat.settings (tenant_id, public_key) VALUES (p_tenant, chat.new_public_key()) ON CONFLICT DO NOTHING;
$$;

CREATE FUNCTION chat.seed_for_new_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM chat.seed_defaults(NEW.id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER seed_chat AFTER INSERT ON public.tenants FOR EACH ROW EXECUTE FUNCTION chat.seed_for_new_tenant();
SELECT chat.seed_defaults(id) FROM public.tenants;

-- Matching. The 'simple' config has no language rules, so a short list of very common words is
-- left out of scoring, and words that share a start of 4+ letters count as the same (refund/refunds).
CREATE FUNCTION chat.common_words()
RETURNS TEXT[]
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT ARRAY['the', 'is', 'are', 'am', 'was', 'were', 'be', 'been', 'to', 'of', 'in', 'on', 'at', 'for', 'and',
    'or', 'but', 'you', 'we', 'it', 'its', 'my', 'your', 'our', 'me', 'do', 'does', 'did', 'can', 'could', 'would',
    'will', 'should', 'what', 'how', 'when', 'where', 'why', 'who', 'which', 'this', 'that', 'there', 'have', 'has',
    'with', 'from', 'about', 'please', 'hi', 'hello', 'hey', 'thanks', 'thank', 'any', 'get', 'need', 'want', 'if',
    'so', 'not', 'no', 'yes', 'us', 'they', 'them', 'their', 'as', 'by', 'an', 'some', 'tell', 'know', 'there',
    'here', 'just', 'like', 'ok', 'okay', 'im', 'ive', 'dont', 'also', 'too', 'very', 'much', 'many'];
$$;

CREATE FUNCTION chat.words(p_text TEXT)
RETURNS TEXT[]
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT coalesce(array_agg(w ORDER BY w), '{}'::text[])
  FROM (
    SELECT DISTINCT w
    FROM unnest(tsvector_to_array(to_tsvector('simple'::regconfig, left(coalesce(p_text, ''), 2000)))) AS w
    WHERE char_length(w) >= 2 AND w <> ALL (chat.common_words())
    LIMIT 40
  ) s;
$$;

CREATE FUNCTION chat.same_word(a TEXT, b TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT a = b OR (least(char_length(a), char_length(b)) >= 4
    AND (left(a, char_length(b)) = b OR left(b, char_length(a)) = a));
$$;

CREATE FUNCTION chat.prepare_answer()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  NEW.question := btrim(NEW.question);
  NEW.answer := btrim(NEW.answer);
  NEW.keywords := btrim(coalesce(NEW.keywords, ''));
  NEW.terms := chat.words(NEW.question || ' ' || replace(NEW.keywords, ',', ' '));
  NEW.search := setweight(to_tsvector('simple'::regconfig, NEW.question), 'A')
    || setweight(to_tsvector('simple'::regconfig, replace(NEW.keywords, ',', ' ')), 'A')
    || setweight(to_tsvector('simple'::regconfig, NEW.answer), 'C');
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER prepare_answer BEFORE INSERT OR UPDATE ON chat.answers FOR EACH ROW EXECUTE FUNCTION chat.prepare_answer();

-- The best answer and its score. A score of 0.4 or more is a match. Each keyword (comma separated)
-- found in the message adds 1; the share of the message's words found in the question and keywords
-- adds up to 0.6, the share of the question's words found in the message up to 0.4, and having every
-- typed word somewhere in the entry (websearch_to_tsquery) adds 0.25.
CREATE FUNCTION chat.find_answer(p_tenant UUID, p_text TEXT)
RETURNS TABLE (answer_id UUID, score NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH typed AS (SELECT left(coalesce(p_text, ''), 2000) AS body),
  v AS (SELECT w FROM unnest(chat.words((SELECT body FROM typed))) AS w),
  every_word AS (SELECT tsvector_to_array(to_tsvector('simple'::regconfig, (SELECT body FROM typed))) AS words),
  v_len AS (SELECT coalesce(sum(char_length(w)), 0)::numeric AS total FROM v),
  scored AS (
    SELECT a.id, a.times_used,
      (SELECT coalesce(sum(char_length(v.w)), 0) FROM v
        WHERE EXISTS (SELECT 1 FROM unnest(a.terms) t WHERE chat.same_word(v.w, t)))::numeric AS hit_v,
      (SELECT coalesce(sum(char_length(t)), 0) FROM unnest(a.terms) t
        WHERE EXISTS (SELECT 1 FROM v WHERE chat.same_word(v.w, t)))::numeric AS hit_q,
      (SELECT coalesce(sum(char_length(t)), 0) FROM unnest(a.terms) t)::numeric AS len_q,
      (SELECT count(*) FROM unnest(string_to_array(a.keywords, ',')) AS k(phrase), every_word e
        WHERE cardinality(tsvector_to_array(to_tsvector('simple'::regconfig, k.phrase))) > 0
          AND NOT EXISTS (
            SELECT 1 FROM unnest(tsvector_to_array(to_tsvector('simple'::regconfig, k.phrase))) AS kw
            WHERE NOT EXISTS (SELECT 1 FROM unnest(e.words) AS x WHERE chat.same_word(x, kw)))) AS keyword_hits,
      a.search @@ websearch_to_tsquery('simple'::regconfig, (SELECT body FROM typed)) AS full_match
    FROM chat.answers a
    WHERE a.tenant_id = p_tenant AND a.is_active
  )
  SELECT s.id,
    round(least(s.keyword_hits, 3)
      + CASE WHEN l.total > 0 THEN 0.6 * s.hit_v / l.total ELSE 0 END
      + CASE WHEN s.len_q > 0 AND l.total > 0 THEN 0.4 * s.hit_q / s.len_q ELSE 0 END
      + CASE WHEN s.full_match AND l.total > 0 THEN 0.25 ELSE 0 END, 3)
  FROM scored s, v_len l
  ORDER BY 2 DESC, s.times_used DESC
  LIMIT 1;
$$;

-- Per-company daily caps. Raising undoes the count, so a busy day stays at the cap.
CREATE FUNCTION chat.use_quota(p_tenant UUID, p_kind TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  used chat.daily_usage;
BEGIN
  INSERT INTO chat.daily_usage AS u (tenant_id, day, messages, conversations)
    VALUES (p_tenant, current_date, CASE WHEN p_kind = 'message' THEN 1 ELSE 0 END, CASE WHEN p_kind = 'conversation' THEN 1 ELSE 0 END)
    ON CONFLICT (tenant_id, day) DO UPDATE
      SET messages = u.messages + EXCLUDED.messages, conversations = u.conversations + EXCLUDED.conversations
    RETURNING * INTO used;
  IF used.messages > 2000 OR used.conversations > 300 THEN
    RAISE EXCEPTION 'Chat is very busy today. Please try again tomorrow.';
  END IF;
END;
$$;

-- The visitor's conversation, found by the company's key and the secret token
CREATE FUNCTION chat.visitor_conversation(p_key TEXT, p_token TEXT)
RETURNS chat.conversations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  picked chat.conversations;
BEGIN
  IF coalesce(p_token, '') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'This chat is not available';
  END IF;
  SELECT c.* INTO picked FROM chat.conversations c JOIN chat.settings s ON s.tenant_id = c.tenant_id
    WHERE c.token = p_token AND s.public_key = p_key AND s.enabled
    FOR UPDATE OF c;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This chat is not available';
  END IF;
  -- Covers everything a visitor can add (messages, contact details, asking for a person)
  IF (SELECT count(*) FROM chat.messages WHERE conversation_id = picked.id AND created_at > now() - interval '1 day') >= 300 THEN
    RAISE EXCEPTION 'This chat has reached its limit for today. Please try again tomorrow.';
  END IF;
  RETURN picked;
END;
$$;

-- What the visitor's page shows: status, whether to ask for contact details, and new messages.
-- With p_after = 0 it returns the latest 200.
CREATE FUNCTION chat.visitor_state(p_conversation UUID, p_after BIGINT)
RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT json_build_object(
    'status', c.status,
    'needs_contact', c.wants_person AND c.visitor_email IS NULL,
    'name', c.visitor_name,
    'email', c.visitor_email,
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
  FROM chat.conversations c WHERE c.id = p_conversation;
$$;

-- Bell alert to the person assigned, or to owners and admins when nobody is (or the assignee left).
-- One per conversation until staff reply.
CREATE FUNCTION chat.alert_staff(p_conversation chat.conversations, p_title TEXT, p_body TEXT)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO crm.notifications (tenant_id, user_id, title, body, link, dedupe_key)
  SELECT p_conversation.tenant_id, tm.user_id, p_title, left(p_body, 200),
    '/saas/chat?c=' || p_conversation.id, 'chat:' || p_conversation.id || ':' || p_conversation.alert_round
  FROM public.tenant_members tm
  WHERE tm.tenant_id = p_conversation.tenant_id
    AND (tm.user_id = p_conversation.assigned_to
      OR (tm.role IN ('owner', 'admin') AND NOT EXISTS (
        SELECT 1 FROM public.tenant_members x
        WHERE x.tenant_id = p_conversation.tenant_id AND x.user_id = p_conversation.assigned_to)))
  ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
$$;

CREATE FUNCTION chat.visitor_label(p_conversation chat.conversations)
RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT coalesce(nullif(p_conversation.visitor_name, ''), nullif(p_conversation.visitor_email, ''), 'A visitor');
$$;

CREATE FUNCTION chat.check_email(p_email TEXT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
  address TEXT := lower(btrim(coalesce(p_email, '')));
BEGIN
  IF address = '' THEN
    RETURN NULL;
  END IF;
  IF char_length(address) > 254 OR address !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'Enter a valid email';
  END IF;
  RETURN address;
END;
$$;

-- ---------- Staff ----------

CREATE FUNCTION chat.overview(p_tenant UUID)
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
    'is_manager', member_role IN ('owner', 'admin')
  );
END;
$$;

-- People who can be given a chat
CREATE FUNCTION chat.team(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT chat.is_member(p_tenant) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  RETURN (
    SELECT coalesce(json_agg(json_build_object('id', tm.user_id, 'email', u.email, 'role', tm.role) ORDER BY u.email), '[]'::json)
    FROM public.tenant_members tm JOIN auth.users u ON u.id = tm.user_id
    WHERE tm.tenant_id = p_tenant AND tm.role <> 'viewer'
  );
END;
$$;

CREATE FUNCTION chat.staff_conversation(p_tenant UUID, p_conversation UUID)
RETURNS chat.conversations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  picked chat.conversations;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  SELECT * INTO picked FROM chat.conversations WHERE id = p_conversation AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Chat not found';
  END IF;
  RETURN picked;
END;
$$;

CREATE FUNCTION chat.reply(p_tenant UUID, p_conversation UUID, p_body TEXT)
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
    last_message = left(body, 200), last_message_at = now()
  WHERE id = convo.id;
  RETURN json_build_object('id', saved.id, 'from', saved.sender, 'body', saved.body, 'at', saved.created_at);
END;
$$;

CREATE FUNCTION chat.assign(p_tenant UUID, p_conversation UUID, p_user UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  convo chat.conversations := chat.staff_conversation(p_tenant, p_conversation);
BEGIN
  IF p_user IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = p_user AND role <> 'viewer'
  ) THEN
    RAISE EXCEPTION 'That person is not on the team';
  END IF;
  UPDATE chat.conversations SET assigned_to = p_user WHERE id = convo.id;
  IF p_user IS NOT NULL AND p_user IS DISTINCT FROM auth.uid() AND p_user IS DISTINCT FROM convo.assigned_to THEN
    INSERT INTO crm.notifications (tenant_id, user_id, title, body, link, dedupe_key)
      VALUES (p_tenant, p_user, 'You were given a chat with ' || chat.visitor_label(convo), coalesce(left(convo.last_message, 200), ''),
        '/saas/chat?c=' || convo.id, 'chat:' || convo.id || ':assigned:' || convo.alert_round)
      ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
  END IF;
  RETURN json_build_object('assigned_to', p_user);
END;
$$;

CREATE FUNCTION chat.set_status(p_tenant UUID, p_conversation UUID, p_status TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
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
  ELSE
    UPDATE chat.conversations SET status = 'open', closed_at = NULL, alert_round = alert_round + 1 WHERE id = convo.id;
  END IF;
  RETURN json_build_object('status', p_status);
END;
$$;

CREATE FUNCTION chat.mark_read(p_tenant UUID, p_conversation UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_member(p_tenant);
  UPDATE chat.conversations SET staff_unread = 0 WHERE id = p_conversation AND tenant_id = p_tenant AND staff_unread <> 0;
END;
$$;

-- Turns the visitor into a CRM lead, or adds the chat to their open lead when one has the same email
CREATE FUNCTION chat.make_lead(p_tenant UUID, p_conversation UUID)
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

  IF earlier.id IS NOT NULL THEN
    INSERT INTO crm.activities (tenant_id, kind, subject, body, lead_id, owner_id)
      VALUES (p_tenant, 'note', 'Chatted on the website', transcript, earlier.id, earlier.owner_id);
    made := earlier.id;
  ELSE
    INSERT INTO crm.leads (tenant_id, name, email, notes, source, owner_id)
      VALUES (p_tenant, coalesce(nullif(btrim(convo.visitor_name), ''), split_part(convo.visitor_email, '@', 1)),
        convo.visitor_email, transcript, 'Chat', v_owner)
      RETURNING id INTO made;
  END IF;

  UPDATE chat.conversations SET lead_id = made WHERE id = convo.id;
  RETURN json_build_object('lead_id', made, 'existing', earlier.id IS NOT NULL);
END;
$$;

CREATE FUNCTION chat.save_answer(p_tenant UUID, p_answer UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_question TEXT := btrim(coalesce(p_data->>'question', ''));
  v_answer TEXT := btrim(coalesce(p_data->>'answer', ''));
  v_keywords TEXT := btrim(coalesce(p_data->>'keywords', ''));
  v_active BOOLEAN := coalesce((p_data->>'is_active')::boolean, true);
  saved chat.answers;
BEGIN
  PERFORM accounting.require_member(p_tenant);
  IF v_question = '' OR char_length(v_question) > 300 THEN
    RAISE EXCEPTION 'Enter a question of up to 300 characters';
  END IF;
  IF v_answer = '' OR char_length(v_answer) > 4000 THEN
    RAISE EXCEPTION 'Enter an answer of up to 4000 characters';
  END IF;
  IF char_length(v_keywords) > 500 THEN
    RAISE EXCEPTION 'Keywords can be up to 500 characters';
  END IF;

  IF p_answer IS NULL THEN
    IF (SELECT count(*) FROM chat.answers WHERE tenant_id = p_tenant) >= 500 THEN
      RAISE EXCEPTION 'You can have up to 500 answers. Remove some you no longer need.';
    END IF;
    INSERT INTO chat.answers (tenant_id, question, answer, keywords, is_active, created_by)
      VALUES (p_tenant, v_question, v_answer, v_keywords, v_active, auth.uid()) RETURNING * INTO saved;
  ELSE
    UPDATE chat.answers SET question = v_question, answer = v_answer, keywords = v_keywords, is_active = v_active
      WHERE id = p_answer AND tenant_id = p_tenant RETURNING * INTO saved;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Answer not found';
    END IF;
  END IF;

  -- Answering a question the bot missed takes it off the list
  IF p_data ? 'unanswered_id' AND coalesce(p_data->>'unanswered_id', '') ~ '^[0-9a-f-]{36}$' THEN
    DELETE FROM chat.unanswered WHERE id = (p_data->>'unanswered_id')::uuid AND tenant_id = p_tenant;
  END IF;

  RETURN json_build_object('id', saved.id, 'question', saved.question, 'answer', saved.answer, 'keywords', saved.keywords,
    'is_active', saved.is_active, 'times_used', saved.times_used, 'updated_at', saved.updated_at);
END;
$$;

CREATE FUNCTION chat.delete_answer(p_tenant UUID, p_answer UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_member(p_tenant);
  DELETE FROM chat.answers WHERE id = p_answer AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Answer not found';
  END IF;
END;
$$;

CREATE FUNCTION chat.dismiss_unanswered(p_tenant UUID, p_question UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_member(p_tenant);
  DELETE FROM chat.unanswered WHERE id = p_question AND tenant_id = p_tenant;
END;
$$;

-- Lets staff see what the bot would say, without starting a chat
CREATE FUNCTION chat.test_bot(p_tenant UUID, p_text TEXT)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  best RECORD;
  picked chat.answers;
BEGIN
  IF NOT chat.is_member(p_tenant) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF char_length(coalesce(p_text, '')) > 1000 THEN
    RAISE EXCEPTION 'Messages can be up to 1000 characters';
  END IF;
  SELECT * INTO best FROM chat.find_answer(p_tenant, p_text);
  IF best.answer_id IS NOT NULL AND best.score >= 0.4 THEN
    SELECT * INTO picked FROM chat.answers WHERE id = best.answer_id;
    RETURN json_build_object('matched', true, 'score', best.score, 'answer_id', picked.id, 'question', picked.question, 'answer', picked.answer);
  END IF;
  RETURN json_build_object('matched', false, 'score', coalesce(best.score, 0), 'vague', cardinality(chat.words(p_text)) = 0);
END;
$$;

CREATE FUNCTION chat.save_settings(p_tenant UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  saved chat.settings;
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  IF char_length(coalesce(p_data->>'welcome_message', '')) > 500 OR char_length(coalesce(p_data->>'handoff_message', '')) > 500 THEN
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
  UPDATE chat.settings SET
    enabled = coalesce((p_data->>'enabled')::boolean, enabled),
    bot_enabled = coalesce((p_data->>'bot_enabled')::boolean, bot_enabled),
    welcome_message = CASE WHEN p_data ? 'welcome_message' THEN btrim(coalesce(p_data->>'welcome_message', '')) ELSE welcome_message END,
    handoff_message = CASE WHEN p_data ? 'handoff_message' THEN btrim(p_data->>'handoff_message') ELSE handoff_message END,
    opening_hours = CASE WHEN p_data ? 'opening_hours' THEN btrim(coalesce(p_data->>'opening_hours', '')) ELSE opening_hours END,
    colour = CASE WHEN p_data ? 'colour' THEN lower(p_data->>'colour') ELSE colour END,
    updated_at = now()
  WHERE tenant_id = p_tenant RETURNING * INTO saved;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  RETURN row_to_json(saved);
END;
$$;

-- A new key stops the old link and embeds from working, and ends every visitor's access to old chats
CREATE FUNCTION chat.new_key(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  fresh TEXT := chat.new_public_key();
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  UPDATE chat.settings SET public_key = fresh, updated_at = now() WHERE tenant_id = p_tenant;
  RETURN json_build_object('public_key', fresh);
END;
$$;

-- ---------- Visitors (no login) ----------

CREATE FUNCTION public.chat_info(p_key TEXT)
RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT json_build_object('company', t.name, 'welcome', s.welcome_message, 'hours', s.opening_hours,
    'colour', s.colour, 'bot', s.bot_enabled)
  FROM chat.settings s JOIN public.tenants t ON t.id = s.tenant_id
  WHERE s.public_key = p_key AND s.enabled;
$$;

CREATE FUNCTION public.chat_start(p_key TEXT, p_visitor JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  setting chat.settings;
  v_name TEXT := nullif(btrim(coalesce(p_visitor->>'name', '')), '');
  v_email TEXT := chat.check_email(p_visitor->>'email');
  v_page TEXT := nullif(left(btrim(coalesce(p_visitor->>'page', '')), 500), '');
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

  INSERT INTO chat.conversations (tenant_id, token, visitor_name, visitor_email, started_on)
    VALUES (setting.tenant_id, v_token, v_name, v_email, v_page) RETURNING id INTO made;
  IF setting.welcome_message <> '' THEN
    INSERT INTO chat.messages (conversation_id, tenant_id, sender, body) VALUES (made, setting.tenant_id, 'bot', setting.welcome_message);
  END IF;
  RETURN (jsonb_build_object('token', v_token) || chat.visitor_state(made, 0)::jsonb)::json;
END;
$$;

CREATE FUNCTION public.chat_poll(p_key TEXT, p_token TEXT, p_after BIGINT)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  picked UUID;
BEGIN
  IF coalesce(p_token, '') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'This chat is not available';
  END IF;
  SELECT c.id INTO picked FROM chat.conversations c JOIN chat.settings s ON s.tenant_id = c.tenant_id
    WHERE c.token = p_token AND s.public_key = p_key AND s.enabled;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This chat is not available';
  END IF;
  RETURN chat.visitor_state(picked, p_after);
END;
$$;

CREATE FUNCTION public.chat_send(p_key TEXT, p_token TEXT, p_body TEXT, p_after BIGINT)
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
        VALUES (convo.id, convo.tenant_id, 'bot', setting.handoff_message
          || CASE WHEN setting.opening_hours <> '' THEN ' Our hours: ' || setting.opening_hours ELSE '' END);
      wants := true;
      needs_person := true;
    END IF;
  END IF;

  IF needs_person THEN
    new_status := 'waiting';
  END IF;
  UPDATE chat.conversations SET status = new_status, wants_person = wants, closed_at = NULL,
    staff_unread = staff_unread + 1, visitor_messages = visitor_messages + 1,
    last_message = left(body, 200), last_message_at = now()
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

-- The visitor asks for a person, without the bot trying first
CREATE FUNCTION public.chat_person(p_key TEXT, p_token TEXT, p_after BIGINT)
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
    VALUES (convo.id, convo.tenant_id, 'bot', setting.handoff_message
      || CASE WHEN setting.opening_hours <> '' THEN ' Our hours: ' || setting.opening_hours ELSE '' END);
  UPDATE chat.conversations SET wants_person = true, status = 'waiting', closed_at = NULL, last_message_at = now()
    WHERE id = convo.id RETURNING * INTO convo;
  PERFORM chat.alert_staff(convo, chat.visitor_label(convo) || ' wants to talk to a person', coalesce(convo.last_message, ''));
  RETURN chat.visitor_state(convo.id, p_after);
END;
$$;

CREATE FUNCTION public.chat_contact(p_key TEXT, p_token TEXT, p_name TEXT, p_email TEXT, p_after BIGINT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
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
  INSERT INTO chat.messages (conversation_id, tenant_id, sender, body)
    VALUES (convo.id, convo.tenant_id, 'system', 'Thanks. Someone will reply here soon. If you leave, we can reach you at ' || v_email || '.');
  RETURN chat.visitor_state(convo.id, p_after);
END;
$$;

-- ---------- Access ----------
DO $$
DECLARE
  fn TEXT;
BEGIN
  -- Helpers used inside other functions, never called directly
  FOREACH fn IN ARRAY ARRAY['chat.new_public_key()', 'chat.seed_defaults(uuid)', 'chat.seed_for_new_tenant()',
      'chat.common_words()', 'chat.words(text)', 'chat.same_word(text, text)', 'chat.prepare_answer()',
      'chat.find_answer(uuid, text)', 'chat.use_quota(uuid, text)', 'chat.visitor_conversation(text, text)',
      'chat.visitor_state(uuid, bigint)', 'chat.alert_staff(chat.conversations, text, text)',
      'chat.visitor_label(chat.conversations)', 'chat.check_email(text)', 'chat.staff_conversation(uuid, uuid)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
  END LOOP;
  FOREACH fn IN ARRAY ARRAY['chat.is_member(uuid)', 'chat.is_manager(uuid)', 'chat.overview(uuid)', 'chat.team(uuid)',
      'chat.reply(uuid, uuid, text)', 'chat.assign(uuid, uuid, uuid)', 'chat.set_status(uuid, uuid, text)',
      'chat.mark_read(uuid, uuid)', 'chat.make_lead(uuid, uuid)', 'chat.save_answer(uuid, uuid, jsonb)',
      'chat.delete_answer(uuid, uuid)', 'chat.dismiss_unanswered(uuid, uuid)', 'chat.test_bot(uuid, text)',
      'chat.save_settings(uuid, jsonb)', 'chat.new_key(uuid)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
  END LOOP;
  -- Visitors, through the gateway's public chat routes
  FOREACH fn IN ARRAY ARRAY['public.chat_info(text)', 'public.chat_start(text, jsonb)', 'public.chat_poll(text, text, bigint)',
      'public.chat_send(text, text, text, bigint)', 'public.chat_person(text, text, bigint)',
      'public.chat_contact(text, text, text, text, bigint)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon', fn);
  END LOOP;
END;
$$;

-- Add chat to the schemas the API serves, keeping whatever other products have added
DO $$
DECLARE
  current_list TEXT;
BEGIN
  SELECT substring(setting FROM '^pgrst\.db_schemas=(.*)$') INTO current_list
    FROM pg_roles r, unnest(r.rolconfig) AS setting
    WHERE r.rolname = 'authenticator' AND setting LIKE 'pgrst.db_schemas=%';
  current_list := coalesce(current_list, 'public, graphql_public');
  IF NOT ('chat' = ANY (string_to_array(replace(current_list, ' ', ''), ','))) THEN
    EXECUTE format('ALTER ROLE authenticator SET pgrst.db_schemas = %L', current_list || ', chat');
  END IF;
END;
$$;
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';
