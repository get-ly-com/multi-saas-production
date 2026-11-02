-- CRM forecasting and team reports.
-- Each open deal falls in a forecast category: Commit, Best case, Pipeline or Left out.
-- People choose Commit themselves; otherwise the stage's chance decides.
-- Monthly sales targets per person and for the whole company.
-- Close date changes are kept, so the forecast can show deals that slipped out.
-- Both reports read through row security, so viewers can see them and outsiders get nothing.

ALTER TABLE crm.deals ADD COLUMN forecast_category TEXT
  CHECK (forecast_category IN ('commit', 'best_case', 'pipeline', 'omit'));

ALTER TABLE crm.deal_history ADD COLUMN from_close DATE, ADD COLUMN to_close DATE;
CREATE INDEX idx_crm_deal_history_tenant ON crm.deal_history (tenant_id, changed_at);

-- Won and lost come from the stage. An open deal uses its chosen category, or else its stage's chance.
CREATE FUNCTION crm.forecast_category(p_chosen TEXT, p_kind TEXT, p_probability INT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_kind = 'won' THEN 'won'
    WHEN p_kind = 'lost' THEN 'lost'
    WHEN p_chosen IS NOT NULL THEN p_chosen
    WHEN p_probability >= 90 THEN 'commit'
    WHEN p_probability >= 50 THEN 'best_case'
    ELSE 'pipeline'
  END;
$$;

-- A stage move logs as before. A new expected close date logs too, with no stage.
CREATE OR REPLACE FUNCTION crm.log_deal_stage()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    INSERT INTO crm.deal_history (tenant_id, deal_id, from_stage_id, to_stage_id, value, changed_by, from_close, to_close)
      VALUES (NEW.tenant_id, NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.stage_id END, NEW.stage_id, NEW.value, auth.uid(),
        CASE WHEN TG_OP = 'UPDATE' THEN OLD.expected_close END, NEW.expected_close);
  ELSIF NEW.expected_close IS DISTINCT FROM OLD.expected_close THEN
    INSERT INTO crm.deal_history (tenant_id, deal_id, value, changed_by, from_close, to_close)
      VALUES (NEW.tenant_id, NEW.id, NEW.value, auth.uid(), OLD.expected_close, NEW.expected_close);
  END IF;
  RETURN NULL;
END;
$$;

-- No user_id is the target for the whole company
CREATE TABLE crm.targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  month DATE NOT NULL CHECK (month = date_trunc('month', month)::date),
  amount NUMERIC NOT NULL CHECK (amount >= 0 AND amount < 1000000000000),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (tenant_id, month, user_id)
);

ALTER TABLE crm.targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON crm.targets FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = (SELECT auth.uid())));
GRANT SELECT ON crm.targets TO authenticated;

-- Replaces every target for one month. A blank amount removes that target.
CREATE FUNCTION crm.save_targets(p_tenant UUID, p_month DATE, p_targets JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  the_month DATE := date_trunc('month', p_month)::date;
  item JSONB;
  person UUID;
  amount NUMERIC;
  kept INT := 0;
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  IF the_month IS NULL OR the_month < DATE '2000-01-01' OR the_month > DATE '2100-01-01' THEN
    RAISE EXCEPTION 'Choose a month';
  END IF;
  IF jsonb_typeof(p_targets) IS DISTINCT FROM 'array' OR jsonb_array_length(p_targets) > 200 THEN
    RAISE EXCEPTION 'Send up to 200 targets';
  END IF;

  DELETE FROM crm.targets WHERE tenant_id = p_tenant AND month = the_month;

  FOR item IN SELECT * FROM jsonb_array_elements(p_targets) LOOP
    IF coalesce(item->>'amount', '') = '' THEN
      CONTINUE;
    END IF;
    BEGIN
      amount := (item->>'amount')::numeric;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Enter targets as numbers';
    END;
    IF amount < 0 OR amount >= 1000000000000 THEN
      RAISE EXCEPTION 'Enter targets from 0 up to 999,999,999,999';
    END IF;
    person := nullif(item->>'user_id', '')::uuid;
    IF person IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = person
    ) THEN
      RAISE EXCEPTION 'A target is for someone outside this company';
    END IF;
    INSERT INTO crm.targets (tenant_id, user_id, month, amount, updated_by)
      VALUES (p_tenant, person, the_month, round(amount, 2), auth.uid())
      ON CONFLICT (tenant_id, month, user_id) DO UPDATE SET amount = EXCLUDED.amount;
    kept := kept + 1;
  END LOOP;

  RETURN json_build_object('saved', kept);
END;
$$;

REVOKE ALL ON FUNCTION crm.save_targets(UUID, DATE, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION crm.save_targets(UUID, DATE, JSONB) TO authenticated;

-- The forecast for whole months, from p_from's month to p_to's month, up to 12 months
CREATE FUNCTION crm.forecast(p_tenant UUID, p_from DATE, p_to DATE, p_pipeline UUID DEFAULT NULL)
RETURNS JSON
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
DECLARE
  first_day DATE := date_trunc('month', p_from)::date;
  after_last DATE := (date_trunc('month', p_to) + interval '1 month')::date;
  result JSON;
BEGIN
  IF first_day IS NULL OR after_last IS NULL OR after_last <= first_day THEN
    RAISE EXCEPTION 'Choose a start month before the end month';
  END IF;
  IF after_last > (first_day + interval '12 months')::date THEN
    RAISE EXCEPTION 'Choose up to 12 months';
  END IF;

  WITH months AS (
    SELECT m::date AS month FROM generate_series(first_day, after_last - 1, interval '1 month') m
  ), deal_rows AS (
    SELECT d.id, d.title, coalesce(d.value, 0) AS value, d.owner_id, d.expected_close, d.closed_at,
      d.forecast_category AS chosen, s.name AS stage_name, s.probability, s.kind, p.name AS pipeline_name,
      crm.forecast_category(d.forecast_category, s.kind, s.probability) AS category,
      CASE WHEN s.kind = 'won' THEN date_trunc('month', d.closed_at)::date ELSE date_trunc('month', d.expected_close)::date END AS month
    FROM crm.deals d
    JOIN crm.stages s ON s.id = d.stage_id
    JOIN crm.pipelines p ON p.id = s.pipeline_id
    WHERE d.tenant_id = p_tenant AND (p_pipeline IS NULL OR s.pipeline_id = p_pipeline)
  ), in_period AS (
    SELECT * FROM deal_rows
    WHERE (kind = 'won' AND closed_at >= first_day AND closed_at < after_last)
       OR (kind = 'open' AND expected_close >= first_day AND expected_close < after_last)
  ), targets AS (
    SELECT t.user_id, t.month, t.amount FROM crm.targets t
    WHERE t.tenant_id = p_tenant AND t.month >= first_day AND t.month < after_last
  ), company_targets AS (
    -- With no company target for a month, the people's targets add up instead
    SELECT m.month, coalesce(
      (SELECT amount FROM targets t WHERE t.user_id IS NULL AND t.month = m.month),
      (SELECT sum(amount) FROM targets t WHERE t.user_id IS NOT NULL AND t.month = m.month)
    ) AS amount
    FROM months m
  ), sums AS (
    SELECT owner_id,
      sum(value) FILTER (WHERE category = 'won') AS won,
      sum(value) FILTER (WHERE category = 'commit') AS commit,
      sum(value) FILTER (WHERE category = 'best_case') AS best_case,
      sum(value) FILTER (WHERE category = 'pipeline') AS pipeline,
      sum(value) FILTER (WHERE category = 'omit') AS omitted,
      round(sum(value * probability / 100.0) FILTER (WHERE kind = 'open' AND category <> 'omit'), 2) AS weighted,
      count(*) FILTER (WHERE kind = 'open') AS open_deals,
      count(*) FILTER (WHERE kind = 'won') AS won_deals
    FROM in_period GROUP BY owner_id
  ), people AS (
    SELECT owner_id AS user_id FROM sums
    UNION SELECT user_id FROM targets WHERE user_id IS NOT NULL
  )
  SELECT json_build_object(
    'from', first_day,
    'to', (after_last - 1),
    'today', current_date,
    'totals', (
      SELECT json_build_object(
        'target', (SELECT sum(amount) FROM company_targets),
        'won', coalesce(sum(won), 0), 'commit', coalesce(sum(commit), 0),
        'best_case', coalesce(sum(best_case), 0), 'pipeline', coalesce(sum(pipeline), 0),
        'omitted', coalesce(sum(omitted), 0), 'weighted', coalesce(sum(weighted), 0),
        'open_deals', coalesce(sum(open_deals), 0), 'won_deals', coalesce(sum(won_deals), 0)
      ) FROM sums
    ),
    'people', (
      SELECT coalesce(json_agg(r ORDER BY r.won + r.commit DESC, r.user_id NULLS LAST), '[]'::json) FROM (
        SELECT pe.user_id,
          (SELECT sum(amount) FROM targets t WHERE t.user_id = pe.user_id) AS target,
          coalesce(s.won, 0) AS won, coalesce(s.commit, 0) AS commit, coalesce(s.best_case, 0) AS best_case,
          coalesce(s.pipeline, 0) AS pipeline, coalesce(s.omitted, 0) AS omitted, coalesce(s.weighted, 0) AS weighted,
          coalesce(s.open_deals, 0) AS open_deals
        FROM people pe LEFT JOIN sums s ON s.owner_id IS NOT DISTINCT FROM pe.user_id
      ) r
    ),
    'months', (
      SELECT json_agg(r ORDER BY r.month) FROM (
        SELECT to_char(m.month, 'YYYY-MM') AS month, ct.amount AS target,
          coalesce(sum(i.value) FILTER (WHERE i.category = 'won'), 0) AS won,
          coalesce(sum(i.value) FILTER (WHERE i.category = 'commit'), 0) AS commit,
          coalesce(sum(i.value) FILTER (WHERE i.category = 'best_case'), 0) AS best_case,
          coalesce(sum(i.value) FILTER (WHERE i.category = 'pipeline'), 0) AS pipeline
        FROM months m
        JOIN company_targets ct ON ct.month = m.month
        LEFT JOIN in_period i ON i.month = m.month
        GROUP BY m.month, ct.amount
      ) r
    ),
    'deals', (
      SELECT coalesce(json_agg(r ORDER BY r.kind DESC, r.expected_close, r.title), '[]'::json) FROM (
        SELECT id, title, value, owner_id, stage_name, pipeline_name, probability, kind, category,
          chosen IS NULL AND kind = 'open' AS automatic, expected_close, closed_at
        FROM in_period ORDER BY kind DESC, expected_close, title LIMIT 500
      ) r
    ),
    'deal_count', (SELECT count(*) FROM in_period),
    -- Open deals already past a close date before this period, so in no month
    'late', (
      SELECT json_build_object('deals', count(*), 'value', coalesce(sum(value), 0))
      FROM deal_rows WHERE kind = 'open' AND expected_close < least(first_day, current_date)
    ),
    'undated', (
      SELECT json_build_object('deals', count(*), 'value', coalesce(sum(value), 0))
      FROM deal_rows WHERE kind = 'open' AND expected_close IS NULL
    ),
    -- Close dates moved from inside the period to later or to none, in the last 30 days
    'slipped', (
      SELECT coalesce(json_agg(r ORDER BY r.changed_at DESC), '[]'::json) FROM (
        SELECT DISTINCT ON (dr.id) dr.id, dr.title, dr.value, dr.owner_id, dr.stage_name, h.from_close, h.to_close, h.changed_at
        FROM crm.deal_history h
        JOIN deal_rows dr ON dr.id = h.deal_id
        WHERE h.tenant_id = p_tenant AND h.changed_at >= now() - interval '30 days'
          AND h.from_close >= first_day AND h.from_close < after_last
          AND (h.to_close IS NULL OR h.to_close >= after_last)
          AND dr.kind = 'open' AND (dr.expected_close IS NULL OR dr.expected_close >= after_last)
        ORDER BY dr.id, h.changed_at DESC
        LIMIT 50
      ) r
    )
  ) INTO result;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION crm.forecast(UUID, DATE, DATE, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION crm.forecast(UUID, DATE, DATE, UUID) TO authenticated;

-- What each person and the team did between two dates, up to 366 days
CREATE FUNCTION crm.team_report(p_tenant UUID, p_from DATE, p_to DATE, p_pipeline UUID DEFAULT NULL)
RETURNS JSON
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
DECLARE
  first_day DATE := p_from;
  after_last DATE := p_to + 1;
  funnel_pipeline UUID := p_pipeline;
  result JSON;
BEGIN
  IF first_day IS NULL OR after_last IS NULL OR after_last <= first_day THEN
    RAISE EXCEPTION 'Choose a start date on or before the end date';
  END IF;
  IF after_last - first_day > 366 THEN
    RAISE EXCEPTION 'Choose up to a year';
  END IF;
  IF funnel_pipeline IS NULL THEN
    SELECT id INTO funnel_pipeline FROM crm.pipelines WHERE tenant_id = p_tenant AND is_default;
  END IF;

  WITH deal_rows AS (
    SELECT d.id, coalesce(d.value, 0) AS value, d.owner_id, d.created_at, d.closed_at, d.lost_reason,
      d.source, s.kind, s.pipeline_id
    FROM crm.deals d JOIN crm.stages s ON s.id = d.stage_id
    WHERE d.tenant_id = p_tenant AND (p_pipeline IS NULL OR s.pipeline_id = p_pipeline)
  ), closed AS (
    SELECT * FROM deal_rows WHERE kind <> 'open' AND closed_at >= first_day AND closed_at < after_last
  ), created AS (
    SELECT * FROM deal_rows WHERE created_at >= first_day AND created_at < after_last
  ), logged AS (
    -- Things people logged themselves; automated tasks don't count
    SELECT a.* FROM crm.activities a
    WHERE a.tenant_id = p_tenant AND a.automation_id IS NULL
  ), lead_rows AS (
    SELECT l.owner_id, l.source, l.created_at, l.converted_at FROM crm.leads l WHERE l.tenant_id = p_tenant
  ), people AS (
    SELECT owner_id AS user_id FROM closed
    UNION SELECT owner_id FROM created
    UNION SELECT owner_id FROM deal_rows WHERE kind = 'open'
    UNION SELECT created_by FROM logged WHERE kind <> 'task' AND created_at >= first_day AND created_at < after_last
    UNION SELECT owner_id FROM logged WHERE kind = 'task' AND (done_at >= first_day AND done_at < after_last OR (done_at IS NULL AND due_on < current_date))
    UNION SELECT owner_id FROM lead_rows WHERE created_at >= first_day AND created_at < after_last
      OR converted_at >= first_day AND converted_at < after_last
  ), stage_rows AS (
    SELECT s.id, s.name, s.position, s.kind FROM crm.stages s
    WHERE s.pipeline_id = funnel_pipeline AND s.kind <> 'lost'
  ), reached AS (
    -- How far each deal made it. A won deal went through every stage.
    SELECT d.id, CASE
      WHEN d.kind = 'won' THEN 1000000
      ELSE coalesce((
        SELECT max(st.position) FROM crm.deal_history h JOIN stage_rows st ON st.id = h.to_stage_id
        WHERE h.deal_id = d.id AND st.kind = 'open'
      ), 0)
    END AS position
    FROM created d WHERE d.pipeline_id = funnel_pipeline
  ), stage_times AS (
    -- Days spent in each stage, for deals that left it during the period
    SELECT h.to_stage_id AS stage_id,
      extract(epoch FROM lead(h.changed_at) OVER (PARTITION BY h.deal_id ORDER BY h.changed_at) - h.changed_at) / 86400 AS days,
      lead(h.changed_at) OVER (PARTITION BY h.deal_id ORDER BY h.changed_at) AS left_at
    FROM crm.deal_history h
    WHERE h.tenant_id = p_tenant AND h.to_stage_id IS NOT NULL
  )
  SELECT json_build_object(
    'from', first_day,
    'to', p_to,
    'pipeline_id', funnel_pipeline,
    'people', (
      SELECT coalesce(json_agg(r ORDER BY r.won_value DESC, r.user_id NULLS LAST), '[]'::json) FROM (
        SELECT pe.user_id,
          (SELECT count(*) FROM created c WHERE c.owner_id IS NOT DISTINCT FROM pe.user_id) AS deals_created,
          (SELECT count(*) FROM closed c WHERE c.owner_id IS NOT DISTINCT FROM pe.user_id AND c.kind = 'won') AS won,
          (SELECT coalesce(sum(value), 0) FROM closed c WHERE c.owner_id IS NOT DISTINCT FROM pe.user_id AND c.kind = 'won') AS won_value,
          (SELECT count(*) FROM closed c WHERE c.owner_id IS NOT DISTINCT FROM pe.user_id AND c.kind = 'lost') AS lost,
          (SELECT coalesce(sum(value), 0) FROM closed c WHERE c.owner_id IS NOT DISTINCT FROM pe.user_id AND c.kind = 'lost') AS lost_value,
          (SELECT round(avg(extract(epoch FROM c.closed_at - c.created_at) / 86400)::numeric, 1) FROM closed c
            WHERE c.owner_id IS NOT DISTINCT FROM pe.user_id AND c.kind = 'won') AS days_to_win,
          (SELECT count(*) FROM deal_rows d WHERE d.owner_id IS NOT DISTINCT FROM pe.user_id AND d.kind = 'open') AS open_deals,
          (SELECT coalesce(sum(value), 0) FROM deal_rows d WHERE d.owner_id IS NOT DISTINCT FROM pe.user_id AND d.kind = 'open') AS open_value,
          (SELECT count(*) FROM logged a WHERE a.created_by IS NOT DISTINCT FROM pe.user_id AND a.kind = 'call' AND a.created_at >= first_day AND a.created_at < after_last) AS calls,
          (SELECT count(*) FROM logged a WHERE a.created_by IS NOT DISTINCT FROM pe.user_id AND a.kind = 'meeting' AND a.created_at >= first_day AND a.created_at < after_last) AS meetings,
          (SELECT count(*) FROM logged a WHERE a.created_by IS NOT DISTINCT FROM pe.user_id AND a.kind = 'email' AND a.created_at >= first_day AND a.created_at < after_last) AS emails,
          (SELECT count(*) FROM logged a WHERE a.created_by IS NOT DISTINCT FROM pe.user_id AND a.kind = 'note' AND a.created_at >= first_day AND a.created_at < after_last) AS notes,
          (SELECT count(*) FROM crm.activities a WHERE a.tenant_id = p_tenant AND a.owner_id IS NOT DISTINCT FROM pe.user_id AND a.kind = 'task' AND a.done_at >= first_day AND a.done_at < after_last) AS tasks_done,
          (SELECT count(*) FROM crm.activities a WHERE a.tenant_id = p_tenant AND a.owner_id IS NOT DISTINCT FROM pe.user_id AND a.kind = 'task' AND a.done_at IS NULL AND a.due_on < current_date) AS tasks_overdue,
          (SELECT count(*) FROM lead_rows l WHERE l.owner_id IS NOT DISTINCT FROM pe.user_id AND l.created_at >= first_day AND l.created_at < after_last) AS leads_new,
          (SELECT count(*) FROM lead_rows l WHERE l.owner_id IS NOT DISTINCT FROM pe.user_id AND l.converted_at >= first_day AND l.converted_at < after_last) AS leads_converted
        FROM people pe
      ) r
    ),
    'funnel', (
      SELECT coalesce(json_agg(r ORDER BY r.position), '[]'::json) FROM (
        SELECT st.name, st.position, st.kind,
          (SELECT count(*) FROM reached re WHERE re.position >= CASE WHEN st.kind = 'won' THEN 1000000 ELSE st.position END) AS deals,
          (SELECT round(avg(t.days)::numeric, 1) FROM stage_times t
            WHERE t.stage_id = st.id AND t.left_at >= first_day AND t.left_at < after_last) AS avg_days
        FROM stage_rows st
      ) r
    ),
    'funnel_total', (SELECT count(*) FROM reached),
    'lost_reasons', (
      SELECT coalesce(json_agg(r ORDER BY r.deals DESC, r.reason), '[]'::json) FROM (
        SELECT coalesce(nullif(trim(lost_reason), ''), 'No reason given') AS reason, count(*) AS deals, sum(value) AS value
        FROM closed WHERE kind = 'lost' GROUP BY 1 ORDER BY 2 DESC LIMIT 20
      ) r
    ),
    'sources', (
      SELECT coalesce(json_agg(r ORDER BY r.won_value DESC, r.leads DESC, r.source), '[]'::json) FROM (
        SELECT coalesce(d.source, l.source) AS source,
          coalesce(l.leads, 0) AS leads, coalesce(l.converted, 0) AS converted,
          coalesce(d.deals, 0) AS deals, coalesce(d.won, 0) AS won, coalesce(d.won_value, 0) AS won_value
        FROM (
          SELECT coalesce(nullif(trim(source), ''), 'None') AS source, count(*) AS deals,
            count(*) FILTER (WHERE kind = 'won') AS won, coalesce(sum(value) FILTER (WHERE kind = 'won'), 0) AS won_value
          FROM created GROUP BY 1
        ) d
        FULL JOIN (
          SELECT coalesce(nullif(trim(source), ''), 'None') AS source, count(*) AS leads, count(converted_at) AS converted
          FROM lead_rows WHERE created_at >= first_day AND created_at < after_last GROUP BY 1
        ) l ON l.source = d.source
        LIMIT 50
      ) r
    ),
    'months', (
      SELECT json_agg(r ORDER BY r.month) FROM (
        SELECT to_char(m, 'YYYY-MM') AS month,
          (SELECT count(*) FROM closed c WHERE c.kind = 'won' AND date_trunc('month', c.closed_at) = m) AS won,
          (SELECT coalesce(sum(value), 0) FROM closed c WHERE c.kind = 'won' AND date_trunc('month', c.closed_at) = m) AS won_value,
          (SELECT count(*) FROM closed c WHERE c.kind = 'lost' AND date_trunc('month', c.closed_at) = m) AS lost,
          (SELECT count(*) FROM created c WHERE date_trunc('month', c.created_at) = m) AS deals_created
        FROM generate_series(date_trunc('month', first_day::timestamp), date_trunc('month', p_to::timestamp), interval '1 month') m
      ) r
    )
  ) INTO result;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION crm.team_report(UUID, DATE, DATE, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION crm.team_report(UUID, DATE, DATE, UUID) TO authenticated;
REVOKE ALL ON FUNCTION crm.forecast_category(TEXT, TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION crm.forecast_category(TEXT, TEXT, INT) TO authenticated;
