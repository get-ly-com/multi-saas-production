-- Analytics and Integrations, closer to Odoo's reporting and API:
-- 1. Compare any date range with any other (previous period or the same dates last year).
-- 2. A report builder: pick invoices, deals, leads, bookings, stock items or chats, group by a field
--    and by month, count, add up or average. Reports can be saved by name for the whole company.
-- 3. Monthly goals for invoiced revenue, cash in, new leads, deals won, bookings and chats, with progress.
-- 4. A daily snapshot of numbers that can't be worked out later (money owed, open pipeline, stock
--    value, head count, open leads and chats), so they can be shown as a trend. One small row per
--    company per day, kept for 400 days, taken by pg_cron.
-- 5. API keys that can read and write. Writes are limited to adding contacts and leads. Every API
--    request is logged against its key (method, path, status, time; never the body).
-- 6. Incoming webhooks: a secret address per company that other tools post to, which adds a lead.
--    Rate limited and logged (which fields came in and the result; never the values).
-- Nothing in other products is replaced; leads and contacts are inserted the same way the web form does.

-- ---------------------------------------------------------------------------------------------
-- Analytics: comparison periods
-- ---------------------------------------------------------------------------------------------

-- The dashboard's "current" and marketing "current" numbers for any range, to compare against
CREATE FUNCTION analytics.compare(p_tenant UUID, p_from DATE, p_to DATE)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  member_role TEXT;
BEGIN
  SELECT m.role INTO member_role FROM public.tenant_members m WHERE m.tenant_id = p_tenant AND m.user_id = auth.uid();
  IF member_role IS NULL THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'Choose a start date before the end date';
  END IF;
  IF p_to - p_from > 731 THEN
    RAISE EXCEPTION 'Choose up to two years';
  END IF;
  RETURN json_build_object(
    'from', p_from, 'to', p_to,
    'totals', analytics.period_totals(p_tenant, p_from, p_to, member_role IN ('owner', 'admin')),
    'marketing', analytics.marketing_totals(p_tenant, p_from, p_to));
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- Analytics: report builder
-- ---------------------------------------------------------------------------------------------

-- What each dataset can be grouped, measured, dated and filtered by. The SQL pieces are fixed here;
-- a report only ever picks them by key, so nothing a user sends is put into a query.
CREATE FUNCTION analytics.report_def(p_dataset TEXT)
RETURNS JSONB
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE p_dataset
  WHEN 'invoices' THEN $j${
    "label": "Invoices",
    "from": "accounting.invoices x LEFT JOIN accounting.customers c ON c.id = x.customer_id",
    "dates": [
      {"key": "invoice_date", "label": "Invoice date", "expr": "x.invoice_date"},
      {"key": "due_date", "label": "Due date", "expr": "x.due_date"}],
    "groups": [
      {"key": "status", "label": "Status", "expr": "x.status"},
      {"key": "customer", "label": "Customer", "expr": "coalesce(c.name, nullif(x.customer_name, ''), 'No customer')"},
      {"key": "currency", "label": "Currency", "expr": "x.currency"}],
    "measures": [
      {"key": "count", "label": "Number of invoices", "expr": "1", "agg": "sum"},
      {"key": "invoiced", "label": "Invoiced before tax", "expr": "round(coalesce(x.subtotal, x.amount - coalesce(x.tax_amount, 0)) * coalesce(x.exchange_rate, 1), 2)", "agg": "sum", "money": true},
      {"key": "total", "label": "Total with tax", "expr": "coalesce(x.base_amount, round(x.amount * coalesce(x.exchange_rate, 1), 2))", "agg": "sum", "money": true},
      {"key": "outstanding", "label": "Still to collect", "expr": "CASE WHEN x.status IN ('sent', 'partial') THEN coalesce(x.base_amount, 0) - coalesce(x.base_settled, 0) ELSE 0 END", "agg": "sum", "money": true},
      {"key": "average", "label": "Average invoice before tax", "expr": "round(coalesce(x.subtotal, x.amount - coalesce(x.tax_amount, 0)) * coalesce(x.exchange_rate, 1), 2)", "agg": "avg", "money": true}],
    "filters": [
      {"key": "billed", "label": "Sent, part paid or paid", "where": "x.status IN ('sent', 'partial', 'paid')"},
      {"key": "unpaid", "label": "Not paid yet", "where": "x.status IN ('sent', 'partial')"},
      {"key": "paid", "label": "Paid", "where": "x.status = 'paid'"},
      {"key": "draft", "label": "Drafts", "where": "x.status = 'draft'"}]
  }$j$::jsonb
  WHEN 'deals' THEN $j${
    "label": "Deals",
    "from": "crm.deals x LEFT JOIN crm.stages s ON s.id = x.stage_id LEFT JOIN auth.users u ON u.id = x.owner_id",
    "dates": [
      {"key": "created_at", "label": "Created", "expr": "x.created_at"},
      {"key": "closed_at", "label": "Won or lost", "expr": "x.closed_at"},
      {"key": "expected_close", "label": "Expected to close", "expr": "x.expected_close"}],
    "groups": [
      {"key": "stage", "label": "Stage", "expr": "s.name"},
      {"key": "status", "label": "Open, won or lost", "expr": "s.kind"},
      {"key": "owner", "label": "Owner", "expr": "coalesce(u.email, 'No owner')"},
      {"key": "source", "label": "Source", "expr": "x.source"},
      {"key": "forecast", "label": "Forecast category", "expr": "x.forecast_category"}],
    "measures": [
      {"key": "count", "label": "Number of deals", "expr": "1", "agg": "sum"},
      {"key": "value", "label": "Deal value", "expr": "coalesce(x.value, 0)", "agg": "sum", "money": true},
      {"key": "average", "label": "Average deal value", "expr": "coalesce(x.value, 0)", "agg": "avg", "money": true}],
    "filters": [
      {"key": "open", "label": "Open", "where": "s.kind = 'open'"},
      {"key": "won", "label": "Won", "where": "s.kind = 'won'"},
      {"key": "lost", "label": "Lost", "where": "s.kind = 'lost'"}]
  }$j$::jsonb
  WHEN 'leads' THEN $j${
    "label": "Leads",
    "from": "crm.leads x LEFT JOIN auth.users u ON u.id = x.owner_id",
    "dates": [
      {"key": "created_at", "label": "Added", "expr": "x.created_at"},
      {"key": "converted_at", "label": "Converted", "expr": "x.converted_at"}],
    "groups": [
      {"key": "status", "label": "Status", "expr": "x.status"},
      {"key": "source", "label": "Source", "expr": "x.source"},
      {"key": "campaign", "label": "Campaign", "expr": "x.campaign"},
      {"key": "owner", "label": "Owner", "expr": "coalesce(u.email, 'No owner')"},
      {"key": "from_form", "label": "Came from", "expr": "CASE WHEN x.from_form THEN 'Web form' ELSE 'Added another way' END"}],
    "measures": [
      {"key": "count", "label": "Number of leads", "expr": "1", "agg": "sum"},
      {"key": "score", "label": "Average score", "expr": "coalesce(x.score, 0)", "agg": "avg"}],
    "filters": [
      {"key": "open", "label": "New or being worked on", "where": "x.status IN ('new', 'working')"},
      {"key": "converted", "label": "Converted", "where": "x.status = 'converted'"},
      {"key": "disqualified", "label": "Disqualified", "where": "x.status = 'disqualified'"}]
  }$j$::jsonb
  WHEN 'bookings' THEN $j${
    "label": "Bookings",
    "from": "scheduler.bookings x LEFT JOIN scheduler.services s ON s.id = x.service_id LEFT JOIN auth.users u ON u.id = x.staff_id",
    "dates": [
      {"key": "starts_at", "label": "Booked for", "expr": "x.starts_at"},
      {"key": "created_at", "label": "Made on", "expr": "x.created_at"}],
    "groups": [
      {"key": "service", "label": "Service", "expr": "coalesce(s.name, 'No service')"},
      {"key": "status", "label": "Status", "expr": "x.status"},
      {"key": "staff", "label": "Staff", "expr": "coalesce(u.email, 'Anyone')"},
      {"key": "source", "label": "Booked by", "expr": "CASE x.source WHEN 'public' THEN 'Customer, on the booking page' ELSE 'Staff' END"},
      {"key": "campaign", "label": "Campaign", "expr": "x.campaign"}],
    "measures": [
      {"key": "count", "label": "Number of bookings", "expr": "1", "agg": "sum"},
      {"key": "value", "label": "Value at service price", "expr": "coalesce(s.price, 0)", "agg": "sum", "money": true}],
    "filters": [
      {"key": "booked", "label": "Still on", "where": "x.status = 'booked'"},
      {"key": "cancelled", "label": "Cancelled", "where": "x.status = 'cancelled'"}]
  }$j$::jsonb
  WHEN 'items' THEN $j${
    "label": "Stock items",
    "from": "inventory.items x",
    "dates": [
      {"key": "none", "label": "Any time", "expr": null},
      {"key": "created_at", "label": "Added", "expr": "x.created_at"}],
    "groups": [
      {"key": "level", "label": "Stock level", "expr": "CASE WHEN coalesce(x.quantity, 0) <= 0 THEN 'Out of stock' WHEN x.quantity <= coalesce(x.reorder_level, 0) THEN 'Low' ELSE 'In stock' END"},
      {"key": "item", "label": "Item", "expr": "x.name"}],
    "measures": [
      {"key": "count", "label": "Number of items", "expr": "1", "agg": "sum"},
      {"key": "quantity", "label": "Quantity in stock", "expr": "coalesce(x.quantity, 0)", "agg": "sum"},
      {"key": "stock_value", "label": "Stock value at cost", "expr": "coalesce(x.stock_value, 0)", "agg": "sum", "money": true},
      {"key": "sale_value", "label": "Value at sale price", "expr": "coalesce(x.quantity, 0) * coalesce(x.price, 0)", "agg": "sum", "money": true}],
    "filters": [
      {"key": "low", "label": "Low or out of stock", "where": "coalesce(x.quantity, 0) <= coalesce(x.reorder_level, 0)"}]
  }$j$::jsonb
  WHEN 'chats' THEN $j${
    "label": "Chats",
    "from": "chat.conversations x LEFT JOIN auth.users u ON u.id = x.assigned_to",
    "dates": [
      {"key": "created_at", "label": "Started", "expr": "x.created_at"}],
    "groups": [
      {"key": "status", "label": "Status", "expr": "x.status"},
      {"key": "page", "label": "Started on page", "expr": "left(x.started_on, 120)"},
      {"key": "campaign", "label": "Campaign", "expr": "x.campaign"},
      {"key": "assigned", "label": "Assigned to", "expr": "coalesce(u.email, 'Nobody')"},
      {"key": "wants_person", "label": "Asked for a person", "expr": "CASE WHEN x.wants_person THEN 'Asked for a person' ELSE 'Did not ask' END"}],
    "measures": [
      {"key": "count", "label": "Number of chats", "expr": "1", "agg": "sum"},
      {"key": "messages", "label": "Visitor messages", "expr": "coalesce(x.visitor_messages, 0)", "agg": "sum"}],
    "filters": [
      {"key": "wants_person", "label": "Asked for a person", "where": "x.wants_person"},
      {"key": "with_lead", "label": "Became a lead", "where": "x.lead_id IS NOT NULL"}]
  }$j$::jsonb
  END;
$$;

CREATE FUNCTION analytics.report_datasets()
RETURNS TEXT[]
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT ARRAY['invoices', 'deals', 'leads', 'bookings', 'items', 'chats'] $$;

-- The choices for the report builder screen, without the SQL pieces
CREATE FUNCTION analytics.report_options()
RETURNS JSON
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT json_agg(json_build_object(
    'key', d.name,
    'label', def->>'label',
    'dates', (SELECT jsonb_agg(e - 'expr' ORDER BY n) FROM jsonb_array_elements(def->'dates') WITH ORDINALITY AS a(e, n)),
    'groups', (SELECT jsonb_agg(e - 'expr' ORDER BY n) FROM jsonb_array_elements(def->'groups') WITH ORDINALITY AS a(e, n)),
    'measures', (SELECT jsonb_agg(e - 'expr' ORDER BY n) FROM jsonb_array_elements(def->'measures') WITH ORDINALITY AS a(e, n)),
    'filters', (SELECT jsonb_agg(e - 'where' ORDER BY n) FROM jsonb_array_elements(def->'filters') WITH ORDINALITY AS a(e, n))
  ) ORDER BY d.n)
  FROM unnest(analytics.report_datasets()) WITH ORDINALITY AS d(name, n),
    LATERAL (SELECT analytics.report_def(d.name) AS def) x;
$$;

-- Checks a report's choices and returns the dataset definition plus the chosen pieces
CREATE FUNCTION analytics.report_parts(p_spec JSONB)
RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
  def JSONB := analytics.report_def(p_spec->>'dataset');
  chosen_group JSONB;
  chosen_measure JSONB;
  chosen_date JSONB;
  chosen_filter JSONB;
BEGIN
  IF jsonb_typeof(p_spec) IS DISTINCT FROM 'object' OR def IS NULL THEN
    RAISE EXCEPTION 'Choose what to report on';
  END IF;
  IF coalesce(p_spec->>'group', 'none') = 'none' THEN
    chosen_group := jsonb_build_object('key', 'none', 'label', 'Everything', 'expr', '''Everything''');
  ELSE
    SELECT e INTO chosen_group FROM jsonb_array_elements(def->'groups') e WHERE e->>'key' = p_spec->>'group';
    IF chosen_group IS NULL THEN
      RAISE EXCEPTION 'Choose what to group by';
    END IF;
  END IF;
  SELECT e INTO chosen_measure FROM jsonb_array_elements(def->'measures') e WHERE e->>'key' = coalesce(p_spec->>'measure', 'count');
  IF chosen_measure IS NULL THEN
    RAISE EXCEPTION 'Choose what to measure';
  END IF;
  SELECT e INTO chosen_date FROM jsonb_array_elements(def->'dates') e
    WHERE e->>'key' = coalesce(p_spec->>'date_field', def->'dates'->0->>'key');
  IF chosen_date IS NULL THEN
    RAISE EXCEPTION 'Choose which date to use';
  END IF;
  IF coalesce(p_spec->>'filter', '') <> '' THEN
    SELECT e INTO chosen_filter FROM jsonb_array_elements(def->'filters') e WHERE e->>'key' = p_spec->>'filter';
    IF chosen_filter IS NULL THEN
      RAISE EXCEPTION 'Choose a filter from the list';
    END IF;
  END IF;
  RETURN jsonb_build_object('def', def, 'group', chosen_group, 'measure', chosen_measure, 'date', chosen_date,
    'filter', chosen_filter);
END;
$$;

-- Runs a report for one company. Spec: dataset, group, measure, date_field, filter, by_month,
-- from, to (dates). Up to 20 groups are shown; the rest are added up as "Everything else".
CREATE FUNCTION analytics.run_report(p_tenant UUID, p_spec JSONB)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' SET statement_timeout = '8s'
AS $$
DECLARE
  parts JSONB;
  from_day DATE;
  to_day DATE;
  by_month BOOLEAN := coalesce((p_spec->>'by_month')::boolean, false);
  date_expr TEXT;
  agg TEXT;
  query TEXT;
  result JSON;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tenant_members m WHERE m.tenant_id = p_tenant AND m.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  parts := analytics.report_parts(p_spec);
  date_expr := parts->'date'->>'expr';

  IF date_expr IS NOT NULL THEN
    BEGIN
      from_day := (p_spec->>'from')::date;
      to_day := (p_spec->>'to')::date;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Choose a start and end date';
    END;
    IF from_day IS NULL OR to_day IS NULL OR from_day > to_day THEN
      RAISE EXCEPTION 'Choose a start date before the end date';
    END IF;
    IF to_day - from_day > 731 THEN
      RAISE EXCEPTION 'Choose up to two years';
    END IF;
  ELSE
    by_month := false;
  END IF;

  agg := CASE WHEN parts->'measure'->>'agg' = 'avg' THEN 'round(avg(val), 2)' ELSE 'coalesce(sum(val), 0)' END;

  query := format($q$
    WITH base AS (
      SELECT coalesce(nullif(btrim((%1$s)::text), ''), '(blank)') AS grp,
        %2$s AS month,
        (%3$s)::numeric AS val
      FROM %4$s
      WHERE x.tenant_id = $1 %5$s %6$s
    ), ranked AS (
      SELECT grp, row_number() OVER (ORDER BY %7$s DESC NULLS LAST, grp) AS place FROM base GROUP BY grp
    ), labelled AS (
      SELECT CASE WHEN r.place <= 20 THEN b.grp ELSE 'Everything else' END AS grp,
        least(r.place, 21) AS place, b.month, b.val
      FROM base b JOIN ranked r ON r.grp = b.grp
    )
    SELECT json_build_object(
      'groups', (SELECT coalesce(json_agg(t ORDER BY t.place), '[]'::json) FROM (
        SELECT grp AS label, min(place) AS place, %7$s AS value, count(*) AS records FROM labelled GROUP BY grp) t),
      'cells', (SELECT coalesce(json_agg(t ORDER BY t.month, t.place), '[]'::json) FROM (
        SELECT grp AS label, min(place) AS place, month, %7$s AS value, count(*) AS records
        FROM labelled WHERE month IS NOT NULL GROUP BY grp, month) t),
      'total', (SELECT json_build_object('value', %7$s, 'records', count(*)) FROM base))
    $q$,
    parts->'group'->>'expr',
    CASE WHEN by_month THEN format('date_trunc(''month'', %s)::date', date_expr) ELSE 'NULL::date' END,
    parts->'measure'->>'expr',
    parts->'def'->>'from',
    CASE WHEN date_expr IS NULL THEN '' ELSE format('AND (%1$s) >= $2 AND (%1$s) < $3 + 1', date_expr) END,
    CASE WHEN parts->'filter' IS NULL OR parts->'filter' = 'null'::jsonb THEN '' ELSE format('AND (%s)', parts->'filter'->>'where') END,
    agg);

  EXECUTE query INTO result USING p_tenant, from_day, to_day;

  RETURN json_build_object(
    'dataset', parts->'def'->>'label',
    'group', parts->'group'->>'label',
    'measure', parts->'measure'->>'label',
    'money', coalesce((parts->'measure'->>'money')::boolean, false),
    'average', parts->'measure'->>'agg' = 'avg',
    'date_field', parts->'date'->>'label',
    'filter', parts->'filter'->>'label',
    'by_month', by_month,
    'from', from_day, 'to', to_day,
    'months', CASE WHEN by_month THEN (
      SELECT json_agg(g::date ORDER BY g) FROM generate_series(date_trunc('month', from_day), date_trunc('month', to_day), interval '1 month') g) END,
    'currency', coalesce((SELECT s.base_currency FROM accounting.settings s WHERE s.tenant_id = p_tenant), 'USD'),
    'result', result);
END;
$$;

CREATE TABLE analytics.reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  spec JSONB NOT NULL CHECK (jsonb_typeof(spec) = 'object' AND octet_length(spec::text) <= 2000),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX analytics_reports_name ON analytics.reports (tenant_id, lower(name));

ALTER TABLE analytics.reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY member_rows ON analytics.reports FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT m.tenant_id FROM public.tenant_members m WHERE m.user_id = (SELECT auth.uid())));
GRANT SELECT ON analytics.reports TO authenticated;

CREATE FUNCTION analytics.list_reports(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  member_role TEXT;
BEGIN
  SELECT m.role INTO member_role FROM public.tenant_members m WHERE m.tenant_id = p_tenant AND m.user_id = auth.uid();
  IF member_role IS NULL THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  RETURN json_build_object(
    'can_save', member_role <> 'viewer',
    'options', analytics.report_options(),
    'reports', (SELECT coalesce(json_agg(r ORDER BY lower(r.name)), '[]'::json) FROM (
      SELECT x.id, x.name, x.spec, x.created_at, x.updated_at, u.email AS created_by,
        (member_role IN ('owner', 'admin') OR x.created_by = auth.uid()) AS can_change
      FROM analytics.reports x LEFT JOIN auth.users u ON u.id = x.created_by
      WHERE x.tenant_id = p_tenant) r));
END;
$$;

-- Owners, admins and accountants save reports; only the person who made one, or an owner or
-- admin, can change or delete it. Up to 50 per company.
CREATE FUNCTION analytics.save_report(p_tenant UUID, p_report UUID, p_name TEXT, p_spec JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  member_role TEXT;
  clean JSONB;
  new_id UUID;
BEGIN
  SELECT m.role INTO member_role FROM public.tenant_members m WHERE m.tenant_id = p_tenant AND m.user_id = auth.uid();
  IF member_role IS NULL THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF member_role = 'viewer' THEN
    RAISE EXCEPTION 'Viewers can run reports but not save them';
  END IF;
  IF length(btrim(coalesce(p_name, ''))) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'Enter a name of up to 80 characters';
  END IF;
  PERFORM analytics.report_parts(p_spec);
  -- Only the known choices are kept
  clean := jsonb_strip_nulls(jsonb_build_object(
    'dataset', p_spec->>'dataset', 'group', p_spec->>'group', 'measure', p_spec->>'measure',
    'date_field', p_spec->>'date_field', 'filter', nullif(p_spec->>'filter', ''),
    'by_month', coalesce((p_spec->>'by_month')::boolean, false),
    'period', left(p_spec->>'period', 20),
    'from', CASE WHEN p_spec->>'from' ~ '^\d{4}-\d{2}-\d{2}$' THEN p_spec->>'from' END,
    'to', CASE WHEN p_spec->>'to' ~ '^\d{4}-\d{2}-\d{2}$' THEN p_spec->>'to' END,
    'chart', CASE WHEN p_spec->>'chart' IN ('bar', 'table') THEN p_spec->>'chart' END));

  IF p_report IS NOT NULL THEN
    BEGIN
      UPDATE analytics.reports SET name = btrim(p_name), spec = clean, updated_at = now()
        WHERE id = p_report AND tenant_id = p_tenant
          AND (member_role IN ('owner', 'admin') OR created_by = auth.uid());
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'There is already a report called %', btrim(p_name);
    END;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Report not found, or it was made by someone else';
    END IF;
    RETURN json_build_object('id', p_report);
  END IF;

  IF (SELECT count(*) FROM analytics.reports r WHERE r.tenant_id = p_tenant) >= 50 THEN
    RAISE EXCEPTION 'A company can save up to 50 reports. Delete one you no longer use.';
  END IF;
  BEGIN
    INSERT INTO analytics.reports (tenant_id, name, spec, created_by)
      VALUES (p_tenant, btrim(p_name), clean, auth.uid()) RETURNING id INTO new_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'There is already a report called %', btrim(p_name);
  END;
  RETURN json_build_object('id', new_id);
END;
$$;

CREATE FUNCTION analytics.delete_report(p_tenant UUID, p_report UUID)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  member_role TEXT;
BEGIN
  SELECT m.role INTO member_role FROM public.tenant_members m WHERE m.tenant_id = p_tenant AND m.user_id = auth.uid();
  IF member_role IS NULL THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  DELETE FROM analytics.reports
    WHERE id = p_report AND tenant_id = p_tenant
      AND (member_role IN ('owner', 'admin') OR (member_role <> 'viewer' AND created_by = auth.uid()));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Report not found, or it was made by someone else';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- Analytics: monthly goals
-- ---------------------------------------------------------------------------------------------

CREATE TABLE analytics.goals (
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  metric TEXT NOT NULL CHECK (metric IN ('revenue', 'cash_in', 'won_value', 'new_leads', 'bookings', 'chats')),
  month DATE NOT NULL CHECK (extract(day FROM month) = 1),
  target NUMERIC(14, 2) NOT NULL CHECK (target > 0),
  set_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, metric, month)
);
ALTER TABLE analytics.goals ENABLE ROW LEVEL SECURITY;
CREATE POLICY member_rows ON analytics.goals FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT m.tenant_id FROM public.tenant_members m WHERE m.user_id = (SELECT auth.uid())));
GRANT SELECT ON analytics.goals TO authenticated;

CREATE FUNCTION analytics.goal_metrics()
RETURNS JSON
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT '[
    {"key": "revenue", "label": "Invoiced (before tax)", "money": true},
    {"key": "cash_in", "label": "Cash in", "money": true},
    {"key": "won_value", "label": "Deals won", "money": true},
    {"key": "new_leads", "label": "New leads", "money": false},
    {"key": "bookings", "label": "Bookings made", "money": false},
    {"key": "chats", "label": "Chats started", "money": false}
  ]'::json;
$$;

-- Sets a goal for one month, or the same goal for several months in a row. No target clears it.
CREATE FUNCTION analytics.set_goal(p_tenant UUID, p_metric TEXT, p_month DATE, p_target NUMERIC, p_months INT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  first_month DATE := date_trunc('month', p_month)::date;
  count_months INT := coalesce(p_months, 1);
  changed INT;
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  IF p_metric IS NULL OR p_metric NOT IN ('revenue', 'cash_in', 'won_value', 'new_leads', 'bookings', 'chats') THEN
    RAISE EXCEPTION 'Choose what the goal is for';
  END IF;
  IF first_month IS NULL OR first_month < (date_trunc('month', current_date) - interval '24 months')::date
     OR first_month > (date_trunc('month', current_date) + interval '24 months')::date THEN
    RAISE EXCEPTION 'Choose a month within two years of today';
  END IF;
  IF count_months NOT BETWEEN 1 AND 12 THEN
    RAISE EXCEPTION 'Set a goal for 1 to 12 months at a time';
  END IF;
  IF p_target IS NOT NULL AND (p_target < 0 OR p_target >= 1000000000000) THEN
    RAISE EXCEPTION 'Enter a goal of 0 or more';
  END IF;

  IF p_target IS NULL OR p_target = 0 THEN
    DELETE FROM analytics.goals g
      WHERE g.tenant_id = p_tenant AND g.metric = p_metric
        AND g.month >= first_month AND g.month < (first_month + make_interval(months => count_months))::date;
    GET DIAGNOSTICS changed = ROW_COUNT;
    RETURN json_build_object('cleared', changed);
  END IF;

  INSERT INTO analytics.goals (tenant_id, metric, month, target, set_by)
    SELECT p_tenant, p_metric, (first_month + make_interval(months => n))::date, round(p_target, 2), auth.uid()
    FROM generate_series(0, count_months - 1) n
  ON CONFLICT (tenant_id, metric, month) DO UPDATE
    SET target = EXCLUDED.target, set_by = EXCLUDED.set_by, updated_at = now();
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN json_build_object('saved', changed);
END;
$$;

-- Progress for one month, and how the last 12 months went against their goals.
-- "expected" is where you'd be by today if the month went evenly.
CREATE FUNCTION analytics.goal_progress(p_tenant UUID, p_month DATE)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  member_role TEXT;
  the_month DATE := date_trunc('month', coalesce(p_month, current_date))::date;
  month_end DATE;
  share NUMERIC;
  trend JSON;
BEGIN
  SELECT m.role INTO member_role FROM public.tenant_members m WHERE m.tenant_id = p_tenant AND m.user_id = auth.uid();
  IF member_role IS NULL THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  month_end := (the_month + interval '1 month' - interval '1 day')::date;
  share := CASE
    WHEN current_date > month_end THEN 1
    WHEN current_date < the_month THEN 0
    ELSE round((current_date - the_month + 1)::numeric / (month_end - the_month + 1), 4) END;
  -- Payroll isn't a goal, so the trend is read without it
  trend := analytics.monthly_trend(p_tenant, the_month, false);

  RETURN json_build_object(
    'month', the_month,
    'share_of_month', share,
    'can_edit', member_role IN ('owner', 'admin'),
    'currency', coalesce((SELECT s.base_currency FROM accounting.settings s WHERE s.tenant_id = p_tenant), 'USD'),
    'metrics', analytics.goal_metrics(),
    'goals', (SELECT coalesce(json_agg(r ORDER BY r.place), '[]'::json) FROM (
      SELECT g.metric, g.target, coalesce((t.value->>g.metric)::numeric, 0) AS actual,
        round(100 * coalesce((t.value->>g.metric)::numeric, 0) / g.target, 1) AS percent,
        round(g.target * share, 2) AS expected,
        array_position(ARRAY['revenue', 'cash_in', 'won_value', 'new_leads', 'bookings', 'chats'], g.metric) AS place
      FROM analytics.goals g
      LEFT JOIN json_array_elements(trend) t ON (t.value->>'month')::date = g.month
      WHERE g.tenant_id = p_tenant AND g.month = the_month) r),
    'history', (SELECT coalesce(json_agg(r ORDER BY r.month, r.place), '[]'::json) FROM (
      SELECT g.month, g.metric, g.target, coalesce((t.value->>g.metric)::numeric, 0) AS actual,
        round(100 * coalesce((t.value->>g.metric)::numeric, 0) / g.target, 1) AS percent,
        array_position(ARRAY['revenue', 'cash_in', 'won_value', 'new_leads', 'bookings', 'chats'], g.metric) AS place
      FROM analytics.goals g
      JOIN json_array_elements(trend) t ON (t.value->>'month')::date = g.month
      WHERE g.tenant_id = p_tenant AND g.month < the_month) r),
    'upcoming', (SELECT coalesce(json_agg(r ORDER BY r.month, r.metric), '[]'::json) FROM (
      SELECT g.month, g.metric, g.target FROM analytics.goals g
      WHERE g.tenant_id = p_tenant AND g.month > the_month AND g.month <= (the_month + interval '12 months')::date) r));
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- Analytics: daily snapshots
-- ---------------------------------------------------------------------------------------------

CREATE TABLE analytics.snapshots (
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  numbers JSONB NOT NULL,
  taken_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day)
);
ALTER TABLE analytics.snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY member_rows ON analytics.snapshots FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT m.tenant_id FROM public.tenant_members m WHERE m.user_id = (SELECT auth.uid())));
GRANT SELECT ON analytics.snapshots TO authenticated;

-- Point-in-time numbers. Only what the members of the company can already see on the dashboard.
CREATE FUNCTION analytics.snapshot_numbers(p_tenant UUID)
RETURNS JSONB
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'outstanding', r.outstanding, 'overdue', r.overdue,
    'pipeline', p.value, 'pipeline_weighted', p.weighted, 'open_deals', p.open_deals,
    'stock_value', s.value, 'low_stock', s.low,
    'headcount', h.headcount,
    'open_leads', l.open_leads,
    'open_chats', c.open_chats)
  FROM
    (SELECT coalesce(sum(base_amount - base_settled), 0) AS outstanding,
       coalesce(sum(base_amount - base_settled) FILTER (WHERE due_date < current_date), 0) AS overdue
     FROM accounting.invoices WHERE tenant_id = p_tenant AND status IN ('sent', 'partial')) r,
    (SELECT count(*) AS open_deals, coalesce(sum(d.value), 0) AS value,
       round(coalesce(sum(d.value * st.probability / 100.0), 0), 2) AS weighted
     FROM crm.deals d JOIN crm.stages st ON st.id = d.stage_id
     WHERE d.tenant_id = p_tenant AND st.kind = 'open') p,
    (SELECT coalesce(sum(stock_value), 0) AS value, count(*) FILTER (WHERE quantity <= reorder_level) AS low
     FROM inventory.items WHERE tenant_id = p_tenant) s,
    (SELECT count(*) AS headcount FROM hr.employees
     WHERE tenant_id = p_tenant AND start_date <= current_date AND (end_date IS NULL OR end_date >= current_date)) h,
    (SELECT count(*) AS open_leads FROM crm.leads WHERE tenant_id = p_tenant AND status IN ('new', 'working')) l,
    (SELECT count(*) AS open_chats FROM chat.conversations WHERE tenant_id = p_tenant AND status IN ('open', 'waiting')) c;
$$;

-- pg_cron, daily: one row per active company, and rows older than 400 days are dropped
CREATE FUNCTION analytics.take_snapshots()
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  taken INT;
BEGIN
  INSERT INTO analytics.snapshots (tenant_id, day, numbers)
    SELECT t.id, current_date, analytics.snapshot_numbers(t.id)
    FROM public.tenants t WHERE t.is_active IS NOT FALSE
  ON CONFLICT (tenant_id, day) DO UPDATE SET numbers = EXCLUDED.numbers, taken_at = now();
  GET DIAGNOSTICS taken = ROW_COUNT;
  DELETE FROM analytics.snapshots WHERE day < current_date - 400;
  RETURN taken;
END;
$$;

CREATE FUNCTION analytics.snapshot_history(p_tenant UUID, p_days INT)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  days INT := least(greatest(coalesce(p_days, 90), 7), 400);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tenant_members m WHERE m.tenant_id = p_tenant AND m.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  RETURN json_build_object(
    'currency', coalesce((SELECT s.base_currency FROM accounting.settings s WHERE s.tenant_id = p_tenant), 'USD'),
    'today', analytics.snapshot_numbers(p_tenant),
    'days', (SELECT coalesce(json_agg(json_build_object('day', s.day, 'numbers', s.numbers) ORDER BY s.day), '[]'::json)
      FROM analytics.snapshots s WHERE s.tenant_id = p_tenant AND s.day >= current_date - days AND s.day < current_date));
END;
$$;

DO $$
DECLARE
  fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY['analytics.report_def(text)', 'analytics.report_datasets()', 'analytics.report_parts(jsonb)',
      'analytics.snapshot_numbers(uuid)', 'analytics.take_snapshots()']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
  END LOOP;
  FOREACH fn IN ARRAY ARRAY['analytics.compare(uuid, date, date)', 'analytics.report_options()',
      'analytics.run_report(uuid, jsonb)', 'analytics.list_reports(uuid)', 'analytics.save_report(uuid, uuid, text, jsonb)',
      'analytics.delete_report(uuid, uuid)', 'analytics.goal_metrics()',
      'analytics.set_goal(uuid, text, date, numeric, integer)', 'analytics.goal_progress(uuid, date)',
      'analytics.snapshot_history(uuid, integer)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- Integrations: settings
-- ---------------------------------------------------------------------------------------------

-- Same as before, plus the limits for writes and incoming webhooks
CREATE OR REPLACE FUNCTION integrations.limits()
RETURNS JSON
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT json_build_object(
    'webhooks_per_company', 10,
    'deliveries_per_day', 1000,
    'attempts', 5,
    'failures_before_off', 20,
    'api_keys_per_company', 20,
    'api_requests_per_minute', 120,
    'api_page_max', 100,
    'log_days', 30,
    'api_writes_per_day', 500,
    'inbound_hooks_per_company', 10,
    'inbound_per_minute', 30,
    'inbound_per_day', 500
  );
$$;

-- ---------------------------------------------------------------------------------------------
-- Integrations: API keys that can write, and the request log
-- ---------------------------------------------------------------------------------------------

ALTER TABLE integrations.api_keys
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'read' CHECK (scope IN ('read', 'write')),
  ADD COLUMN write_day DATE,
  ADD COLUMN write_count INT NOT NULL DEFAULT 0;
GRANT SELECT (scope) ON integrations.api_keys TO authenticated;

CREATE TABLE integrations.api_requests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  key_id UUID NOT NULL REFERENCES integrations.api_keys(id) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INT NOT NULL,
  duration_ms INT
);
CREATE INDEX idx_integrations_api_requests_key ON integrations.api_requests (key_id, at DESC);
CREATE INDEX idx_integrations_api_requests_at ON integrations.api_requests (at);
ALTER TABLE integrations.api_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY manager_rows ON integrations.api_requests FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT m.tenant_id FROM public.tenant_members m WHERE m.user_id = (SELECT auth.uid()) AND m.role IN ('owner', 'admin')));
GRANT SELECT ON integrations.api_requests TO authenticated;

-- Makes a key that can only read, or one that can read and add contacts and leads
CREATE FUNCTION integrations.make_api_key(p_tenant UUID, p_name TEXT, p_scope TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  made JSON;
BEGIN
  IF coalesce(p_scope, '') NOT IN ('read', 'write') THEN
    RAISE EXCEPTION 'Choose what the key can do';
  END IF;
  made := integrations.create_api_key(p_tenant, p_name);
  UPDATE integrations.api_keys SET scope = p_scope WHERE id = (made->>'id')::uuid;
  RETURN (made::jsonb || jsonb_build_object('scope', p_scope))::json;
END;
$$;

-- Called by the gateway after each public API request. Only a real key's own requests are logged,
-- and at most 2,000 a day per key, so a flood can't fill the table.
CREATE FUNCTION integrations.api_log(p_key TEXT, p_method TEXT, p_path TEXT, p_status INT, p_ms INT)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  k RECORD;
BEGIN
  IF p_key IS NULL OR p_key !~ '^gk_[0-9a-f]{48}$' OR coalesce(p_method, '') NOT IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')
     OR coalesce(p_status, 0) NOT BETWEEN 100 AND 599 THEN
    RETURN;
  END IF;
  SELECT x.id, x.tenant_id INTO k FROM integrations.api_keys x WHERE x.key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex');
  IF k.id IS NULL THEN
    RETURN;
  END IF;
  IF (SELECT count(*) FROM integrations.api_requests r WHERE r.key_id = k.id AND r.at > now() - interval '1 day') >= 2000 THEN
    RETURN;
  END IF;
  INSERT INTO integrations.api_requests (tenant_id, key_id, method, path, status, duration_ms)
    VALUES (k.tenant_id, k.id, p_method, left(regexp_replace(coalesce(p_path, ''), '[^A-Za-z0-9/_.-]', '', 'g'), 200),
      p_status, CASE WHEN p_ms BETWEEN 0 AND 600000 THEN p_ms END);
END;
$$;

-- The last 100 requests made with one key, and counts for the last day
CREATE FUNCTION integrations.api_key_log(p_tenant UUID, p_key UUID)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  IF NOT EXISTS (SELECT 1 FROM integrations.api_keys k WHERE k.id = p_key AND k.tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'API key not found';
  END IF;
  RETURN json_build_object(
    'last_day', (SELECT json_build_object(
        'requests', count(*),
        'ok', count(*) FILTER (WHERE r.status < 400),
        'refused', count(*) FILTER (WHERE r.status >= 400),
        'writes', count(*) FILTER (WHERE r.method = 'POST' AND r.status < 400))
      FROM integrations.api_requests r WHERE r.key_id = p_key AND r.at > now() - interval '1 day'),
    'requests', (SELECT coalesce(json_agg(r ORDER BY r.at DESC), '[]'::json) FROM (
      SELECT x.at, x.method, x.path, x.status, x.duration_ms FROM integrations.api_requests x
      WHERE x.key_id = p_key ORDER BY x.at DESC LIMIT 100) r));
END;
$$;

-- First non-empty text among several field names. Numbers count as text (phone numbers often are).
CREATE FUNCTION integrations.pick(p_data JSONB, p_names TEXT[])
RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT nullif(btrim(p_data->>n), '')
  FROM unnest(p_names) WITH ORDINALITY AS x(n, place)
  WHERE jsonb_typeof(p_data->n) IN ('string', 'number') AND nullif(btrim(p_data->>n), '') IS NOT NULL
  ORDER BY place LIMIT 1;
$$;

-- Common field names, lower-cased, for leads and contacts sent from other tools
CREATE FUNCTION integrations.person_fields(p_data JSONB)
RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
  d JSONB;
  first_name TEXT;
  last_name TEXT;
  full_name TEXT;
  address TEXT;
BEGIN
  SELECT coalesce(jsonb_object_agg(lower(e.key), e.value), '{}'::jsonb) INTO d FROM jsonb_each(p_data) e;
  -- Some tools wrap the fields in "data" or "fields"
  IF integrations.pick(d, ARRAY['name', 'email', 'full_name', 'first_name']) IS NULL THEN
    IF jsonb_typeof(d->'data') = 'object' THEN
      SELECT coalesce(jsonb_object_agg(lower(e.key), e.value), '{}'::jsonb) INTO d FROM jsonb_each(d->'data') e;
    ELSIF jsonb_typeof(d->'fields') = 'object' THEN
      SELECT coalesce(jsonb_object_agg(lower(e.key), e.value), '{}'::jsonb) INTO d FROM jsonb_each(d->'fields') e;
    END IF;
  END IF;
  first_name := integrations.pick(d, ARRAY['first_name', 'firstname', 'given_name']);
  last_name := integrations.pick(d, ARRAY['last_name', 'lastname', 'surname', 'family_name']);
  full_name := integrations.pick(d, ARRAY['name', 'full_name', 'fullname', 'contact_name']);
  address := lower(integrations.pick(d, ARRAY['email', 'email_address', 'e-mail', 'mail']));
  RETURN jsonb_build_object(
    'name', coalesce(full_name, nullif(btrim(concat_ws(' ', first_name, last_name)), ''), address),
    'email', address,
    'phone', integrations.pick(d, ARRAY['phone', 'phone_number', 'mobile', 'telephone', 'tel']),
    'company', integrations.pick(d, ARRAY['company', 'company_name', 'organization', 'organisation', 'business']),
    'job_title', integrations.pick(d, ARRAY['job_title', 'title', 'position', 'role']),
    'message', integrations.pick(d, ARRAY['message', 'notes', 'note', 'comments', 'comment', 'description']),
    'campaign', integrations.pick(d, ARRAY['campaign', 'utm_campaign']),
    'source', integrations.pick(d, ARRAY['source', 'lead_source']));
END;
$$;

-- Returns what is wrong with a person's fields, or null
CREATE FUNCTION integrations.person_problem(p JSONB, p_need_contact BOOLEAN)
RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE
    WHEN coalesce(length(p->>'name'), 0) = 0 THEN 'Send a name (or first_name and last_name) or an email'
    WHEN length(p->>'name') > 200 THEN 'The name can be up to 200 characters'
    WHEN p_need_contact AND p->>'email' IS NULL AND p->>'phone' IS NULL THEN 'Send an email or a phone number'
    WHEN length(p->>'email') > 254 OR (p->>'email' IS NOT NULL AND p->>'email' !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') THEN 'The email is not valid'
    WHEN length(p->>'phone') > 40 THEN 'The phone number can be up to 40 characters'
    WHEN length(p->>'company') > 200 OR length(p->>'job_title') > 200 THEN 'The company or job title is too long (200 characters at most)'
    WHEN length(p->>'message') > 2000 THEN 'The message can be up to 2,000 characters'
    WHEN length(p->>'source') > 100 OR length(p->>'campaign') > 100 THEN 'The source or campaign can be up to 100 characters'
  END;
$$;

-- Adds a lead the way the web form does. When an open lead already has this email, a note is added
-- to it instead of making a duplicate. Returns created true or false and the lead's id.
CREATE FUNCTION integrations.add_lead(p_tenant UUID, p JSONB, p_source TEXT, p_again TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  earlier crm.leads;
  new_id UUID;
BEGIN
  PERFORM set_config('crm.trusted', 'on', true);
  IF p->>'email' IS NOT NULL THEN
    SELECT * INTO earlier FROM crm.leads l
      WHERE l.tenant_id = p_tenant AND l.email = p->>'email' AND l.status IN ('new', 'working')
      ORDER BY l.created_at LIMIT 1;
  END IF;
  IF earlier.id IS NOT NULL THEN
    INSERT INTO crm.activities (tenant_id, kind, subject, body, lead_id, owner_id)
      VALUES (p_tenant, 'note', p_again, p->>'message', earlier.id, earlier.owner_id);
    IF p->>'campaign' IS NOT NULL AND nullif(btrim(coalesce(earlier.campaign, '')), '') IS NULL THEN
      UPDATE crm.leads SET campaign = p->>'campaign' WHERE id = earlier.id;
    END IF;
    RETURN jsonb_build_object('created', false, 'id', earlier.id);
  END IF;
  INSERT INTO crm.leads (tenant_id, name, email, phone, company_name, job_title, notes, source, from_form, campaign)
    VALUES (p_tenant, p->>'name', p->>'email', p->>'phone', p->>'company', p->>'job_title', p->>'message',
      coalesce(p->>'source', p_source), false, p->>'campaign')
    RETURNING id INTO new_id;
  RETURN jsonb_build_object('created', true, 'id', new_id);
END;
$$;

-- Adds a contact. When a contact already has this email, that one is returned instead.
CREATE FUNCTION integrations.add_contact(p_tenant UUID, p JSONB, p_source TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  found_id UUID;
BEGIN
  IF p->>'email' IS NOT NULL THEN
    SELECT c.id INTO found_id FROM crm.contacts c
      WHERE c.tenant_id = p_tenant AND lower(c.email) = p->>'email' ORDER BY c.created_at LIMIT 1;
    IF found_id IS NOT NULL THEN
      RETURN jsonb_build_object('created', false, 'id', found_id);
    END IF;
  END IF;
  INSERT INTO crm.contacts (tenant_id, name, email, phone, job_title, notes, source, campaign)
    VALUES (p_tenant, p->>'name', p->>'email', p->>'phone', p->>'job_title', p->>'message',
      coalesce(p->>'source', p_source), p->>'campaign')
    RETURNING id INTO found_id;
  RETURN jsonb_build_object('created', true, 'id', found_id);
END;
$$;

-- Same as before, plus leads
CREATE OR REPLACE FUNCTION integrations.api_rows(p_tenant uuid, p_resource text, p_id uuid, p_limit integer, p_offset integer)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  result JSON;
BEGIN
  IF p_resource = 'contacts' THEN
    SELECT coalesce(json_agg(r), '[]'::json) INTO result FROM (
      SELECT c.id, c.name, c.email, c.phone, c.job_title, c.company_id, c.source, c.created_at, c.updated_at
      FROM crm.contacts c WHERE c.tenant_id = p_tenant AND (p_id IS NULL OR c.id = p_id)
      ORDER BY c.created_at, c.id LIMIT p_limit OFFSET p_offset) r;
  ELSIF p_resource = 'invoices' THEN
    SELECT coalesce(json_agg(r), '[]'::json) INTO result FROM (
      SELECT i.id, i.invoice_number, i.status, i.customer_id, i.customer_name, i.invoice_date, i.due_date, i.currency,
        i.subtotal, i.tax_amount, i.amount, i.amount_paid, i.amount_credited, i.paid_at, i.created_at, i.updated_at
      FROM accounting.invoices i WHERE i.tenant_id = p_tenant AND (p_id IS NULL OR i.id = p_id)
      ORDER BY i.created_at, i.id LIMIT p_limit OFFSET p_offset) r;
  ELSIF p_resource = 'items' THEN
    SELECT coalesce(json_agg(r), '[]'::json) INTO result FROM (
      SELECT t.id, t.sku, t.name, t.quantity, t.price, t.reorder_level, t.created_at, t.updated_at
      FROM inventory.items t WHERE t.tenant_id = p_tenant AND (p_id IS NULL OR t.id = p_id)
      ORDER BY t.created_at, t.id LIMIT p_limit OFFSET p_offset) r;
  ELSIF p_resource = 'deals' THEN
    SELECT coalesce(json_agg(r), '[]'::json) INTO result FROM (
      SELECT d.id, d.title, d.value, s.name AS stage, s.kind AS status, d.contact_id, d.company_id,
        d.expected_close, d.closed_at, d.created_at, d.updated_at
      FROM crm.deals d LEFT JOIN crm.stages s ON s.id = d.stage_id
      WHERE d.tenant_id = p_tenant AND (p_id IS NULL OR d.id = p_id)
      ORDER BY d.created_at, d.id LIMIT p_limit OFFSET p_offset) r;
  ELSIF p_resource = 'leads' THEN
    SELECT coalesce(json_agg(r), '[]'::json) INTO result FROM (
      SELECT l.id, l.name, l.email, l.phone, l.company_name, l.job_title, l.source, l.campaign, l.status, l.score,
        l.converted_contact_id, l.converted_at, l.created_at, l.updated_at
      FROM crm.leads l WHERE l.tenant_id = p_tenant AND (p_id IS NULL OR l.id = p_id)
      ORDER BY l.created_at, l.id LIMIT p_limit OFFSET p_offset) r;
  ELSE
    RAISE EXCEPTION 'Unknown resource. Use contacts, invoices, items, deals or leads.' USING ERRCODE = 'PT404';
  END IF;
  RETURN result;
END;
$function$;

-- Public API writes: add a contact or a lead. Needs a key that can read and write.
-- 201-style answer { created: true, data } for a new record, { created: false, data } when the email
-- was already there. Errors use PTxxx codes: 403 read-only key, 422 bad fields, 429 daily limit.
CREATE FUNCTION integrations.api_create(p_key TEXT, p_resource TEXT, p_data JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  company UUID := integrations.key_tenant(p_key);
  k integrations.api_keys;
  person JSONB;
  problem TEXT;
  used INT;
  cap INT := (integrations.limits()->>'api_writes_per_day')::int;
  made JSONB;
BEGIN
  SELECT * INTO k FROM integrations.api_keys x WHERE x.key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex');
  IF k.scope IS DISTINCT FROM 'write' THEN
    RAISE EXCEPTION 'This API key can only read. Make a key that can read and write.' USING ERRCODE = 'PT403';
  END IF;
  IF p_resource IS NULL OR p_resource NOT IN ('contacts', 'leads') THEN
    RAISE EXCEPTION 'You can add contacts and leads' USING ERRCODE = 'PT405';
  END IF;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Send the fields as a JSON object' USING ERRCODE = 'PT422';
  END IF;

  person := integrations.person_fields(p_data);
  problem := integrations.person_problem(person, p_resource = 'leads');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION '%', problem USING ERRCODE = 'PT422';
  END IF;

  -- Daily limit per company, across all its keys. A refused write rolls this back too.
  UPDATE integrations.api_keys SET
    write_count = CASE WHEN write_day = current_date THEN write_count + 1 ELSE 1 END,
    write_day = current_date
    WHERE id = k.id;
  SELECT coalesce(sum(x.write_count), 0) INTO used FROM integrations.api_keys x WHERE x.tenant_id = company AND x.write_day = current_date;
  IF used > cap THEN
    RAISE EXCEPTION 'This company has added % records through the API today, the most allowed. Try again tomorrow (UTC).', cap
      USING ERRCODE = 'PT429';
  END IF;

  IF p_resource = 'leads' THEN
    made := integrations.add_lead(company, person, 'API', 'Sent again through the API');
  ELSE
    made := integrations.add_contact(company, person, 'API');
  END IF;
  RETURN json_build_object('created', (made->>'created')::boolean,
    'data', integrations.api_rows(company, p_resource, (made->>'id')::uuid, 1, 0)->0);
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- Integrations: incoming webhooks
-- ---------------------------------------------------------------------------------------------

CREATE TABLE integrations.inbound_hooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  source TEXT NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 100),
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  window_start TIMESTAMPTZ,
  window_count INT NOT NULL DEFAULT 0
);
CREATE INDEX idx_integrations_inbound_hooks_tenant ON integrations.inbound_hooks (tenant_id);

-- Which fields came in and what happened; never the values themselves
CREATE TABLE integrations.inbound_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  hook_id UUID NOT NULL REFERENCES integrations.inbound_hooks(id) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  result TEXT NOT NULL CHECK (result IN ('created', 'updated', 'rejected', 'limited')),
  lead_id UUID,
  error TEXT,
  fields TEXT[]
);
CREATE INDEX idx_integrations_inbound_log_hook ON integrations.inbound_log (hook_id, at DESC);
CREATE INDEX idx_integrations_inbound_log_tenant ON integrations.inbound_log (tenant_id, at);

ALTER TABLE integrations.inbound_hooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations.inbound_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY manager_rows ON integrations.inbound_hooks FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT m.tenant_id FROM public.tenant_members m WHERE m.user_id = (SELECT auth.uid()) AND m.role IN ('owner', 'admin')));
CREATE POLICY manager_rows ON integrations.inbound_log FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT m.tenant_id FROM public.tenant_members m WHERE m.user_id = (SELECT auth.uid()) AND m.role IN ('owner', 'admin')));
-- The token hash is never readable
GRANT SELECT (id, tenant_id, name, source, prefix, enabled, created_by, created_at, updated_at, last_used_at) ON integrations.inbound_hooks TO authenticated;
GRANT SELECT ON integrations.inbound_log TO authenticated;

CREATE FUNCTION integrations.inbound_overview(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  member_role TEXT;
BEGIN
  SELECT m.role INTO member_role FROM public.tenant_members m WHERE m.tenant_id = p_tenant AND m.user_id = auth.uid();
  IF member_role IS NULL THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF member_role NOT IN ('owner', 'admin') THEN
    RETURN json_build_object('is_manager', false);
  END IF;
  RETURN json_build_object(
    'is_manager', true,
    'limits', integrations.limits(),
    'used_today', (SELECT count(*) FROM integrations.inbound_log g
      WHERE g.tenant_id = p_tenant AND g.at >= date_trunc('day', now()) AND g.result IN ('created', 'updated')),
    'hooks', (SELECT coalesce(json_agg(r ORDER BY r.created_at), '[]'::json) FROM (
      SELECT h.id, h.name, h.source, h.prefix, h.enabled, h.created_at, h.last_used_at, u.email AS created_by,
        (SELECT count(*) FROM integrations.inbound_log g WHERE g.hook_id = h.id AND g.result = 'created' AND g.at > now() - interval '7 days') AS created_7,
        (SELECT count(*) FROM integrations.inbound_log g WHERE g.hook_id = h.id AND g.result = 'updated' AND g.at > now() - interval '7 days') AS updated_7,
        (SELECT count(*) FROM integrations.inbound_log g WHERE g.hook_id = h.id AND g.result IN ('rejected', 'limited') AND g.at > now() - interval '7 days') AS refused_7
      FROM integrations.inbound_hooks h LEFT JOIN auth.users u ON u.id = h.created_by
      WHERE h.tenant_id = p_tenant) r));
END;
$$;

-- Adds an incoming webhook or renames it. A new one's secret address token comes back this once.
CREATE FUNCTION integrations.save_inbound(p_tenant UUID, p_hook UUID, p_name TEXT, p_source TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  token TEXT := 'ih_' || encode(extensions.gen_random_bytes(24), 'hex');
  new_id UUID;
  lead_source TEXT := btrim(coalesce(nullif(btrim(coalesce(p_source, '')), ''), p_name, ''));
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  IF length(btrim(coalesce(p_name, ''))) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'Enter a name of up to 80 characters';
  END IF;
  IF length(lead_source) > 100 THEN
    RAISE EXCEPTION 'The lead source can be up to 100 characters';
  END IF;
  IF p_hook IS NOT NULL THEN
    UPDATE integrations.inbound_hooks SET name = btrim(p_name), source = lead_source, updated_at = now()
      WHERE id = p_hook AND tenant_id = p_tenant;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Incoming webhook not found';
    END IF;
    RETURN json_build_object('id', p_hook);
  END IF;
  IF (SELECT count(*) FROM integrations.inbound_hooks h WHERE h.tenant_id = p_tenant)
      >= (integrations.limits()->>'inbound_hooks_per_company')::int THEN
    RAISE EXCEPTION 'A company can have up to % incoming webhooks', integrations.limits()->>'inbound_hooks_per_company';
  END IF;
  INSERT INTO integrations.inbound_hooks (tenant_id, name, source, prefix, token_hash, created_by)
    VALUES (p_tenant, btrim(p_name), lead_source, left(token, 9), encode(extensions.digest(token, 'sha256'), 'hex'), auth.uid())
    RETURNING id INTO new_id;
  RETURN json_build_object('id', new_id, 'token', token);
END;
$$;

CREATE FUNCTION integrations.roll_inbound_token(p_tenant UUID, p_hook UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  token TEXT := 'ih_' || encode(extensions.gen_random_bytes(24), 'hex');
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  UPDATE integrations.inbound_hooks SET token_hash = encode(extensions.digest(token, 'sha256'), 'hex'),
    prefix = left(token, 9), updated_at = now()
    WHERE id = p_hook AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Incoming webhook not found';
  END IF;
  RETURN json_build_object('id', p_hook, 'token', token);
END;
$$;

CREATE FUNCTION integrations.set_inbound_enabled(p_tenant UUID, p_hook UUID, p_enabled BOOLEAN)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  UPDATE integrations.inbound_hooks SET enabled = coalesce(p_enabled, false), updated_at = now()
    WHERE id = p_hook AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Incoming webhook not found';
  END IF;
END;
$$;

CREATE FUNCTION integrations.delete_inbound(p_tenant UUID, p_hook UUID)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  DELETE FROM integrations.inbound_hooks WHERE id = p_hook AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Incoming webhook not found';
  END IF;
END;
$$;

CREATE FUNCTION integrations.inbound_history(p_tenant UUID, p_hook UUID)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  IF NOT EXISTS (SELECT 1 FROM integrations.inbound_hooks h WHERE h.id = p_hook AND h.tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'Incoming webhook not found';
  END IF;
  RETURN (SELECT coalesce(json_agg(r ORDER BY r.at DESC), '[]'::json) FROM (
    SELECT g.at, g.result, g.lead_id, g.error, g.fields FROM integrations.inbound_log g
    WHERE g.hook_id = p_hook ORDER BY g.at DESC LIMIT 50) r);
END;
$$;

-- Called by the gateway for POST /api/hooks/in/<token>. There is no signed-in user; the token
-- decides the company. A bad token raises PT404. Everything else is answered with a status
-- (201 made, 200 already there, 422 bad fields, 429 too many) so the log row is kept.
-- The hook stops working if the person who made it is no longer an owner or admin.
CREATE FUNCTION integrations.receive_inbound(p_token TEXT, p_body JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  hook RECORD;
  per_minute INT := (integrations.limits()->>'inbound_per_minute')::int;
  per_day INT := (integrations.limits()->>'inbound_per_day')::int;
  person JSONB;
  problem TEXT;
  made JSONB;
  sent_fields TEXT[];
BEGIN
  IF p_token IS NULL OR p_token !~ '^ih_[0-9a-f]{48}$' THEN
    RAISE EXCEPTION 'Not found' USING ERRCODE = 'PT404';
  END IF;
  UPDATE integrations.inbound_hooks h SET
    last_used_at = now(),
    window_start = CASE WHEN h.window_start IS NULL OR h.window_start < now() - interval '1 minute' THEN now() ELSE h.window_start END,
    window_count = CASE WHEN h.window_start IS NULL OR h.window_start < now() - interval '1 minute' THEN 1 ELSE h.window_count + 1 END
  WHERE h.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    AND h.enabled
    AND EXISTS (SELECT 1 FROM public.tenant_members m WHERE m.tenant_id = h.tenant_id AND m.user_id = h.created_by AND m.role IN ('owner', 'admin'))
    AND EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = h.tenant_id AND t.is_active IS NOT FALSE)
  RETURNING h.id, h.tenant_id, h.name, h.source, h.window_count INTO hook;
  IF hook.id IS NULL THEN
    RAISE EXCEPTION 'Not found' USING ERRCODE = 'PT404';
  END IF;

  IF jsonb_typeof(p_body) = 'object' THEN
    SELECT array_agg(left(k, 40) ORDER BY k) INTO sent_fields FROM (SELECT k FROM jsonb_object_keys(p_body) k LIMIT 30) x;
  END IF;

  IF hook.window_count > per_minute THEN
    -- Only the first refusal in each minute is logged
    IF hook.window_count = per_minute + 1 THEN
      INSERT INTO integrations.inbound_log (tenant_id, hook_id, result, error, fields)
        VALUES (hook.tenant_id, hook.id, 'limited', format('More than %s in a minute', per_minute), sent_fields);
    END IF;
    RETURN json_build_object('status', 429, 'error', 'Too many requests. Wait a minute and try again.');
  END IF;
  IF (SELECT count(*) FROM integrations.inbound_log g WHERE g.tenant_id = hook.tenant_id
      AND g.at >= date_trunc('day', now()) AND g.result IN ('created', 'updated')) >= per_day THEN
    IF NOT EXISTS (SELECT 1 FROM integrations.inbound_log g WHERE g.hook_id = hook.id AND g.result = 'limited'
        AND g.at >= date_trunc('day', now())) THEN
      INSERT INTO integrations.inbound_log (tenant_id, hook_id, result, error, fields)
        VALUES (hook.tenant_id, hook.id, 'limited', format('The company''s %s a day were used up', per_day), sent_fields);
      PERFORM integrations.alert_managers(hook.tenant_id, 'Incoming webhook limit reached for today',
        format('Incoming webhooks added or updated %s leads today, the most allowed. More are refused until tomorrow (UTC).', per_day),
        'inbound-cap:' || to_char(now(), 'YYYY-MM-DD'));
    END IF;
    RETURN json_build_object('status', 429, 'error', 'This company has received the most leads allowed today. Try again tomorrow.');
  END IF;

  IF jsonb_typeof(p_body) IS DISTINCT FROM 'object' THEN
    problem := 'Send the fields as a JSON object or a form';
  ELSE
    person := integrations.person_fields(p_body) - 'source';
    problem := integrations.person_problem(person, true);
  END IF;
  IF problem IS NOT NULL THEN
    INSERT INTO integrations.inbound_log (tenant_id, hook_id, result, error, fields)
      VALUES (hook.tenant_id, hook.id, 'rejected', problem, sent_fields);
    RETURN json_build_object('status', 422, 'error', problem);
  END IF;

  made := integrations.add_lead(hook.tenant_id, person, hook.source, 'Sent again by ' || hook.name);
  INSERT INTO integrations.inbound_log (tenant_id, hook_id, result, lead_id, fields)
    VALUES (hook.tenant_id, hook.id, CASE WHEN (made->>'created')::boolean THEN 'created' ELSE 'updated' END,
      (made->>'id')::uuid, sent_fields);
  RETURN json_build_object('status', CASE WHEN (made->>'created')::boolean THEN 201 ELSE 200 END,
    'ok', true, 'created', (made->>'created')::boolean, 'lead_id', made->>'id');
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- Integrations: replaced functions (same output as before, plus the new parts)
-- ---------------------------------------------------------------------------------------------

-- Same as before, plus each key's scope and requests in the last day
CREATE OR REPLACE FUNCTION integrations.overview(p_tenant uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  member_role TEXT;
BEGIN
  SELECT m.role INTO member_role FROM public.tenant_members m WHERE m.tenant_id = p_tenant AND m.user_id = auth.uid();
  IF member_role IS NULL THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF member_role NOT IN ('owner', 'admin') THEN
    RETURN json_build_object('is_manager', false);
  END IF;

  RETURN json_build_object(
    'is_manager', true,
    'limits', integrations.limits(),
    'used_today', (SELECT count(*) FROM integrations.deliveries d WHERE d.tenant_id = p_tenant AND d.created_at >= date_trunc('day', now())),
    'webhooks', (
      SELECT coalesce(json_agg(r ORDER BY r.created_at), '[]'::json) FROM (
        SELECT w.id, w.name, w.url, w.events, w.enabled, w.failures_in_row, w.disabled_at, w.disabled_reason,
          w.last_success_at, w.last_failure_at, w.secret_hint, w.created_at,
          (SELECT count(*) FROM integrations.deliveries d WHERE d.webhook_id = w.id AND d.status IN ('pending', 'sending')) AS waiting,
          (SELECT count(*) FROM integrations.deliveries d WHERE d.webhook_id = w.id AND d.status = 'delivered' AND d.created_at > now() - interval '7 days') AS delivered_7,
          (SELECT count(*) FROM integrations.deliveries d WHERE d.webhook_id = w.id AND d.status = 'failed' AND d.created_at > now() - interval '7 days') AS failed_7
        FROM integrations.webhooks w WHERE w.tenant_id = p_tenant
      ) r
    ),
    'api_keys', (
      SELECT coalesce(json_agg(r ORDER BY r.revoked_at NULLS FIRST, r.created_at DESC), '[]'::json) FROM (
        SELECT k.id, k.name, k.prefix, k.created_at, k.last_used_at, k.revoked_at, u.email AS created_by, k.scope,
          (SELECT count(*) FROM integrations.api_requests q WHERE q.key_id = k.id AND q.at > now() - interval '1 day') AS requests_1d
        FROM integrations.api_keys k LEFT JOIN auth.users u ON u.id = k.created_by
        WHERE k.tenant_id = p_tenant
      ) r
    ),
    'jobs', integrations.job_status()
  );
END;
$function$;

-- Same as before, plus the daily analytics snapshot job
CREATE OR REPLACE FUNCTION integrations.job_status()
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT coalesce(json_agg(r ORDER BY r.name), '[]'::json) FROM (
    SELECT j.jobname AS name, j.schedule, j.active,
      CASE j.jobname
        WHEN 'integrations-webhooks' THEN 'Sends queued webhook events and retries failed ones'
        WHEN 'integrations-cleanup' THEN 'Deletes webhook, API and incoming webhook logs older than 30 days, and old job history'
        WHEN 'crm-automations' THEN 'Runs time-based CRM rules and task reminders, and deletes alerts older than 90 days'
        WHEN 'analytics-snapshots' THEN 'Saves a daily copy of key numbers (money owed, pipeline, stock, staff) for trends'
      END AS description,
      last.status AS last_status, last.start_time AS last_run,
      CASE WHEN last.status = 'failed' THEN left(last.return_message, 200) END AS last_error,
      (SELECT count(*) FROM cron.job_run_details f WHERE f.jobid = j.jobid AND f.status = 'failed'
        AND f.start_time > now() - interval '1 day') AS failed_today
    FROM cron.job j
    LEFT JOIN LATERAL (
      SELECT d.status, d.start_time, d.return_message FROM cron.job_run_details d
      WHERE d.jobid = j.jobid ORDER BY d.start_time DESC LIMIT 1
    ) last ON true
    WHERE j.jobname IN ('integrations-webhooks', 'integrations-cleanup', 'crm-automations', 'analytics-snapshots')
  ) r;
$function$;

-- Same as before, plus the API request log and the incoming webhook log
CREATE OR REPLACE FUNCTION integrations.cleanup()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  DELETE FROM integrations.deliveries
    WHERE created_at < now() - make_interval(days => (integrations.limits()->>'log_days')::int)
      AND status IN ('delivered', 'failed');
  DELETE FROM integrations.api_requests
    WHERE at < now() - make_interval(days => (integrations.limits()->>'log_days')::int);
  DELETE FROM integrations.inbound_log
    WHERE at < now() - make_interval(days => (integrations.limits()->>'log_days')::int);
  DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days';
END;
$function$;

DO $$
DECLARE
  fn TEXT;
BEGIN
  -- Used only inside other functions and pg_cron
  FOREACH fn IN ARRAY ARRAY['integrations.pick(jsonb, text[])', 'integrations.person_fields(jsonb)',
      'integrations.person_problem(jsonb, boolean)', 'integrations.add_lead(uuid, jsonb, text, text)',
      'integrations.add_contact(uuid, jsonb, text)', 'integrations.api_rows(uuid, text, uuid, integer, integer)',
      'integrations.job_status()', 'integrations.cleanup()']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
  END LOOP;

  -- Signed-in users; each checks the role itself
  FOREACH fn IN ARRAY ARRAY['integrations.limits()', 'integrations.overview(uuid)',
      'integrations.make_api_key(uuid, text, text)', 'integrations.api_key_log(uuid, uuid)',
      'integrations.inbound_overview(uuid)', 'integrations.save_inbound(uuid, uuid, text, text)',
      'integrations.roll_inbound_token(uuid, uuid)', 'integrations.set_inbound_enabled(uuid, uuid, boolean)',
      'integrations.delete_inbound(uuid, uuid)', 'integrations.inbound_history(uuid, uuid)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
  END LOOP;

  -- Public: no signed-in user, the key or token is checked inside
  FOREACH fn IN ARRAY ARRAY['integrations.api_create(text, text, jsonb)', 'integrations.api_log(text, text, text, integer, integer)',
      'integrations.receive_inbound(text, jsonb)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon, authenticated', fn);
  END LOOP;
END;
$$;

-- Daily snapshot at 02:23 UTC. Run again safely: removed by name before it is added.
DO $$
BEGIN
  PERFORM cron.unschedule(j.jobname) FROM cron.job j WHERE j.jobname = 'analytics-snapshots';
  PERFORM cron.schedule('analytics-snapshots', '23 2 * * *', 'SELECT analytics.take_snapshots()');
END;
$$;

-- The first snapshot, so the history isn't empty until tomorrow
SELECT analytics.take_snapshots();

NOTIFY pgrst, 'reload schema';
