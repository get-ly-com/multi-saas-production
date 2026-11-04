-- Business Brain. The Brain looks at the whole company, proposes ideas with evidence, pros, cons and
-- risks, and waits. Nothing changes in the business until an owner or admin approves an idea in the
-- app (brain.decide). Approved actions are then carried out by brain-service through the gateway as
-- the approving person, so every normal permission check still applies, and each idea is checked
-- again later to see whether it worked. What owners approve, reject and say about ideas is kept in
-- brain.learnings and fed back into the Brain's thinking.
--
-- Everyone in the company can read ideas. Only the service role (brain-service) and the functions
-- below can write. AI tools connected over MCP can submit ideas (as pending) but never approve them.
--
-- Also extends the public API functions (integrations.api_list / api_get) with search, newest-first
-- and three more resources (customers, bookings, stock_levels). Existing calls work as before.

CREATE SCHEMA IF NOT EXISTS brain;
GRANT USAGE ON SCHEMA brain TO authenticated, service_role;

-- ---------------------------------------------------------------- role checks
CREATE OR REPLACE FUNCTION brain.role_in(p_tenant UUID)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT role FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION brain.is_member(p_tenant UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = auth.uid());
$$;

-- ---------------------------------------------------------------- tables
CREATE TABLE IF NOT EXISTS brain.proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  category TEXT NOT NULL CHECK (category IN ('cash', 'sales', 'stock', 'people', 'marketing', 'operations', 'risk')),
  summary TEXT NOT NULL DEFAULT '' CHECK (length(summary) <= 2000),
  -- [{fact, number, source}]
  evidence JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(evidence) = 'array'),
  pros TEXT[] NOT NULL DEFAULT '{}',
  cons TEXT[] NOT NULL DEFAULT '{}',
  risks TEXT[] NOT NULL DEFAULT '{}',
  -- {metric, amount, currency, timeframe_days, confidence 0-1}
  expected_impact JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(expected_impact) = 'object'),
  effort TEXT NOT NULL DEFAULT 'M' CHECK (effort IN ('S', 'M', 'L')),
  -- [{type, params, label}] from the action catalog; [] means advice only
  actions JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(actions) = 'array'),
  -- 'brain', 'rules', or the AI tool's name (with source_key_id) for ideas sent over MCP
  source TEXT NOT NULL DEFAULT 'brain' CHECK (length(source) BETWEEN 1 AND 120),
  source_key_id UUID REFERENCES integrations.api_keys(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'changes_requested', 'executing', 'done', 'failed', 'expired')),
  decided_by UUID,
  decided_at TIMESTAMPTZ,
  decision_note TEXT CHECK (length(decision_note) <= 1000),
  -- The same idea is not proposed twice while one is open
  dedupe_key TEXT CHECK (length(dedupe_key) <= 200),
  -- How to measure later whether it worked, and when
  check_spec JSONB,
  check_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  result_summary TEXT CHECK (length(result_summary) <= 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '14 days'
);

CREATE UNIQUE INDEX IF NOT EXISTS proposals_open_dedupe ON brain.proposals (tenant_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'changes_requested', 'approved', 'executing');
CREATE INDEX IF NOT EXISTS proposals_tenant_status ON brain.proposals (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS proposals_due_checks ON brain.proposals (check_at) WHERE check_at IS NOT NULL AND status = 'done';

CREATE TABLE IF NOT EXISTS brain.action_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  proposal_id UUID NOT NULL REFERENCES brain.proposals(id) ON DELETE CASCADE,
  position INT NOT NULL,
  action TEXT NOT NULL CHECK (length(action) <= 60),
  params JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('done', 'failed', 'skipped')),
  -- What happened, in plain words, plus anything useful (ids, links)
  result JSONB,
  error TEXT CHECK (length(error) <= 1000),
  ran_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS action_runs_proposal ON brain.action_runs (proposal_id, position);

CREATE TABLE IF NOT EXISTS brain.outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  proposal_id UUID NOT NULL UNIQUE REFERENCES brain.proposals(id) ON DELETE CASCADE,
  metric TEXT NOT NULL CHECK (length(metric) <= 60),
  baseline NUMERIC,
  value NUMERIC,
  measured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verdict TEXT NOT NULL CHECK (verdict IN ('worked', 'partly', 'didnt')),
  note TEXT CHECK (length(note) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS brain.learnings (
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('cash', 'sales', 'stock', 'people', 'marketing', 'operations', 'risk')),
  approved_count INT NOT NULL DEFAULT 0,
  rejected_count INT NOT NULL DEFAULT 0,
  changes_count INT NOT NULL DEFAULT 0,
  worked_count INT NOT NULL DEFAULT 0,
  partly_count INT NOT NULL DEFAULT 0,
  didnt_count INT NOT NULL DEFAULT 0,
  -- The last few reasons people gave for rejecting or asking for changes: [{title, note, decision, at}]
  recent_notes JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(recent_notes) = 'array'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, category)
);

-- When the Brain last thought for each company (one think every 10 minutes at most)
CREATE TABLE IF NOT EXISTS brain.state (
  tenant_id UUID PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  last_think_at TIMESTAMPTZ,
  last_think_source TEXT
);

ALTER TABLE brain.proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE brain.action_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE brain.outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE brain.learnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE brain.state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_rows ON brain.proposals;
DROP POLICY IF EXISTS tenant_rows ON brain.action_runs;
DROP POLICY IF EXISTS tenant_rows ON brain.outcomes;
DROP POLICY IF EXISTS tenant_rows ON brain.learnings;
CREATE POLICY tenant_rows ON brain.proposals FOR SELECT TO authenticated USING (brain.is_member(tenant_id));
CREATE POLICY tenant_rows ON brain.action_runs FOR SELECT TO authenticated USING (brain.is_member(tenant_id));
CREATE POLICY tenant_rows ON brain.outcomes FOR SELECT TO authenticated USING (brain.is_member(tenant_id));
CREATE POLICY tenant_rows ON brain.learnings FOR SELECT TO authenticated USING (brain.is_member(tenant_id));

-- Members read; nobody writes directly. brain.state is only for the service.
REVOKE ALL ON brain.proposals, brain.action_runs, brain.outcomes, brain.learnings, brain.state FROM PUBLIC, anon, authenticated;
GRANT SELECT ON brain.proposals, brain.action_runs, brain.outcomes, brain.learnings TO authenticated;
GRANT SELECT ON brain.proposals, brain.action_runs, brain.outcomes, brain.learnings, brain.state TO service_role;

-- ---------------------------------------------------------------- shapes
CREATE OR REPLACE FUNCTION brain.proposal_json(p brain.proposals)
RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT json_build_object(
    'id', p.id, 'title', p.title, 'category', p.category, 'summary', p.summary,
    'evidence', p.evidence, 'pros', p.pros, 'cons', p.cons, 'risks', p.risks,
    'expected_impact', p.expected_impact, 'effort', p.effort, 'actions', p.actions,
    'source', p.source, 'status', p.status,
    'decided_by', p.decided_by, 'decided_at', p.decided_at, 'decision_note', p.decision_note,
    'created_at', p.created_at, 'expires_at', p.expires_at, 'executed_at', p.executed_at,
    'check_at', p.check_at, 'result_summary', p.result_summary,
    'runs', (SELECT coalesce(json_agg(json_build_object('position', r.position, 'action', r.action, 'status', r.status,
        'result', r.result, 'error', r.error, 'at', r.created_at) ORDER BY r.position, r.created_at), '[]'::json)
      FROM brain.action_runs r WHERE r.proposal_id = p.id),
    'outcome', (SELECT json_build_object('metric', o.metric, 'baseline', o.baseline, 'value', o.value,
        'verdict', o.verdict, 'note', o.note, 'measured_at', o.measured_at)
      FROM brain.outcomes o WHERE o.proposal_id = p.id)
  );
$$;

-- ---------------------------------------------------------------- members
CREATE OR REPLACE FUNCTION brain.list_proposals(p_tenant UUID, p_status TEXT DEFAULT NULL, p_limit INT DEFAULT 50)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT brain.is_member(p_tenant) THEN
    RAISE EXCEPTION 'Company not found';
  END IF;
  RETURN brain.proposals_for(p_tenant, p_status, p_limit);
END;
$$;

-- Shared by the member and service versions. 'open' means waiting for a decision.
CREATE OR REPLACE FUNCTION brain.proposals_for(p_tenant UUID, p_status TEXT, p_limit INT)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  wanted TEXT[];
BEGIN
  IF p_status IS NULL OR p_status IN ('', 'all') THEN
    wanted := NULL;
  ELSIF p_status = 'open' THEN
    wanted := ARRAY['pending', 'changes_requested'];
  ELSIF p_status IN ('pending', 'approved', 'rejected', 'changes_requested', 'executing', 'done', 'failed', 'expired') THEN
    wanted := ARRAY[p_status];
  ELSE
    RAISE EXCEPTION 'Choose a status: open, pending, approved, rejected, changes_requested, executing, done, failed, expired or all';
  END IF;
  RETURN (SELECT coalesce(json_agg(brain.proposal_json(x.p) ORDER BY (x.p).created_at DESC), '[]'::json)
    FROM (SELECT p FROM brain.proposals p
          WHERE p.tenant_id = p_tenant AND (wanted IS NULL OR p.status = ANY (wanted))
          ORDER BY p.created_at DESC
          LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)) x);
END;
$$;

CREATE OR REPLACE FUNCTION brain.get_proposal(p_tenant UUID, p_proposal UUID)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  found brain.proposals;
BEGIN
  IF NOT brain.is_member(p_tenant) THEN
    RAISE EXCEPTION 'Company not found';
  END IF;
  SELECT * INTO found FROM brain.proposals p WHERE p.id = p_proposal AND p.tenant_id = p_tenant;
  IF found.id IS NULL THEN
    RAISE EXCEPTION 'Idea not found';
  END IF;
  RETURN brain.proposal_json(found);
END;
$$;

-- The company's memory: decisions, outcomes and what the Brain has learned
CREATE OR REPLACE FUNCTION brain.history_for(p_tenant UUID, p_limit INT DEFAULT 30)
RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT json_build_object(
    'decisions', (SELECT coalesce(json_agg(brain.proposal_json(x.p) ORDER BY (x.p).decided_at DESC), '[]'::json)
      FROM (SELECT p FROM brain.proposals p
            WHERE p.tenant_id = p_tenant AND p.decided_at IS NOT NULL
            ORDER BY p.decided_at DESC LIMIT least(greatest(coalesce(p_limit, 30), 1), 100)) x),
    'learnings', (SELECT coalesce(json_agg(json_build_object(
        'category', l.category, 'approved', l.approved_count, 'rejected', l.rejected_count,
        'changes_requested', l.changes_count, 'worked', l.worked_count, 'partly', l.partly_count,
        'didnt', l.didnt_count, 'recent_notes', l.recent_notes) ORDER BY l.category), '[]'::json)
      FROM brain.learnings l WHERE l.tenant_id = p_tenant)
  );
$$;

CREATE OR REPLACE FUNCTION brain.history(p_tenant UUID, p_limit INT DEFAULT 30)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT brain.is_member(p_tenant) THEN
    RAISE EXCEPTION 'Company not found';
  END IF;
  RETURN brain.history_for(p_tenant, p_limit);
END;
$$;

-- Keeps the last 5 reasons people gave, newest first
CREATE OR REPLACE FUNCTION brain.learn(p_tenant UUID, p_category TEXT, p_field TEXT, p_title TEXT, p_note TEXT, p_decision TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  INSERT INTO brain.learnings (tenant_id, category) VALUES (p_tenant, p_category) ON CONFLICT DO NOTHING;
  UPDATE brain.learnings l SET
    approved_count = l.approved_count + CASE WHEN p_field = 'approved' THEN 1 ELSE 0 END,
    rejected_count = l.rejected_count + CASE WHEN p_field = 'rejected' THEN 1 ELSE 0 END,
    changes_count = l.changes_count + CASE WHEN p_field = 'changes' THEN 1 ELSE 0 END,
    worked_count = l.worked_count + CASE WHEN p_field = 'worked' THEN 1 ELSE 0 END,
    partly_count = l.partly_count + CASE WHEN p_field = 'partly' THEN 1 ELSE 0 END,
    didnt_count = l.didnt_count + CASE WHEN p_field = 'didnt' THEN 1 ELSE 0 END,
    recent_notes = CASE WHEN nullif(btrim(coalesce(p_note, '')), '') IS NULL THEN l.recent_notes ELSE
      (SELECT coalesce(jsonb_agg(e ORDER BY n), '[]'::jsonb) FROM (
        SELECT e, n FROM jsonb_array_elements(
          jsonb_build_array(jsonb_build_object('title', left(p_title, 200), 'note', left(p_note, 300),
            'decision', p_decision, 'at', now())) || l.recent_notes) WITH ORDINALITY AS x(e, n)
        WHERE n <= 5) y) END,
    updated_at = now()
  WHERE l.tenant_id = p_tenant AND l.category = p_category;
END;
$$;

-- An owner or admin decides on an idea: approve, reject or request_changes.
-- Approving only marks it approved; brain-service then carries out the actions as that person.
CREATE OR REPLACE FUNCTION brain.decide(p_proposal UUID, p_decision TEXT, p_note TEXT DEFAULT NULL)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  found brain.proposals;
  v_role TEXT;
  v_note TEXT := nullif(btrim(coalesce(p_note, '')), '');
  v_status TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in required';
  END IF;
  SELECT * INTO found FROM brain.proposals p WHERE p.id = p_proposal FOR UPDATE;
  IF found.id IS NULL THEN
    RAISE EXCEPTION 'Idea not found';
  END IF;
  v_role := brain.role_in(found.tenant_id);
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Idea not found';
  END IF;
  IF v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only owners and admins can decide on ideas';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject', 'request_changes') THEN
    RAISE EXCEPTION 'Choose approve, reject or request changes';
  END IF;
  IF found.status NOT IN ('pending', 'changes_requested') THEN
    RAISE EXCEPTION 'This idea has already been decided';
  END IF;
  IF found.expires_at <= now() THEN
    RAISE EXCEPTION 'This idea has expired. Ask the Brain to think again for a fresh one.';
  END IF;
  IF length(v_note) > 1000 THEN
    RAISE EXCEPTION 'Keep the note under 1000 characters';
  END IF;
  IF p_decision = 'request_changes' AND v_note IS NULL THEN
    RAISE EXCEPTION 'Say what should change';
  END IF;

  v_status := CASE p_decision WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE 'changes_requested' END;
  UPDATE brain.proposals p SET status = v_status, decided_by = auth.uid(), decided_at = now(),
      decision_note = v_note, updated_at = now()
    WHERE p.id = found.id
    RETURNING * INTO found;

  PERFORM brain.learn(found.tenant_id, found.category,
    CASE p_decision WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE 'changes' END,
    found.title, CASE WHEN p_decision = 'approve' THEN NULL ELSE v_note END, p_decision);

  RETURN brain.proposal_json(found);
END;
$$;

-- ---------------------------------------------------------------- service only
-- Adds an idea. Returns {created, id} or {created: false, reason}. Skips an idea that is already open,
-- was rejected in the last 14 days, or when the company already has 10 ideas waiting.
CREATE OR REPLACE FUNCTION brain.add_proposal(p_tenant UUID, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_key TEXT := nullif(left(btrim(coalesce(p_data->>'dedupe_key', '')), 200), '');
  v_title TEXT := left(btrim(coalesce(p_data->>'title', '')), 200);
  v_open INT;
  v_texts TEXT[];
  made brain.proposals;
  list_of JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = p_tenant AND t.is_active IS NOT FALSE) THEN
    RAISE EXCEPTION 'Company not found';
  END IF;
  IF length(v_title) = 0 THEN
    RAISE EXCEPTION 'An idea needs a title';
  END IF;
  IF v_key IS NOT NULL AND EXISTS (SELECT 1 FROM brain.proposals p WHERE p.tenant_id = p_tenant AND p.dedupe_key = v_key
      AND (p.status IN ('pending', 'changes_requested', 'approved', 'executing')
           OR (p.status = 'rejected' AND p.decided_at > now() - interval '14 days'))) THEN
    RETURN json_build_object('created', false, 'reason', 'duplicate');
  END IF;
  -- Serialise adds per company so the cap holds
  PERFORM pg_advisory_xact_lock(hashtextextended('brain:' || p_tenant::text, 53));
  SELECT count(*) INTO v_open FROM brain.proposals p WHERE p.tenant_id = p_tenant AND p.status IN ('pending', 'changes_requested');
  IF v_open >= 10 THEN
    RETURN json_build_object('created', false, 'reason', 'too_many_open');
  END IF;

  INSERT INTO brain.proposals (tenant_id, title, category, summary, evidence, pros, cons, risks, expected_impact,
      effort, actions, source, source_key_id, dedupe_key, check_spec)
    VALUES (p_tenant, v_title, p_data->>'category', left(coalesce(p_data->>'summary', ''), 2000),
      coalesce(p_data->'evidence', '[]'),
      coalesce((SELECT array_agg(left(e, 300)) FROM jsonb_array_elements_text(coalesce(p_data->'pros', '[]')) e), '{}'),
      coalesce((SELECT array_agg(left(e, 300)) FROM jsonb_array_elements_text(coalesce(p_data->'cons', '[]')) e), '{}'),
      coalesce((SELECT array_agg(left(e, 300)) FROM jsonb_array_elements_text(coalesce(p_data->'risks', '[]')) e), '{}'),
      coalesce(p_data->'expected_impact', '{}'), coalesce(p_data->>'effort', 'M'), coalesce(p_data->'actions', '[]'),
      left(coalesce(nullif(btrim(p_data->>'source'), ''), 'brain'), 120),
      CASE WHEN coalesce(p_data->>'source_key_id', '') ~* '^[0-9a-f-]{36}$' THEN (p_data->>'source_key_id')::uuid END,
      v_key, CASE WHEN jsonb_typeof(p_data->'check_spec') = 'object' THEN p_data->'check_spec' END)
    RETURNING * INTO made;
  RETURN json_build_object('created', true, 'id', made.id, 'proposal', brain.proposal_json(made));
EXCEPTION WHEN unique_violation THEN
  RETURN json_build_object('created', false, 'reason', 'duplicate');
END;
$$;

-- One think per company every p_minutes. True when this caller may think now.
CREATE OR REPLACE FUNCTION brain.claim_think(p_tenant UUID, p_minutes INT, p_source TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  claimed UUID;
BEGIN
  INSERT INTO brain.state (tenant_id, last_think_at, last_think_source) VALUES (p_tenant, now(), left(p_source, 120))
  ON CONFLICT (tenant_id) DO UPDATE SET last_think_at = now(), last_think_source = left(p_source, 120)
    WHERE brain.state.last_think_at IS NULL OR brain.state.last_think_at < now() - make_interval(mins => greatest(coalesce(p_minutes, 10), 0))
  RETURNING tenant_id INTO claimed;
  RETURN claimed IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION brain.think_wait_minutes(p_tenant UUID, p_minutes INT)
RETURNS INT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT greatest(1, ceil(extract(epoch FROM (s.last_think_at + make_interval(mins => p_minutes) - now())) / 60)::int)
  FROM brain.state s WHERE s.tenant_id = p_tenant;
$$;

-- Moves an approved idea to executing. Only once, so actions never run twice.
CREATE OR REPLACE FUNCTION brain.start_run(p_tenant UUID, p_proposal UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  found brain.proposals;
BEGIN
  UPDATE brain.proposals p SET status = 'executing', updated_at = now()
    WHERE p.id = p_proposal AND p.tenant_id = p_tenant AND p.status = 'approved'
    RETURNING * INTO found;
  IF found.id IS NULL THEN
    RAISE EXCEPTION 'This idea is not waiting to be carried out';
  END IF;
  RETURN brain.proposal_json(found);
END;
$$;

CREATE OR REPLACE FUNCTION brain.record_run(p_tenant UUID, p_proposal UUID, p_position INT, p_action TEXT, p_params JSONB,
  p_status TEXT, p_result JSONB, p_error TEXT, p_user UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM brain.proposals p WHERE p.id = p_proposal AND p.tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'Idea not found';
  END IF;
  INSERT INTO brain.action_runs (tenant_id, proposal_id, position, action, params, status, result, error, ran_by)
    VALUES (p_tenant, p_proposal, p_position, left(p_action, 60), coalesce(p_params, '{}'), p_status, p_result,
      left(p_error, 1000), p_user);
END;
$$;

CREATE OR REPLACE FUNCTION brain.finish_proposal(p_tenant UUID, p_proposal UUID, p_status TEXT, p_summary TEXT,
  p_check_at TIMESTAMPTZ, p_check_spec JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  found brain.proposals;
BEGIN
  IF p_status NOT IN ('done', 'failed') THEN
    RAISE EXCEPTION 'Finish as done or failed';
  END IF;
  UPDATE brain.proposals p SET status = p_status, executed_at = now(), updated_at = now(),
      result_summary = left(p_summary, 4000),
      check_at = CASE WHEN p_status = 'done' THEN p_check_at END,
      check_spec = coalesce(p_check_spec, p.check_spec)
    WHERE p.id = p_proposal AND p.tenant_id = p_tenant AND p.status = 'executing'
    RETURNING * INTO found;
  IF found.id IS NULL THEN
    RAISE EXCEPTION 'This idea is not being carried out';
  END IF;
  RETURN brain.proposal_json(found);
END;
$$;

-- Ideas whose check date has come and that have no outcome yet
CREATE OR REPLACE FUNCTION brain.due_checks(p_limit INT DEFAULT 200)
RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce(json_agg(json_build_object('id', p.id, 'tenant_id', p.tenant_id, 'title', p.title,
      'category', p.category, 'check_spec', p.check_spec, 'expected_impact', p.expected_impact,
      'executed_at', p.executed_at)), '[]'::json)
  FROM (SELECT * FROM brain.proposals x
        WHERE x.status = 'done' AND x.check_at IS NOT NULL AND x.check_at <= now()
          AND NOT EXISTS (SELECT 1 FROM brain.outcomes o WHERE o.proposal_id = x.id)
        ORDER BY x.check_at LIMIT least(greatest(coalesce(p_limit, 200), 1), 1000)) p;
$$;

CREATE OR REPLACE FUNCTION brain.record_outcome(p_proposal UUID, p_metric TEXT, p_baseline NUMERIC, p_value NUMERIC,
  p_verdict TEXT, p_note TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  found brain.proposals;
BEGIN
  SELECT * INTO found FROM brain.proposals p WHERE p.id = p_proposal;
  IF found.id IS NULL THEN
    RAISE EXCEPTION 'Idea not found';
  END IF;
  INSERT INTO brain.outcomes (tenant_id, proposal_id, metric, baseline, value, verdict, note)
    VALUES (found.tenant_id, found.id, left(p_metric, 60), p_baseline, p_value, p_verdict, left(p_note, 1000))
    ON CONFLICT (proposal_id) DO NOTHING;
  IF FOUND THEN
    PERFORM brain.learn(found.tenant_id, found.category, p_verdict, found.title, NULL, NULL);
  END IF;
END;
$$;

-- Ideas nobody decided on in time
CREATE OR REPLACE FUNCTION brain.expire_old()
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  changed INT;
BEGIN
  UPDATE brain.proposals p SET status = 'expired', updated_at = now()
    WHERE p.status IN ('pending', 'changes_requested') AND p.expires_at <= now();
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END;
$$;

-- Tells the company's owners and admins through the staff notifications (the bell)
CREATE OR REPLACE FUNCTION brain.notify_reviewers(p_tenant UUID, p_count INT)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  sent INT;
BEGIN
  IF coalesce(p_count, 0) < 1 THEN
    RETURN 0;
  END IF;
  INSERT INTO crm.notifications (tenant_id, user_id, title, body, link, dedupe_key)
  SELECT p_tenant, m.user_id,
    CASE WHEN p_count = 1 THEN '1 new idea to review' ELSE p_count || ' new ideas to review' END,
    'The Business Brain has new ideas for you. Nothing changes until you approve one.',
    '/saas/brain', 'brain:ideas:' || to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS')
  FROM public.tenant_members m
  WHERE m.tenant_id = p_tenant AND m.role IN ('owner', 'admin')
  ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS sent = ROW_COUNT;
  RETURN sent;
END;
$$;

-- Companies the daily job thinks for: active, with an owner
CREATE OR REPLACE FUNCTION brain.active_tenants()
RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce(json_agg(t.id ORDER BY t.created_at), '[]'::json)
  FROM public.tenants t
  WHERE t.is_active IS NOT FALSE
    AND EXISTS (SELECT 1 FROM public.tenant_members m WHERE m.tenant_id = t.id AND m.role = 'owner');
$$;

-- The dashboard numbers for the whole company, without a signed-in person (daily job, MCP).
-- Runs analytics.dashboard / analytics.compare as the company's first owner, so the numbers are
-- exactly what that owner sees in the app. The setting lasts only for this transaction.
CREATE OR REPLACE FUNCTION brain.company_numbers(p_tenant UUID, p_kind TEXT, p_from DATE, p_to DATE)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_owner UUID;
  old_claims TEXT := current_setting('request.jwt.claims', true);
  old_sub TEXT := current_setting('request.jwt.claim.sub', true);
  result JSON;
BEGIN
  IF p_kind NOT IN ('dashboard', 'compare') THEN
    RAISE EXCEPTION 'Choose dashboard or compare';
  END IF;
  SELECT m.user_id INTO v_owner FROM public.tenant_members m
    WHERE m.tenant_id = p_tenant AND m.role = 'owner' ORDER BY m.created_at LIMIT 1;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Company not found';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
  IF p_kind = 'dashboard' THEN
    result := analytics.dashboard(p_tenant, p_from, p_to);
  ELSE
    result := analytics.compare(p_tenant, p_from, p_to);
  END IF;
  PERFORM set_config('request.jwt.claims', coalesce(old_claims, ''), true);
  PERFORM set_config('request.jwt.claim.sub', coalesce(old_sub, ''), true);
  RETURN result;
END;
$$;

-- Everything the Brain's rules read, for one company, in one call. Rows are shaped like the ones
-- the analytics assistant reads, so both use the same formatting code.
CREATE OR REPLACE FUNCTION brain.company_facts(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  today DATE := current_date;
  home TEXT;
  quiet_cutoff TIMESTAMP := (current_date - 14)::timestamp;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = p_tenant) THEN
    RAISE EXCEPTION 'Company not found';
  END IF;
  SELECT coalesce((SELECT s.base_currency FROM accounting.settings s WHERE s.tenant_id = p_tenant), 'USD') INTO home;

  RETURN json_build_object(
    'today', today,
    'currency', home,
    'company', (SELECT t.name FROM public.tenants t WHERE t.id = p_tenant),

    'overdue_invoices', (SELECT coalesce(json_agg(r ORDER BY r.due_date), '[]'::json) FROM (
      SELECT i.id, i.invoice_number, i.customer_name, i.customer_email, i.due_date, i.amount, i.amount_paid,
        i.amount_credited, i.currency, i.exchange_rate, i.customer_id,
        CASE WHEN c.id IS NULL THEN NULL ELSE json_build_object('name', c.name, 'phone', c.phone, 'email', c.email) END AS customer,
        (SELECT k.id FROM crm.contacts k WHERE k.tenant_id = p_tenant AND k.customer_id = i.customer_id
           ORDER BY k.created_at LIMIT 1) AS contact_id
      FROM accounting.invoices i LEFT JOIN accounting.customers c ON c.id = i.customer_id
      WHERE i.tenant_id = p_tenant AND i.status IN ('sent', 'partial') AND i.due_date < today
      ORDER BY i.due_date LIMIT 100) r),

    'bank_lines', (SELECT coalesce(json_agg(r), '[]'::json) FROM (
      SELECT b.id, b.line_date, b.description, b.amount FROM accounting.bank_lines b
      WHERE b.tenant_id = p_tenant AND b.status = 'unmatched' AND b.line_date >= today - 120
      ORDER BY b.line_date DESC LIMIT 300) r),

    'open_invoices', (SELECT coalesce(json_agg(r), '[]'::json) FROM (
      SELECT i.id, i.invoice_number, i.customer_name, i.invoice_date, i.due_date, i.amount, i.amount_paid,
        i.amount_credited, i.currency, i.exchange_rate,
        CASE WHEN c.id IS NULL THEN NULL ELSE json_build_object('name', c.name) END AS customer
      FROM accounting.invoices i LEFT JOIN accounting.customers c ON c.id = i.customer_id
      WHERE i.tenant_id = p_tenant AND i.status IN ('sent', 'partial') LIMIT 500) r),

    'open_bills', (SELECT coalesce(json_agg(r), '[]'::json) FROM (
      SELECT b.id, b.bill_number, b.bill_date, b.due_date, b.amount, b.amount_paid, b.currency, b.exchange_rate,
        CASE WHEN v.id IS NULL THEN NULL ELSE json_build_object('name', v.name) END AS vendor
      FROM accounting.bills b LEFT JOIN accounting.vendors v ON v.id = b.vendor_id
      WHERE b.tenant_id = p_tenant AND b.status IN ('open', 'partial') LIMIT 500) r),

    'items', (SELECT coalesce(json_agg(r), '[]'::json) FROM (
      SELECT i.id, i.sku, i.name, i.quantity, i.unit, i.vendor_id, i.reorder_level, i.reorder_to, i.avg_cost
      FROM inventory.items i WHERE i.tenant_id = p_tenant LIMIT 2000) r),

    -- What went out in the last 30 days, per item (sales and write-offs, not transfers or counts)
    'moves', (SELECT coalesce(json_agg(r), '[]'::json) FROM (
      SELECT m.item_id, sum(m.change) AS change FROM inventory.movements m
      WHERE m.tenant_id = p_tenant AND m.change < 0 AND m.transfer_id IS NULL AND m.count_id IS NULL
        AND m.created_at >= (today - 30)::timestamp
      GROUP BY m.item_id) r),

    'waiting_chats', (SELECT coalesce(json_agg(r ORDER BY r.last_message_at), '[]'::json) FROM (
      SELECT c.id, c.visitor_name, c.visitor_email, c.last_message, c.last_message_at, c.assigned_to
      FROM chat.conversations c WHERE c.tenant_id = p_tenant AND c.status = 'waiting' AND c.assigned_to IS NULL
      ORDER BY c.last_message_at LIMIT 50) r),

    'leave', (SELECT coalesce(json_agg(r ORDER BY r.start_date), '[]'::json) FROM (
      SELECT l.id, l.start_date, l.end_date, l.days,
        json_build_object('first_name', e.first_name, 'last_name', e.last_name, 'user_id', e.user_id) AS employee
      FROM hr.leave_requests l LEFT JOIN hr.employees e ON e.id = l.employee_id
      WHERE l.tenant_id = p_tenant AND l.status = 'pending' ORDER BY l.start_date LIMIT 50) r),

    'draft_pay_runs', (SELECT coalesce(json_agg(r ORDER BY r.period_end), '[]'::json) FROM (
      SELECT p.id, p.run_number, p.period_start, p.period_end, p.pay_date, p.net FROM hr.pay_runs p
      WHERE p.tenant_id = p_tenant AND p.status = 'draft'
        AND (p.period_end < date_trunc('month', today)::date OR p.pay_date < today)
      ORDER BY p.period_end LIMIT 24) r),

    'quiet_deals', (SELECT coalesce(json_agg(r ORDER BY r.value DESC NULLS LAST), '[]'::json) FROM (
      SELECT d.id, d.title, d.value, d.updated_at, d.stage_changed_at, d.created_at, d.contact_id,
        json_build_object('name', s.name, 'kind', s.kind) AS stage
      FROM crm.deals d JOIN crm.stages s ON s.id = d.stage_id
      WHERE d.tenant_id = p_tenant AND s.kind = 'open' AND d.updated_at < quiet_cutoff
        AND NOT EXISTS (SELECT 1 FROM crm.activities a WHERE a.tenant_id = p_tenant AND a.deal_id = d.id
          AND (a.created_at >= quiet_cutoff OR a.done_at >= quiet_cutoff OR a.updated_at >= quiet_cutoff))
      ORDER BY d.value DESC NULLS LAST LIMIT 200) r),

    -- Money in the bank and cash accounts now, in the home currency
    'cash_balance', (SELECT round(coalesce(sum(l.debit - l.credit), 0), 2) FROM accounting.journal_lines l
      JOIN accounting.accounts a ON a.id = l.account_id
      WHERE l.tenant_id = p_tenant AND a.is_cash),

    'recurring', (SELECT coalesce(json_agg(r), '[]'::json) FROM (
      SELECT ri.id, ri.name, ri.frequency, ri.start_date, ri.end_date, ri.runs_done, ri.due_days,
        round(coalesce((SELECT sum(coalesce((l->>'quantity')::numeric, 0) * coalesce((l->>'unit_price')::numeric, 0))
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ri.line_items) = 'array' THEN ri.line_items ELSE '[]'::jsonb END) l
          WHERE coalesce(l->>'quantity', '') ~ '^-?\d+(\.\d+)?$' AND coalesce(l->>'unit_price', '') ~ '^-?\d+(\.\d+)?$'), 0)
          * coalesce(ri.exchange_rate, 1), 2) AS amount
      FROM accounting.recurring_invoices ri WHERE ri.tenant_id = p_tenant AND ri.is_active) r),

    -- Payroll paid in the last 90 days, as a monthly average
    'monthly_payroll', (SELECT round(coalesce(sum(p.net), 0) / 3, 2) FROM hr.pay_runs p
      WHERE p.tenant_id = p_tenant AND p.status IN ('approved', 'paid')
        AND coalesce(p.pay_date, p.period_end) >= today - 90),

    -- Who the revenue of the last 12 months came from
    'customer_revenue', (SELECT json_build_object(
        'total', coalesce(sum(x.revenue), 0),
        'top', coalesce((SELECT json_agg(y ORDER BY y.revenue DESC) FROM (
          SELECT x2.customer, x2.customer_id, x2.revenue, x2.invoices FROM (
            SELECT coalesce(c.name, i.customer_name, 'Unnamed customer') AS customer, i.customer_id,
              round(sum(coalesce(i.base_amount, i.amount * coalesce(i.exchange_rate, 1))), 2) AS revenue, count(*) AS invoices
            FROM accounting.invoices i LEFT JOIN accounting.customers c ON c.id = i.customer_id
            WHERE i.tenant_id = p_tenant AND i.status <> 'void' AND coalesce(i.invoice_date, i.created_at::date) >= today - 365
              AND i.status <> 'draft'
            GROUP BY 1, 2) x2 ORDER BY x2.revenue DESC LIMIT 5) y), '[]'::json))
      FROM (SELECT sum(coalesce(i.base_amount, i.amount * coalesce(i.exchange_rate, 1))) AS revenue
            FROM accounting.invoices i
            WHERE i.tenant_id = p_tenant AND i.status NOT IN ('void', 'draft')
              AND coalesce(i.invoice_date, i.created_at::date) >= today - 365) x),

    -- Expense accounts: the last 30 days against the average of the 3 months before
    'expense_accounts', (SELECT coalesce(json_agg(r ORDER BY r.recent DESC), '[]'::json) FROM (
      SELECT a.id, a.code, a.name,
        round(coalesce(sum(l.debit - l.credit) FILTER (WHERE e.entry_date > today - 30), 0), 2) AS recent,
        round(coalesce(sum(l.debit - l.credit) FILTER (WHERE e.entry_date <= today - 30 AND e.entry_date > today - 120), 0) / 3, 2) AS monthly_average
      FROM accounting.journal_lines l
      JOIN accounting.journal_entries e ON e.id = l.entry_id
      JOIN accounting.accounts a ON a.id = l.account_id
      WHERE l.tenant_id = p_tenant AND a.type = 'expense' AND e.entry_date > today - 120 AND e.entry_date <= today
      GROUP BY a.id, a.code, a.name) r),

    'team', (SELECT coalesce(json_agg(json_build_object('user_id', m.user_id, 'role', m.role)), '[]'::json)
      FROM public.tenant_members m WHERE m.tenant_id = p_tenant)
  );
END;
$$;

-- One number for checking whether an idea worked. p_spec = {kind, ...}.
CREATE OR REPLACE FUNCTION brain.measure(p_tenant UUID, p_spec JSONB)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  kind TEXT := p_spec->>'kind';
  ids UUID[];
  since TIMESTAMP;
BEGIN
  IF jsonb_typeof(p_spec->'ids') = 'array' THEN
    SELECT coalesce(array_agg(e::uuid), '{}') INTO ids FROM jsonb_array_elements_text(p_spec->'ids') e
      WHERE e ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  END IF;
  BEGIN
    since := nullif(p_spec->>'since', '')::timestamp;
  EXCEPTION WHEN others THEN
    since := NULL;
  END;

  IF kind = 'invoices_owed' THEN
    RETURN (SELECT coalesce(sum(greatest(i.amount - coalesce(i.amount_paid, 0) - coalesce(i.amount_credited, 0), 0)
        * coalesce(i.exchange_rate, 1)), 0)
      FROM accounting.invoices i WHERE i.tenant_id = p_tenant AND i.id = ANY (ids) AND i.status IN ('sent', 'partial'));
  ELSIF kind = 'items_short' THEN
    RETURN (SELECT count(*) FROM inventory.items i WHERE i.tenant_id = p_tenant AND i.id = ANY (ids)
      AND i.quantity <= greatest(i.reorder_level, 0));
  ELSIF kind = 'deals_quiet' THEN
    RETURN (SELECT count(*) FROM crm.deals d JOIN crm.stages s ON s.id = d.stage_id
      WHERE d.tenant_id = p_tenant AND d.id = ANY (ids) AND s.kind = 'open'
        AND d.updated_at < coalesce(since, now()::timestamp)
        AND NOT EXISTS (SELECT 1 FROM crm.activities a WHERE a.deal_id = d.id AND a.tenant_id = p_tenant
          AND (a.done_at >= since OR (a.kind <> 'task' AND a.created_at >= since))));
  ELSIF kind = 'chats_waiting' THEN
    RETURN (SELECT count(*) FROM chat.conversations c WHERE c.tenant_id = p_tenant AND c.id = ANY (ids) AND c.status = 'waiting');
  ELSIF kind = 'overdue_total' THEN
    RETURN (SELECT round(coalesce(sum(greatest(i.amount - coalesce(i.amount_paid, 0) - coalesce(i.amount_credited, 0), 0)
        * coalesce(i.exchange_rate, 1)), 0), 2)
      FROM accounting.invoices i WHERE i.tenant_id = p_tenant AND i.status IN ('sent', 'partial') AND i.due_date < current_date);
  ELSIF kind = 'cash_balance' THEN
    RETURN (SELECT round(coalesce(sum(l.debit - l.credit), 0), 2) FROM accounting.journal_lines l
      JOIN accounting.accounts a ON a.id = l.account_id WHERE l.tenant_id = p_tenant AND a.is_cash);
  ELSIF kind = 'revenue_30d' THEN
    RETURN (SELECT round(coalesce(sum(coalesce(i.base_amount, i.amount * coalesce(i.exchange_rate, 1))), 0), 2)
      FROM accounting.invoices i WHERE i.tenant_id = p_tenant AND i.status NOT IN ('void', 'draft')
        AND coalesce(i.invoice_date, i.created_at::date) > current_date - 30);
  ELSIF kind = 'new_leads_30d' THEN
    RETURN (SELECT count(*) FROM crm.leads l WHERE l.tenant_id = p_tenant AND l.created_at > (current_date - 30)::timestamp);
  ELSIF kind = 'won_value_30d' THEN
    RETURN (SELECT round(coalesce(sum(d.value), 0), 2) FROM crm.deals d JOIN crm.stages s ON s.id = d.stage_id
      WHERE d.tenant_id = p_tenant AND s.kind = 'won' AND d.closed_at > (current_date - 30)::timestamp);
  END IF;
  RAISE EXCEPTION 'Unknown measure';
END;
$$;

-- ---------------------------------------------------------------- public API (integrations)
-- Checks a company API key (and counts it against the key's per-minute limit) and says who it is.
-- For brain-service's MCP server.
CREATE OR REPLACE FUNCTION integrations.api_key_info(p_key TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  company UUID := integrations.key_tenant(p_key);
  k integrations.api_keys;
BEGIN
  SELECT * INTO k FROM integrations.api_keys x
    WHERE x.key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex') AND x.tenant_id = company;
  RETURN json_build_object('tenant_id', k.tenant_id, 'key_id', k.id, 'scope', k.scope, 'name', k.name,
    'company', (SELECT t.name FROM public.tenants t WHERE t.id = k.tenant_id));
END;
$$;

-- The same rows as before, plus customers, bookings and stock_levels, a search and newest-first.
-- stock_levels rows are one per item and place; their id is the item's id.
CREATE OR REPLACE FUNCTION integrations.api_rows(p_tenant UUID, p_resource TEXT, p_id UUID, p_limit INT, p_offset INT,
  p_query TEXT, p_newest BOOLEAN)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  result JSON;
  q TEXT := nullif(btrim(left(coalesce(p_query, ''), 100)), '');
  pattern TEXT;
  newest BOOLEAN := coalesce(p_newest, false);
BEGIN
  -- The search is plain text: % and _ match themselves
  pattern := CASE WHEN q IS NULL THEN NULL
    ELSE '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%' END;

  IF p_resource = 'contacts' THEN
    SELECT coalesce(json_agg(r), '[]'::json) INTO result FROM (
      SELECT c.id, c.name, c.email, c.phone, c.job_title, c.company_id, c.source, c.created_at, c.updated_at
      FROM crm.contacts c WHERE c.tenant_id = p_tenant AND (p_id IS NULL OR c.id = p_id)
        AND (pattern IS NULL OR c.name ILIKE pattern OR c.email ILIKE pattern OR c.phone ILIKE pattern)
      ORDER BY CASE WHEN newest THEN c.created_at END DESC, c.created_at, c.id LIMIT p_limit OFFSET p_offset) r;
  ELSIF p_resource = 'invoices' THEN
    SELECT coalesce(json_agg(r), '[]'::json) INTO result FROM (
      SELECT i.id, i.invoice_number, i.status, i.customer_id, i.customer_name, i.invoice_date, i.due_date, i.currency,
        i.subtotal, i.tax_amount, i.amount, i.amount_paid, i.amount_credited, i.paid_at, i.created_at, i.updated_at
      FROM accounting.invoices i WHERE i.tenant_id = p_tenant AND (p_id IS NULL OR i.id = p_id)
        AND (pattern IS NULL OR i.invoice_number ILIKE pattern OR i.customer_name ILIKE pattern OR i.customer_email ILIKE pattern)
      ORDER BY CASE WHEN newest THEN i.created_at END DESC, i.created_at, i.id LIMIT p_limit OFFSET p_offset) r;
  ELSIF p_resource = 'items' THEN
    SELECT coalesce(json_agg(r), '[]'::json) INTO result FROM (
      SELECT t.id, t.sku, t.name, t.quantity, t.price, t.reorder_level, t.created_at, t.updated_at
      FROM inventory.items t WHERE t.tenant_id = p_tenant AND (p_id IS NULL OR t.id = p_id)
        AND (pattern IS NULL OR t.name ILIKE pattern OR t.sku ILIKE pattern OR t.barcode ILIKE pattern)
      ORDER BY CASE WHEN newest THEN t.created_at END DESC, t.created_at, t.id LIMIT p_limit OFFSET p_offset) r;
  ELSIF p_resource = 'deals' THEN
    SELECT coalesce(json_agg(r), '[]'::json) INTO result FROM (
      SELECT d.id, d.title, d.value, s.name AS stage, s.kind AS status, d.contact_id, d.company_id,
        d.expected_close, d.closed_at, d.created_at, d.updated_at
      FROM crm.deals d LEFT JOIN crm.stages s ON s.id = d.stage_id
      WHERE d.tenant_id = p_tenant AND (p_id IS NULL OR d.id = p_id)
        AND (pattern IS NULL OR d.title ILIKE pattern)
      ORDER BY CASE WHEN newest THEN d.created_at END DESC, d.created_at, d.id LIMIT p_limit OFFSET p_offset) r;
  ELSIF p_resource = 'leads' THEN
    SELECT coalesce(json_agg(r), '[]'::json) INTO result FROM (
      SELECT l.id, l.name, l.email, l.phone, l.company_name, l.job_title, l.source, l.campaign, l.status, l.score,
        l.converted_contact_id, l.converted_at, l.created_at, l.updated_at
      FROM crm.leads l WHERE l.tenant_id = p_tenant AND (p_id IS NULL OR l.id = p_id)
        AND (pattern IS NULL OR l.name ILIKE pattern OR l.email ILIKE pattern OR l.company_name ILIKE pattern)
      ORDER BY CASE WHEN newest THEN l.created_at END DESC, l.created_at, l.id LIMIT p_limit OFFSET p_offset) r;
  ELSIF p_resource = 'customers' THEN
    SELECT coalesce(json_agg(r), '[]'::json) INTO result FROM (
      SELECT c.id, c.name, c.email, c.phone, c.is_active, c.created_at
      FROM accounting.customers c WHERE c.tenant_id = p_tenant AND (p_id IS NULL OR c.id = p_id)
        AND (pattern IS NULL OR c.name ILIKE pattern OR c.email ILIKE pattern OR c.phone ILIKE pattern)
      ORDER BY CASE WHEN newest THEN c.created_at END DESC, c.created_at, c.id LIMIT p_limit OFFSET p_offset) r;
  ELSIF p_resource = 'bookings' THEN
    SELECT coalesce(json_agg(r), '[]'::json) INTO result FROM (
      SELECT b.id, b.status, b.starts_at, b.ends_at, sv.name AS service, b.staff_id, b.customer_name, b.customer_email,
        b.customer_phone, b.location_type, b.attendance, b.contact_id, b.invoice_id, b.source, b.created_at
      FROM scheduler.bookings b LEFT JOIN scheduler.services sv ON sv.id = b.service_id
      WHERE b.tenant_id = p_tenant AND (p_id IS NULL OR b.id = p_id)
        AND (pattern IS NULL OR b.customer_name ILIKE pattern OR b.customer_email ILIKE pattern OR sv.name ILIKE pattern)
      ORDER BY CASE WHEN newest THEN b.starts_at END DESC, b.starts_at, b.id LIMIT p_limit OFFSET p_offset) r;
  ELSIF p_resource = 'stock_levels' THEN
    SELECT coalesce(json_agg(r), '[]'::json) INTO result FROM (
      SELECT t.id, t.id AS item_id, t.sku, t.name, sl.location_id, lo.name AS location, sl.quantity, t.reorder_level
      FROM inventory.stock_levels sl
      JOIN inventory.items t ON t.id = sl.item_id
      LEFT JOIN inventory.locations lo ON lo.id = sl.location_id
      WHERE sl.tenant_id = p_tenant AND (p_id IS NULL OR t.id = p_id)
        AND (pattern IS NULL OR t.name ILIKE pattern OR t.sku ILIKE pattern OR lo.name ILIKE pattern)
      ORDER BY CASE WHEN newest THEN t.created_at END DESC, t.name, t.id, lo.name LIMIT p_limit OFFSET p_offset) r;
  ELSE
    RAISE EXCEPTION 'Unknown resource. Use contacts, invoices, items, deals, leads, customers, bookings or stock_levels.' USING ERRCODE = 'PT404';
  END IF;
  RETURN result;
END;
$$;

-- The old five-argument form stays for anything that still calls it
CREATE OR REPLACE FUNCTION integrations.api_rows(p_tenant UUID, p_resource TEXT, p_id UUID, p_limit INT, p_offset INT)
RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT integrations.api_rows(p_tenant, p_resource, p_id, p_limit, p_offset, NULL, false);
$$;

-- api_list gains an optional search and newest-first. Called with the old four arguments it
-- behaves exactly as before.
DROP FUNCTION IF EXISTS integrations.api_list(text, text, integer, integer);
CREATE FUNCTION integrations.api_list(p_key TEXT, p_resource TEXT, p_limit INTEGER DEFAULT 25, p_offset INTEGER DEFAULT 0,
  p_query TEXT DEFAULT NULL, p_newest BOOLEAN DEFAULT false)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  company UUID := integrations.key_tenant(p_key);
  page_size INT := least(greatest(coalesce(p_limit, 25), 1), (integrations.limits()->>'api_page_max')::int);
  start_at INT := least(greatest(coalesce(p_offset, 0), 0), 1000000);
  found JSON;
  more BOOLEAN;
BEGIN
  -- One extra row tells whether there is another page
  found := integrations.api_rows(company, p_resource, NULL, page_size + 1, start_at, p_query, p_newest);
  more := json_array_length(found) > page_size;
  IF more THEN
    SELECT json_agg(e) INTO found FROM (SELECT e FROM json_array_elements(found) WITH ORDINALITY AS x(e, n) WHERE n <= page_size ORDER BY n) y;
  END IF;
  RETURN json_build_object('object', 'list', 'resource', p_resource, 'data', found,
    'limit', page_size, 'offset', start_at, 'has_more', more,
    'next_offset', CASE WHEN more THEN start_at + page_size END);
END;
$$;

-- ---------------------------------------------------------------- who may call what
DO $$
DECLARE
  fn TEXT;
BEGIN
  -- Internal helpers: nobody calls these directly
  FOREACH fn IN ARRAY ARRAY['brain.proposal_json(brain.proposals)', 'brain.proposals_for(uuid, text, integer)',
      'brain.history_for(uuid, integer)', 'brain.learn(uuid, text, text, text, text, text)',
      'integrations.api_rows(uuid, text, uuid, integer, integer, text, boolean)',
      'integrations.api_rows(uuid, text, uuid, integer, integer)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn);
  END LOOP;

  -- Signed-in members (each checks the role itself)
  FOREACH fn IN ARRAY ARRAY['brain.role_in(uuid)', 'brain.is_member(uuid)', 'brain.list_proposals(uuid, text, integer)',
      'brain.get_proposal(uuid, uuid)', 'brain.history(uuid, integer)', 'brain.decide(uuid, text, text)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
  END LOOP;

  -- brain-service only
  FOREACH fn IN ARRAY ARRAY['brain.add_proposal(uuid, jsonb)', 'brain.claim_think(uuid, integer, text)',
      'brain.think_wait_minutes(uuid, integer)', 'brain.start_run(uuid, uuid)',
      'brain.record_run(uuid, uuid, integer, text, jsonb, text, jsonb, text, uuid)',
      'brain.finish_proposal(uuid, uuid, text, text, timestamptz, jsonb)', 'brain.due_checks(integer)',
      'brain.record_outcome(uuid, text, numeric, numeric, text, text)', 'brain.expire_old()',
      'brain.notify_reviewers(uuid, integer)', 'brain.active_tenants()',
      'brain.company_numbers(uuid, text, date, date)', 'brain.company_facts(uuid)', 'brain.measure(uuid, jsonb)',
      'integrations.api_key_info(text)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
  -- brain-service reads lists and history for the MCP server without a signed-in person
  GRANT EXECUTE ON FUNCTION brain.proposals_for(uuid, text, integer) TO service_role;
  GRANT EXECUTE ON FUNCTION brain.history_for(uuid, integer) TO service_role;
  GRANT EXECUTE ON FUNCTION brain.proposal_json(brain.proposals) TO service_role;

  -- The public API, as before: no signed-in user, the key is checked inside
  REVOKE EXECUTE ON FUNCTION integrations.api_list(text, text, integer, integer, text, boolean) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION integrations.api_list(text, text, integer, integer, text, boolean) TO anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION integrations.api_get(text, text, uuid) TO service_role;
  GRANT EXECUTE ON FUNCTION integrations.api_create(text, text, jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION integrations.api_log(text, text, text, integer, integer) TO service_role;
END;
$$;

-- Add this schema to the API, keeping every schema already listed
DO $$
DECLARE
  current_list TEXT;
BEGIN
  SELECT substring(c FROM length('pgrst.db_schemas=') + 1) INTO current_list
    FROM pg_roles r, unnest(r.rolconfig) c
    WHERE r.rolname = 'authenticator' AND c LIKE 'pgrst.db_schemas=%';
  current_list := coalesce(nullif(trim(current_list), ''), 'public, graphql_public');
  IF NOT 'brain' = ANY (string_to_array(replace(current_list, ' ', ''), ',')) THEN
    EXECUTE format('ALTER ROLE authenticator SET pgrst.db_schemas = %L', current_list || ', brain');
  END IF;
END;
$$;
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';
