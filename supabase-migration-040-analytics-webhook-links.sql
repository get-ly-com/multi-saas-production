-- Links Scheduler, Chat and Social to Analytics and Webhooks.
-- 1. The business dashboard gets a "Customers and marketing" section: bookings, cancellations,
--    upcoming bookings, chats, chats that asked for a person, first staff reply time, leads from chat
--    and social posts. Bookings and chats are added to the 12-month trend.
-- 2. New webhook events: booking.created, booking.cancelled, chat.started, chat.handed_over, social.posted.
-- Only triggers are added to the scheduler, chat and social tables; their own functions are untouched.
-- Columns other products may add later (campaign, contact_id) are read with to_jsonb(NEW), so these
-- triggers work whether or not those columns exist yet.

-- ---------------------------------------------------------------------------------------------
-- Analytics
-- ---------------------------------------------------------------------------------------------

-- Customer and marketing numbers for one period
CREATE OR REPLACE FUNCTION analytics.marketing_totals(p_tenant UUID, p_from DATE, p_to DATE)
RETURNS JSON
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  WITH made AS (
    SELECT count(*) AS bookings, coalesce(sum(s.price), 0) AS booking_value
    FROM scheduler.bookings b LEFT JOIN scheduler.services s ON s.id = b.service_id
    WHERE b.tenant_id = p_tenant AND b.status = 'booked' AND b.created_at >= p_from AND b.created_at < p_to + 1
  ), cancelled AS (
    SELECT count(*) AS cancellations FROM scheduler.bookings
    WHERE tenant_id = p_tenant AND status = 'cancelled' AND cancelled_at >= p_from AND cancelled_at < p_to + 1
  ), chats AS (
    SELECT count(*) AS chats, count(*) FILTER (WHERE c.wants_person) AS chats_wanted_person,
      -- From the visitor's first message to the first staff reply after it
      round((avg(extract(epoch FROM r.first_staff - r.first_visitor)) / 60)::numeric, 1) AS first_reply_minutes
    FROM chat.conversations c
    LEFT JOIN LATERAL (
      SELECT v.first_visitor,
        (SELECT min(m.created_at) FROM chat.messages m
          WHERE m.conversation_id = c.id AND m.sender = 'staff' AND m.created_at >= v.first_visitor) AS first_staff
      FROM (SELECT min(m.created_at) AS first_visitor FROM chat.messages m
        WHERE m.conversation_id = c.id AND m.sender = 'visitor') v
    ) r ON true
    WHERE c.tenant_id = p_tenant AND c.created_at >= p_from AND c.created_at < p_to + 1
  ), chat_leads AS (
    SELECT count(*) AS chat_leads FROM crm.leads l
    WHERE l.tenant_id = p_tenant AND l.created_at >= p_from AND l.created_at < p_to + 1
      AND EXISTS (SELECT 1 FROM chat.conversations c WHERE c.lead_id = l.id AND c.tenant_id = p_tenant)
  ), posts AS (
    SELECT count(*) AS posts FROM social.posts
    WHERE tenant_id = p_tenant AND status = 'posted' AND posted_at >= p_from AND posted_at < p_to + 1
  )
  SELECT json_build_object(
    'from', p_from, 'to', p_to,
    'bookings', made.bookings, 'booking_value', made.booking_value, 'cancellations', cancelled.cancellations,
    'chats', chats.chats, 'chats_wanted_person', chats.chats_wanted_person,
    'first_reply_minutes', chats.first_reply_minutes,
    'chat_leads', chat_leads.chat_leads, 'posts', posts.posts
  ) FROM made, cancelled, chats, chat_leads, posts;
$$;

-- Same as before, plus bookings made and chats started each month
CREATE OR REPLACE FUNCTION analytics.monthly_trend(p_tenant uuid, p_month date, p_payroll boolean)
 RETURNS json
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  WITH bounds AS (
    SELECT (date_trunc('month', p_month) - interval '11 months')::date AS first_day,
      (date_trunc('month', p_month) + interval '1 month' - interval '1 day')::date AS last_day
  ), months AS (
    SELECT generate_series(b.first_day, b.last_day, interval '1 month')::date AS month FROM bounds b
  ), sales AS (
    SELECT date_trunc('month', invoice_date)::date AS month,
      sum(round(coalesce(subtotal, amount - coalesce(tax_amount, 0)) * exchange_rate, 2)) AS revenue
    FROM accounting.invoices, bounds b
    WHERE tenant_id = p_tenant AND status IN ('sent', 'partial', 'paid') AND invoice_date BETWEEN b.first_day AND b.last_day
    GROUP BY 1
  ), cash_entries AS (
    SELECT date_trunc('month', e.entry_date)::date AS month, sum(l.debit - l.credit) AS cash
    FROM accounting.journal_lines l
    JOIN accounting.journal_entries e ON e.id = l.entry_id
    JOIN accounting.accounts a ON a.id = l.account_id, bounds b
    WHERE l.tenant_id = p_tenant AND a.is_cash AND e.entry_date BETWEEN b.first_day AND b.last_day
    GROUP BY coalesce(e.reversal_of, e.id), 1
  ), cash AS (
    SELECT month, coalesce(sum(cash) FILTER (WHERE cash > 0), 0) AS cash_in,
      coalesce(-sum(cash) FILTER (WHERE cash < 0), 0) AS cash_out
    FROM cash_entries GROUP BY month
  ), books AS (
    SELECT date_trunc('month', e.entry_date)::date AS month,
      sum(l.credit - l.debit) AS profit -- revenue minus expenses
    FROM accounting.journal_lines l
    JOIN accounting.journal_entries e ON e.id = l.entry_id
    JOIN accounting.accounts a ON a.id = l.account_id, bounds b
    WHERE l.tenant_id = p_tenant AND e.source_type <> 'closing' AND a.type IN ('revenue', 'expense')
      AND e.entry_date BETWEEN b.first_day AND b.last_day
    GROUP BY 1
  ), leads AS (
    SELECT date_trunc('month', created_at)::date AS month, count(*) AS new_leads
    FROM crm.leads, bounds b
    WHERE tenant_id = p_tenant AND created_at >= b.first_day AND created_at < b.last_day + 1
    GROUP BY 1
  ), won AS (
    SELECT date_trunc('month', d.closed_at)::date AS month, sum(d.value) AS won_value
    FROM crm.deals d JOIN crm.stages s ON s.id = d.stage_id, bounds b
    WHERE d.tenant_id = p_tenant AND s.kind = 'won' AND d.closed_at >= b.first_day AND d.closed_at < b.last_day + 1
    GROUP BY 1
  ), pay AS (
    SELECT date_trunc('month', pay_date)::date AS month, sum(gross + employer_costs) AS payroll
    FROM hr.pay_runs, bounds b
    WHERE p_payroll AND tenant_id = p_tenant AND status IN ('approved', 'paid') AND pay_date BETWEEN b.first_day AND b.last_day
    GROUP BY 1
  ), booked AS (
    SELECT date_trunc('month', created_at)::date AS month, count(*) AS bookings
    FROM scheduler.bookings, bounds b
    WHERE tenant_id = p_tenant AND status = 'booked' AND created_at >= b.first_day AND created_at < b.last_day + 1
    GROUP BY 1
  ), chatted AS (
    SELECT date_trunc('month', created_at)::date AS month, count(*) AS chats
    FROM chat.conversations, bounds b
    WHERE tenant_id = p_tenant AND created_at >= b.first_day AND created_at < b.last_day + 1
    GROUP BY 1
  )
  SELECT json_agg(json_build_object(
    'month', m.month,
    'revenue', coalesce(sales.revenue, 0),
    'cash_in', coalesce(cash.cash_in, 0),
    'cash_out', coalesce(cash.cash_out, 0),
    'profit', coalesce(books.profit, 0),
    'new_leads', coalesce(leads.new_leads, 0),
    'won_value', coalesce(won.won_value, 0),
    'payroll', CASE WHEN p_payroll THEN coalesce(pay.payroll, 0) END,
    'bookings', coalesce(booked.bookings, 0),
    'chats', coalesce(chatted.chats, 0)
  ) ORDER BY m.month)
  FROM months m
  LEFT JOIN sales ON sales.month = m.month
  LEFT JOIN cash ON cash.month = m.month
  LEFT JOIN books ON books.month = m.month
  LEFT JOIN leads ON leads.month = m.month
  LEFT JOIN won ON won.month = m.month
  LEFT JOIN pay ON pay.month = m.month
  LEFT JOIN booked ON booked.month = m.month
  LEFT JOIN chatted ON chatted.month = m.month;
$function$;

-- Same as before, plus 'marketing'
CREATE OR REPLACE FUNCTION analytics.dashboard(p_tenant uuid, p_from date, p_to date)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  member_role TEXT;
  sees_pay BOOLEAN;
  months INT;
  prev_from DATE;
  prev_to DATE;
  as_of DATE;
  products JSON;
BEGIN
  SELECT role INTO member_role FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = auth.uid();
  IF member_role IS NULL THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'Choose a start date before the end date';
  END IF;
  IF p_to - p_from > 731 THEN
    RAISE EXCEPTION 'Choose up to two years';
  END IF;
  sees_pay := member_role IN ('owner', 'admin');

  months := (extract(year FROM age(p_to + 1, p_from)) * 12 + extract(month FROM age(p_to + 1, p_from)))::int;
  IF extract(day FROM p_from) = 1 AND (p_to + 1) = (p_from + make_interval(months => months))::date AND months > 0 THEN
    prev_from := (p_from - make_interval(months => months))::date;
  ELSE
    prev_from := p_from - (p_to - p_from + 1);
  END IF;
  prev_to := p_from - 1;
  -- Head count is taken on the last day of the period, or today if that is still ahead
  as_of := least(p_to, current_date);

  -- Product profit reads up to a year
  products := inventory.product_profit(p_tenant, greatest(p_from, p_to - 366), p_to);

  RETURN json_build_object(
    'role', member_role,
    'sees_payroll', sees_pay,
    'currency', coalesce((SELECT base_currency FROM accounting.settings WHERE tenant_id = p_tenant), 'USD'),
    'current', analytics.period_totals(p_tenant, p_from, p_to, sees_pay),
    'previous', analytics.period_totals(p_tenant, prev_from, prev_to, sees_pay),
    -- The trend stops at this month, so a period that runs into the future doesn't show empty months
    'trend', analytics.monthly_trend(p_tenant, least(p_to, current_date), sees_pay),
    'receivables', (
      SELECT json_build_object(
        'outstanding', coalesce(sum(base_amount - base_settled), 0),
        'overdue', coalesce(sum(base_amount - base_settled) FILTER (WHERE due_date < current_date), 0),
        'overdue_count', count(*) FILTER (WHERE due_date < current_date))
      FROM accounting.invoices WHERE tenant_id = p_tenant AND status IN ('sent', 'partial')),
    'pipeline', (
      SELECT json_build_object(
        'open_deals', count(*),
        'value', coalesce(sum(d.value), 0),
        'weighted', coalesce(sum(d.value * s.probability / 100.0), 0))
      FROM crm.deals d JOIN crm.stages s ON s.id = d.stage_id
      WHERE d.tenant_id = p_tenant AND s.kind = 'open'),
    'stock', (
      SELECT json_build_object(
        'items', count(*),
        'value', coalesce(sum(stock_value), 0),
        'low', count(*) FILTER (WHERE quantity <= reorder_level))
      FROM inventory.items WHERE tenant_id = p_tenant),
    'people', (
      SELECT json_build_object(
        'as_of', as_of,
        'headcount', count(*) FILTER (WHERE start_date <= as_of AND (end_date IS NULL OR end_date >= as_of)),
        'previous', count(*) FILTER (WHERE start_date <= prev_to AND (end_date IS NULL OR end_date >= prev_to)),
        'joined', count(*) FILTER (WHERE start_date BETWEEN p_from AND as_of),
        'left', count(*) FILTER (WHERE end_date BETWEEN p_from AND as_of))
      FROM hr.employees WHERE tenant_id = p_tenant),
    'top_customers', coalesce((
      SELECT json_agg(t ORDER BY t.revenue DESC, t.name) FROM (
        SELECT i.customer_id, coalesce(c.name, nullif(i.customer_name, ''), 'No customer') AS name,
          sum(round(coalesce(i.subtotal, i.amount - coalesce(i.tax_amount, 0)) * i.exchange_rate, 2)) AS revenue,
          count(*) AS invoices
        FROM accounting.invoices i
        LEFT JOIN accounting.customers c ON c.id = i.customer_id
        WHERE i.tenant_id = p_tenant AND i.status IN ('sent', 'partial', 'paid') AND i.invoice_date BETWEEN p_from AND p_to
        GROUP BY 1, 2
        ORDER BY revenue DESC, name
        LIMIT 5) t), '[]'::json),
    'top_products', coalesce((
      SELECT json_agg(p.value ORDER BY p.n) FROM (
        SELECT value, n FROM json_array_elements(products -> 'items') WITH ORDINALITY AS x(value, n)
        ORDER BY n LIMIT 5) p), '[]'::json),
    'products_from', greatest(p_from, p_to - 366),
    -- Customers and marketing: bookings, chats and social posts
    'marketing', json_build_object(
      'current', analytics.marketing_totals(p_tenant, p_from, p_to),
      'previous', analytics.marketing_totals(p_tenant, prev_from, prev_to),
      'upcoming', (
        SELECT json_build_object('bookings', count(*), 'value', coalesce(sum(s.price), 0))
        FROM scheduler.bookings b LEFT JOIN scheduler.services s ON s.id = b.service_id
        WHERE b.tenant_id = p_tenant AND b.status = 'booked'
          AND b.starts_at >= now() AND b.starts_at < now() + interval '7 days'))
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION analytics.marketing_totals(uuid, date, date) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION analytics.monthly_trend(uuid, date, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION analytics.dashboard(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION analytics.dashboard(uuid, date, date) TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- Webhooks
-- ---------------------------------------------------------------------------------------------

ALTER TABLE integrations.webhooks DROP CONSTRAINT webhooks_events_check;
ALTER TABLE integrations.webhooks ADD CONSTRAINT webhooks_events_check
  CHECK (cardinality(events) BETWEEN 1 AND 20 AND events <@ ARRAY[
    'invoice.created', 'invoice.paid', 'contact.created', 'lead.created',
    'deal.won', 'deal.lost', 'leave.approved', 'payrun.approved',
    'booking.created', 'booking.cancelled', 'chat.started', 'chat.handed_over', 'social.posted']);

-- Same as before, with the new events allowed
CREATE OR REPLACE FUNCTION integrations.save_webhook(p_tenant uuid, p_webhook uuid, p_name text, p_url text, p_events text[])
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  problem TEXT := integrations.url_problem(trim(coalesce(p_url, '')));
  chosen TEXT[];
  new_id UUID := gen_random_uuid();
  signing_secret TEXT;
BEGIN
  PERFORM accounting.require_manager(p_tenant);

  IF length(trim(coalesce(p_name, ''))) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'Enter a name of up to 80 characters';
  END IF;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION '%', problem;
  END IF;
  SELECT array_agg(DISTINCT e ORDER BY e) INTO chosen FROM unnest(p_events) e;
  IF chosen IS NULL OR NOT chosen <@ ARRAY['invoice.created', 'invoice.paid', 'contact.created', 'lead.created',
      'deal.won', 'deal.lost', 'leave.approved', 'payrun.approved',
      'booking.created', 'booking.cancelled', 'chat.started', 'chat.handed_over', 'social.posted'] THEN
    RAISE EXCEPTION 'Choose at least one event';
  END IF;

  IF p_webhook IS NOT NULL THEN
    UPDATE integrations.webhooks SET name = trim(p_name), url = trim(p_url), events = chosen, updated_at = now()
      WHERE id = p_webhook AND tenant_id = p_tenant;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Webhook not found';
    END IF;
    RETURN json_build_object('id', p_webhook);
  END IF;

  IF (SELECT count(*) FROM integrations.webhooks w WHERE w.tenant_id = p_tenant) >= (integrations.limits()->>'webhooks_per_company')::int THEN
    RAISE EXCEPTION 'A company can have up to % webhooks', integrations.limits()->>'webhooks_per_company';
  END IF;

  signing_secret := 'whsec_' || encode(extensions.gen_random_bytes(24), 'hex');
  INSERT INTO integrations.webhooks (id, tenant_id, name, url, events, secret_id, secret_hint, created_by)
    VALUES (new_id, p_tenant, trim(p_name), trim(p_url), chosen,
      vault.create_secret(signing_secret, 'integrations_webhook_' || new_id, 'Webhook signing secret'),
      right(signing_secret, 4), auth.uid());

  -- The secret is shown this one time
  RETURN json_build_object('id', new_id, 'secret', signing_secret);
END;
$function$;

-- Bookings. booking.created carries the customer's name and email, like contact.created.
-- Never the notes, phone or cancel reason.
CREATE OR REPLACE FUNCTION integrations.on_booking()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  row_data JSONB := to_jsonb(NEW);
  data JSONB;
BEGIN
  data := jsonb_build_object(
    'id', NEW.id, 'service_id', NEW.service_id,
    'service', (SELECT s.name FROM scheduler.services s WHERE s.id = NEW.service_id),
    'staff_id', NEW.staff_id, 'starts_at', NEW.starts_at, 'ends_at', NEW.ends_at, 'status', NEW.status,
    'location_type', NEW.location_type, 'source', NEW.source, 'contact_id', NEW.contact_id,
    'campaign', row_data->'campaign', 'created_at', NEW.created_at);
  IF TG_OP = 'INSERT' THEN
    PERFORM integrations.safe_enqueue(NEW.tenant_id, 'booking.created',
      data || jsonb_build_object('customer_name', NEW.customer_name, 'customer_email', NEW.customer_email));
  ELSE
    PERFORM integrations.safe_enqueue(NEW.tenant_id, 'booking.cancelled',
      data || jsonb_build_object('cancelled_at', NEW.cancelled_at, 'cancelled_by_visitor', NEW.cancelled_by_visitor));
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS zz_webhooks ON scheduler.bookings;
CREATE TRIGGER zz_webhooks AFTER INSERT ON scheduler.bookings
  FOR EACH ROW WHEN (NEW.status = 'booked')
  EXECUTE FUNCTION integrations.on_booking();
DROP TRIGGER IF EXISTS zz_webhooks_cancelled ON scheduler.bookings;
CREATE TRIGGER zz_webhooks_cancelled AFTER UPDATE ON scheduler.bookings
  FOR EACH ROW WHEN (NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled')
  EXECUTE FUNCTION integrations.on_booking();

-- Chats: ids and times only, never message text or the visitor's name or email.
-- chat.handed_over fires the first time a chat asks for a person (wants_person is never turned back off).
CREATE OR REPLACE FUNCTION integrations.on_chat()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  row_data JSONB := to_jsonb(NEW);
  data JSONB := jsonb_build_object(
    'id', NEW.id, 'status', NEW.status, 'started_on', NEW.started_on, 'created_at', NEW.created_at,
    'lead_id', NEW.lead_id, 'contact_id', row_data->'contact_id', 'campaign', row_data->'campaign');
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM integrations.safe_enqueue(NEW.tenant_id, 'chat.started', data);
  END IF;
  IF NEW.wants_person AND (TG_OP = 'INSERT' OR NOT OLD.wants_person) THEN
    PERFORM integrations.safe_enqueue(NEW.tenant_id, 'chat.handed_over',
      data || jsonb_build_object('assigned_to', NEW.assigned_to, 'handed_over_at', now()));
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS zz_webhooks ON chat.conversations;
CREATE TRIGGER zz_webhooks AFTER INSERT ON chat.conversations
  FOR EACH ROW EXECUTE FUNCTION integrations.on_chat();
DROP TRIGGER IF EXISTS zz_webhooks_handover ON chat.conversations;
CREATE TRIGGER zz_webhooks_handover AFTER UPDATE ON chat.conversations
  FOR EACH ROW WHEN (NEW.wants_person AND NOT OLD.wants_person)
  EXECUTE FUNCTION integrations.on_chat();

-- Social posts: the post's title, campaign and where it went, never the post text
CREATE OR REPLACE FUNCTION integrations.on_social_post()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM integrations.safe_enqueue(NEW.tenant_id, 'social.posted', jsonb_build_object(
    'id', NEW.id, 'title', NEW.title, 'campaign', NEW.campaign, 'tags', NEW.tags, 'link_url', NEW.link_url,
    'scheduled_at', NEW.scheduled_at, 'posted_at', NEW.posted_at,
    'targets', coalesce((
      SELECT jsonb_agg(jsonb_build_object('platform', t.platform, 'account_id', t.account_id,
        'posted_at', t.posted_at, 'post_url', t.post_url) ORDER BY t.platform)
      FROM social.post_targets t WHERE t.post_id = NEW.id), '[]'::jsonb)));
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS zz_webhooks ON social.posts;
CREATE TRIGGER zz_webhooks AFTER INSERT ON social.posts
  FOR EACH ROW WHEN (NEW.status = 'posted')
  EXECUTE FUNCTION integrations.on_social_post();
DROP TRIGGER IF EXISTS zz_webhooks_posted ON social.posts;
CREATE TRIGGER zz_webhooks_posted AFTER UPDATE ON social.posts
  FOR EACH ROW WHEN (NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted')
  EXECUTE FUNCTION integrations.on_social_post();

-- Trigger functions are never called directly
REVOKE EXECUTE ON FUNCTION integrations.on_booking() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION integrations.on_chat() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION integrations.on_social_post() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION integrations.save_webhook(uuid, uuid, text, text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION integrations.save_webhook(uuid, uuid, text, text, text[]) TO authenticated;
