-- Integrations: outgoing webhooks, read-only public API keys and background jobs.
-- Everything runs inside the database. Events come from triggers, sit in a queue table and
-- are sent by pg_net from a pg_cron job every minute, with retries. Webhook signing secrets are
-- kept encrypted in Supabase Vault (they are needed to sign each delivery); API keys are kept
-- only as a sha256 hash. Only owners and admins can see or change any of it.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE SCHEMA IF NOT EXISTS integrations;
-- anon needs the schema only for the public API functions, which check the key themselves
GRANT USAGE ON SCHEMA integrations TO authenticated, anon, service_role;

-- Settings in one place
CREATE FUNCTION integrations.limits()
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
    'log_days', 30
  );
$$;

-- Checks a webhook address. Returns null when it is fine, otherwise what is wrong.
-- Only https on the normal port to a public domain name: no IP addresses, no localhost,
-- no private or internal names. (A public name that points at a private address can't be
-- caught here; pg_net runs outside the company network, so that only reaches Supabase's side.)
CREATE FUNCTION integrations.url_problem(p_url TEXT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
  parts TEXT[];
  host TEXT;
BEGIN
  IF p_url IS NULL OR length(p_url) = 0 OR length(p_url) > 500 THEN
    RETURN 'Enter a web address of up to 500 characters';
  END IF;
  IF p_url ~ '[[:space:][:cntrl:]\\]' THEN
    RETURN 'The web address can''t contain spaces';
  END IF;
  parts := regexp_match(p_url, '^https://([^/?#]*)(.*)$', 'i');
  IF parts IS NULL THEN
    RETURN 'The web address must start with https://';
  END IF;
  host := lower(parts[1]);
  IF host LIKE '%@%' THEN
    RETURN 'The web address can''t contain a user name or password';
  END IF;
  IF host LIKE '%:%' OR host LIKE '%[%' THEN
    RETURN 'Use a domain name on the standard https port, with no :port or IP address';
  END IF;
  host := rtrim(host, '.');
  IF host !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$' THEN
    RETURN 'Use a full public domain name, like hooks.example.com, not an IP address';
  END IF;
  IF host = 'localhost'
    OR host ~ '\.(localhost|local|localdomain|internal|intranet|lan|home|corp|private|test|example|invalid|arpa|onion)$'
    OR host ~ '(^|\.)(nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me|vcap\.me)$'
    OR host ~ '\.railway\.internal$' THEN
    RETURN 'That address is on a private network. Use a public https address.';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TABLE integrations.webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  url TEXT NOT NULL CHECK (integrations.url_problem(url) IS NULL),
  events TEXT[] NOT NULL CHECK (cardinality(events) BETWEEN 1 AND 20 AND events <@ ARRAY[
    'invoice.created', 'invoice.paid', 'contact.created', 'lead.created',
    'deal.won', 'deal.lost', 'leave.approved', 'payrun.approved']),
  -- The signing secret lives in vault.secrets; only the last 4 characters are kept here to show
  secret_id UUID NOT NULL,
  secret_hint TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  failures_in_row INT NOT NULL DEFAULT 0,
  disabled_at TIMESTAMP,
  disabled_reason TEXT,
  last_success_at TIMESTAMP,
  last_failure_at TIMESTAMP,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_integrations_webhooks_tenant ON integrations.webhooks (tenant_id) WHERE enabled;

-- One row for each event sent to each webhook. It keeps the last attempt's result.
CREATE TABLE integrations.deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  webhook_id UUID NOT NULL REFERENCES integrations.webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'delivered', 'failed')),
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 5),
  next_attempt_at TIMESTAMP NOT NULL DEFAULT now(),
  request_id BIGINT,
  sent_at TIMESTAMP,
  status_code INT,
  duration_ms INT,
  error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  finished_at TIMESTAMP
);
CREATE INDEX idx_integrations_deliveries_queue ON integrations.deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX idx_integrations_deliveries_sending ON integrations.deliveries (request_id) WHERE status = 'sending';
CREATE INDEX idx_integrations_deliveries_webhook ON integrations.deliveries (webhook_id, created_at DESC);
CREATE INDEX idx_integrations_deliveries_tenant ON integrations.deliveries (tenant_id, created_at);

CREATE TABLE integrations.api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  last_used_at TIMESTAMP,
  revoked_at TIMESTAMP,
  window_start TIMESTAMP,
  window_count INT NOT NULL DEFAULT 0
);
CREATE INDEX idx_integrations_api_keys_tenant ON integrations.api_keys (tenant_id);

ALTER TABLE integrations.webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations.deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations.api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY manager_rows ON integrations.webhooks FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT m.tenant_id FROM public.tenant_members m WHERE m.user_id = (SELECT auth.uid()) AND m.role IN ('owner', 'admin')));
CREATE POLICY manager_rows ON integrations.deliveries FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT m.tenant_id FROM public.tenant_members m WHERE m.user_id = (SELECT auth.uid()) AND m.role IN ('owner', 'admin')));
CREATE POLICY manager_rows ON integrations.api_keys FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT m.tenant_id FROM public.tenant_members m WHERE m.user_id = (SELECT auth.uid()) AND m.role IN ('owner', 'admin')));

-- Reads only; every change goes through the functions below. The key hash is never readable.
GRANT SELECT ON integrations.webhooks, integrations.deliveries TO authenticated;
GRANT SELECT (id, tenant_id, name, prefix, created_by, created_at, last_used_at, revoked_at) ON integrations.api_keys TO authenticated;

-- A deleted webhook (or company) takes its secret with it
CREATE FUNCTION integrations.drop_secret()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  DELETE FROM vault.secrets WHERE id = OLD.secret_id;
  RETURN OLD;
END;
$$;
CREATE TRIGGER drop_secret AFTER DELETE ON integrations.webhooks
  FOR EACH ROW EXECUTE FUNCTION integrations.drop_secret();

-- Bell alerts for the people who manage integrations
CREATE FUNCTION integrations.alert_managers(p_tenant UUID, p_title TEXT, p_body TEXT, p_dedupe TEXT)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO crm.notifications (tenant_id, user_id, title, body, link, dedupe_key)
  SELECT p_tenant, m.user_id, p_title, p_body, '/saas/integrations', p_dedupe
  FROM public.tenant_members m
  WHERE m.tenant_id = p_tenant AND m.role IN ('owner', 'admin')
  ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
$$;

-- Puts an event in the queue for each webhook that wants it. Called from triggers.
CREATE FUNCTION integrations.enqueue(p_tenant UUID, p_event TEXT, p_data JSONB, p_webhook UUID DEFAULT NULL)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  used INT;
  cap INT := (integrations.limits()->>'deliveries_per_day')::int;
  added INT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM integrations.webhooks w
    WHERE w.tenant_id = p_tenant AND w.enabled
      AND (CASE WHEN p_webhook IS NULL THEN p_event = ANY (w.events) ELSE w.id = p_webhook END)
  ) THEN
    RETURN 0;
  END IF;

  SELECT count(*) INTO used FROM integrations.deliveries d
    WHERE d.tenant_id = p_tenant AND d.created_at >= date_trunc('day', now());
  IF used >= cap THEN
    PERFORM integrations.alert_managers(p_tenant, 'Webhook limit reached for today',
      format('This company sent %s webhook events today, the most allowed. New events are skipped until tomorrow (UTC).', cap),
      'webhook-cap:' || to_char(now(), 'YYYY-MM-DD'));
    RETURN 0;
  END IF;

  INSERT INTO integrations.deliveries (id, tenant_id, webhook_id, event, payload, max_attempts)
  SELECT g.id, p_tenant, g.webhook_id, p_event,
    jsonb_build_object('id', g.id, 'event', p_event, 'company_id', p_tenant,
      'created_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'data', p_data),
    CASE WHEN p_event = 'test' THEN 1 ELSE (integrations.limits()->>'attempts')::int END
  FROM (
    SELECT gen_random_uuid() AS id, w.id AS webhook_id
    FROM integrations.webhooks w
    WHERE w.tenant_id = p_tenant AND w.enabled
      AND (CASE WHEN p_webhook IS NULL THEN p_event = ANY (w.events) ELSE w.id = p_webhook END)
    LIMIT greatest(cap - used, 0)
  ) g;
  GET DIAGNOSTICS added = ROW_COUNT;
  RETURN added;
END;
$$;

-- Records the result of one attempt: done, try again later, or give up.
-- Too many failures in a row turn the webhook off and tell owners and admins.
CREATE FUNCTION integrations.finish(p_delivery UUID, p_ok BOOLEAN, p_code INT, p_error TEXT, p_ms INT)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d integrations.deliveries;
  hook integrations.webhooks;
  backoff INTERVAL[] := ARRAY[interval '1 minute', interval '5 minutes', interval '30 minutes', interval '2 hours'];
  limit_off INT := (integrations.limits()->>'failures_before_off')::int;
BEGIN
  SELECT * INTO d FROM integrations.deliveries WHERE id = p_delivery;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF p_ok THEN
    UPDATE integrations.deliveries SET status = 'delivered', status_code = p_code, error = NULL,
      duration_ms = p_ms, finished_at = now()
      WHERE id = p_delivery;
    UPDATE integrations.webhooks SET failures_in_row = 0, last_success_at = now() WHERE id = d.webhook_id;
    RETURN;
  END IF;

  UPDATE integrations.deliveries SET
    status = CASE WHEN d.attempts >= d.max_attempts THEN 'failed' ELSE 'pending' END,
    next_attempt_at = now() + backoff[least(greatest(d.attempts, 1), 4)],
    finished_at = CASE WHEN d.attempts >= d.max_attempts THEN now() END,
    status_code = p_code, error = left(p_error, 300), duration_ms = p_ms
    WHERE id = p_delivery;

  UPDATE integrations.webhooks SET failures_in_row = failures_in_row + 1, last_failure_at = now()
    WHERE id = d.webhook_id
    RETURNING * INTO hook;

  IF hook.enabled AND hook.failures_in_row >= limit_off THEN
    UPDATE integrations.webhooks SET enabled = false, disabled_at = now(), updated_at = now(),
      disabled_reason = format('Turned off after %s failed deliveries in a row', limit_off)
      WHERE id = hook.id;
    UPDATE integrations.deliveries SET status = 'failed', finished_at = now(), error = 'Not sent: the webhook was turned off'
      WHERE webhook_id = hook.id AND status = 'pending';
    PERFORM integrations.alert_managers(hook.tenant_id, 'A webhook was turned off',
      format('"%s" failed %s times in a row, so it was turned off. Check the address and turn it back on in Integrations.', hook.name, limit_off),
      'webhook-off:' || hook.id || ':' || to_char(now(), 'YYYY-MM-DD HH24:MI'));
  END IF;
END;
$$;

-- Sends one queued delivery with pg_net. The request goes out when this transaction commits.
-- Signature: hex HMAC-SHA256 of "<timestamp>.<raw body>" with the webhook's secret.
CREATE FUNCTION integrations.dispatch(p_delivery UUID)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d RECORD;
  signing_secret TEXT;
  stamp TEXT := extract(epoch FROM now())::bigint::text;
  body TEXT;
  request BIGINT;
BEGIN
  SELECT x.id, x.event, x.payload, x.status, w.url, w.secret_id, w.enabled INTO d
    FROM integrations.deliveries x JOIN integrations.webhooks w ON w.id = x.webhook_id
    WHERE x.id = p_delivery
    FOR UPDATE OF x;
  IF NOT FOUND OR d.status <> 'pending' OR NOT d.enabled THEN
    RETURN;
  END IF;

  SELECT s.decrypted_secret INTO signing_secret FROM vault.decrypted_secrets s WHERE s.id = d.secret_id;
  IF signing_secret IS NULL THEN
    RAISE EXCEPTION 'The signing secret is missing. Make a new secret for this webhook.';
  END IF;

  -- pg_net sends the jsonb as its text form, so the signature is over exactly these bytes
  body := d.payload::text;
  request := net.http_post(
    url := d.url,
    body := d.payload,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'User-Agent', 'Getly-Webhooks/1.0',
      'X-Webhook-Id', d.id::text,
      'X-Webhook-Event', d.event,
      'X-Webhook-Timestamp', stamp,
      'X-Webhook-Signature', 'sha256=' || encode(extensions.hmac(stamp || '.' || body, signing_secret, 'sha256'), 'hex')
    ),
    timeout_milliseconds := 5000
  );

  UPDATE integrations.deliveries SET status = 'sending', request_id = request, sent_at = now(),
    attempts = attempts + 1
    WHERE id = p_delivery;
END;
$$;

-- Reads pg_net's answers for deliveries that were sent. Null means every company.
CREATE FUNCTION integrations.collect(p_tenant UUID)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r RECORD;
  handled INT := 0;
  ok BOOLEAN;
BEGIN
  FOR r IN
    SELECT x.id, x.sent_at, h.id AS response_id, h.status_code, h.error_msg, h.timed_out, h.created
    FROM integrations.deliveries x
    LEFT JOIN net._http_response h ON h.id = x.request_id
    WHERE x.status = 'sending' AND (p_tenant IS NULL OR x.tenant_id = p_tenant)
    ORDER BY x.sent_at
    LIMIT 1000
    FOR UPDATE OF x SKIP LOCKED
  LOOP
    IF r.response_id IS NOT NULL THEN
      ok := r.status_code BETWEEN 200 AND 299;
      PERFORM integrations.finish(r.id, ok, r.status_code,
        CASE
          WHEN ok THEN NULL
          WHEN r.timed_out THEN 'No answer within 5 seconds'
          WHEN r.error_msg IS NOT NULL THEN r.error_msg
          ELSE format('The server answered %s', r.status_code)
        END,
        greatest(0, (extract(epoch FROM (r.created AT TIME ZONE 'UTC') - r.sent_at) * 1000)::int));
      handled := handled + 1;
    ELSIF r.sent_at < now() - interval '10 minutes' THEN
      PERFORM integrations.finish(r.id, false, NULL, 'No answer received', NULL);
      handled := handled + 1;
    END IF;
  END LOOP;
  RETURN handled;
END;
$$;

-- pg_cron, every minute: read answers, then send what is due. Up to 50 per company and 200 in all
-- each minute, so one busy company can't hold up the others.
CREATE FUNCTION integrations.process_queue()
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  collected INT := 0;
  sent INT := 0;
  item UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM integrations.deliveries WHERE status IN ('pending', 'sending')) THEN
    RETURN json_build_object('collected', 0, 'sent', 0);
  END IF;

  collected := integrations.collect(NULL);

  FOR item IN
    SELECT q.id FROM (
      SELECT x.id, x.next_attempt_at,
        row_number() OVER (PARTITION BY x.tenant_id ORDER BY x.next_attempt_at) AS place
      FROM integrations.deliveries x
      JOIN integrations.webhooks w ON w.id = x.webhook_id AND w.enabled
      WHERE x.status = 'pending' AND x.next_attempt_at <= now()
    ) q
    WHERE q.place <= 50
    ORDER BY q.next_attempt_at
    LIMIT 200
  LOOP
    BEGIN
      PERFORM integrations.dispatch(item);
      sent := sent + 1;
    EXCEPTION WHEN others THEN
      UPDATE integrations.deliveries SET attempts = attempts + 1 WHERE id = item;
      PERFORM integrations.finish(item, false, NULL, 'Could not send: ' || SQLERRM, NULL);
    END;
  END LOOP;

  RETURN json_build_object('collected', collected, 'sent', sent);
END;
$$;

-- pg_cron, daily: drop old delivery logs and old cron run history (a job every minute adds 1,440 rows a day)
CREATE FUNCTION integrations.cleanup()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  DELETE FROM integrations.deliveries
    WHERE created_at < now() - make_interval(days => (integrations.limits()->>'log_days')::int)
      AND status IN ('delivered', 'failed');
  DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days';
END;
$$;

-- Event triggers. A webhook problem must never stop the save itself.
CREATE FUNCTION integrations.safe_enqueue(p_tenant UUID, p_event TEXT, p_data JSONB)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM integrations.enqueue(p_tenant, p_event, p_data);
EXCEPTION WHEN others THEN
  RAISE WARNING 'Webhook event % for % was not queued: %', p_event, p_tenant, SQLERRM;
END;
$$;

CREATE FUNCTION integrations.on_invoice()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  data JSONB := jsonb_build_object('id', NEW.id, 'invoice_number', NEW.invoice_number, 'status', NEW.status,
    'customer_id', NEW.customer_id, 'amount', NEW.amount, 'currency', NEW.currency, 'invoice_date', NEW.invoice_date,
    'due_date', NEW.due_date);
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM integrations.safe_enqueue(NEW.tenant_id, 'invoice.created', data);
  END IF;
  IF NEW.status = 'paid' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'paid') THEN
    PERFORM integrations.safe_enqueue(NEW.tenant_id, 'invoice.paid',
      data || jsonb_build_object('amount_paid', NEW.amount_paid, 'paid_at', NEW.paid_at));
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER zz_webhooks AFTER INSERT OR UPDATE OF status ON accounting.invoices
  FOR EACH ROW EXECUTE FUNCTION integrations.on_invoice();

CREATE FUNCTION integrations.on_contact()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM integrations.safe_enqueue(NEW.tenant_id, 'contact.created', jsonb_build_object(
    'id', NEW.id, 'name', NEW.name, 'email', NEW.email, 'company_id', NEW.company_id, 'source', NEW.source));
  RETURN NULL;
END;
$$;
CREATE TRIGGER zz_webhooks AFTER INSERT ON crm.contacts
  FOR EACH ROW EXECUTE FUNCTION integrations.on_contact();

CREATE FUNCTION integrations.on_lead()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM integrations.safe_enqueue(NEW.tenant_id, 'lead.created', jsonb_build_object(
    'id', NEW.id, 'name', NEW.name, 'email', NEW.email, 'company_name', NEW.company_name,
    'source', NEW.source, 'status', NEW.status, 'from_form', NEW.from_form));
  RETURN NULL;
END;
$$;
CREATE TRIGGER zz_webhooks AFTER INSERT ON crm.leads
  FOR EACH ROW EXECUTE FUNCTION integrations.on_lead();

CREATE FUNCTION integrations.on_deal()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  new_stage RECORD;
  old_kind TEXT;
BEGIN
  SELECT s.name, s.kind INTO new_stage FROM crm.stages s WHERE s.id = NEW.stage_id;
  IF new_stage.kind IS NULL OR new_stage.kind NOT IN ('won', 'lost') THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT s.kind INTO old_kind FROM crm.stages s WHERE s.id = OLD.stage_id;
    IF old_kind IS NOT DISTINCT FROM new_stage.kind THEN
      RETURN NULL;
    END IF;
  END IF;
  PERFORM integrations.safe_enqueue(NEW.tenant_id, 'deal.' || new_stage.kind, jsonb_build_object(
    'id', NEW.id, 'title', NEW.title, 'value', NEW.value, 'stage_id', NEW.stage_id, 'stage', new_stage.name,
    'contact_id', NEW.contact_id, 'company_id', NEW.company_id, 'closed_at', NEW.closed_at)
    || CASE WHEN new_stage.kind = 'lost' THEN jsonb_build_object('lost_reason', NEW.lost_reason) ELSE '{}'::jsonb END);
  RETURN NULL;
END;
$$;
CREATE TRIGGER zz_webhooks AFTER INSERT OR UPDATE OF stage_id ON crm.deals
  FOR EACH ROW EXECUTE FUNCTION integrations.on_deal();

-- Leave: ids and dates only, never the reason or note
CREATE FUNCTION integrations.on_leave()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'approved' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'approved') THEN
    PERFORM integrations.safe_enqueue(NEW.tenant_id, 'leave.approved', jsonb_build_object(
      'id', NEW.id, 'employee_id', NEW.employee_id, 'leave_type_id', NEW.leave_type_id,
      'start_date', NEW.start_date, 'end_date', NEW.end_date, 'half_day', NEW.half_day, 'days', NEW.days));
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER zz_webhooks AFTER INSERT OR UPDATE OF status ON hr.leave_requests
  FOR EACH ROW EXECUTE FUNCTION integrations.on_leave();

-- Pay runs: the run's ids, dates and totals only, never anyone's own pay
CREATE FUNCTION integrations.on_pay_run()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' THEN
    PERFORM integrations.safe_enqueue(NEW.tenant_id, 'payrun.approved', jsonb_build_object(
      'id', NEW.id, 'run_number', NEW.run_number, 'period_start', NEW.period_start, 'period_end', NEW.period_end,
      'pay_date', NEW.pay_date, 'gross', NEW.gross, 'deductions', NEW.deductions, 'net', NEW.net,
      'employer_costs', NEW.employer_costs));
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER zz_webhooks AFTER UPDATE OF status ON hr.pay_runs
  FOR EACH ROW EXECUTE FUNCTION integrations.on_pay_run();

-- Background job status, for owners and admins
CREATE FUNCTION integrations.job_status()
RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce(json_agg(r ORDER BY r.name), '[]'::json) FROM (
    SELECT j.jobname AS name, j.schedule, j.active,
      CASE j.jobname
        WHEN 'integrations-webhooks' THEN 'Sends queued webhook events and retries failed ones'
        WHEN 'integrations-cleanup' THEN 'Deletes webhook logs older than 30 days and old job history'
        WHEN 'crm-automations' THEN 'Runs time-based CRM rules and task reminders, and deletes alerts older than 90 days'
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
    WHERE j.jobname IN ('integrations-webhooks', 'integrations-cleanup', 'crm-automations')
  ) r;
$$;

-- What the Integrations page shows. Members who aren't owners or admins only learn that.
CREATE FUNCTION integrations.overview(p_tenant UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
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
        SELECT k.id, k.name, k.prefix, k.created_at, k.last_used_at, k.revoked_at, u.email AS created_by
        FROM integrations.api_keys k LEFT JOIN auth.users u ON u.id = k.created_by
        WHERE k.tenant_id = p_tenant
      ) r
    ),
    'jobs', integrations.job_status()
  );
END;
$$;

CREATE FUNCTION integrations.save_webhook(p_tenant UUID, p_webhook UUID, p_name TEXT, p_url TEXT, p_events TEXT[])
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
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
      'deal.won', 'deal.lost', 'leave.approved', 'payrun.approved'] THEN
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
$$;

CREATE FUNCTION integrations.roll_webhook_secret(p_tenant UUID, p_webhook UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  hook integrations.webhooks;
  signing_secret TEXT := 'whsec_' || encode(extensions.gen_random_bytes(24), 'hex');
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  SELECT * INTO hook FROM integrations.webhooks WHERE id = p_webhook AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Webhook not found';
  END IF;
  DELETE FROM vault.secrets WHERE id = hook.secret_id;
  UPDATE integrations.webhooks SET
    secret_id = vault.create_secret(signing_secret, 'integrations_webhook_' || hook.id || '_' || extract(epoch FROM clock_timestamp())::bigint, 'Webhook signing secret'),
    secret_hint = right(signing_secret, 4), updated_at = now()
    WHERE id = hook.id;
  RETURN json_build_object('id', hook.id, 'secret', signing_secret);
END;
$$;

CREATE FUNCTION integrations.set_webhook_enabled(p_tenant UUID, p_webhook UUID, p_enabled BOOLEAN)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  UPDATE integrations.webhooks SET enabled = coalesce(p_enabled, false), updated_at = now(),
    failures_in_row = CASE WHEN p_enabled THEN 0 ELSE failures_in_row END,
    disabled_at = CASE WHEN p_enabled THEN NULL ELSE now() END,
    disabled_reason = CASE WHEN p_enabled THEN NULL ELSE 'Turned off by ' || coalesce((SELECT u.email FROM auth.users u WHERE u.id = auth.uid()), 'a team member') END
    WHERE id = p_webhook AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Webhook not found';
  END IF;
  IF NOT coalesce(p_enabled, false) THEN
    UPDATE integrations.deliveries SET status = 'failed', finished_at = now(), error = 'Not sent: the webhook was turned off'
      WHERE webhook_id = p_webhook AND status = 'pending';
  END IF;
END;
$$;

CREATE FUNCTION integrations.delete_webhook(p_tenant UUID, p_webhook UUID)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  DELETE FROM integrations.webhooks WHERE id = p_webhook AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Webhook not found';
  END IF;
END;
$$;

-- Sends a small test event straight away (one attempt, no retries)
CREATE FUNCTION integrations.send_test(p_tenant UUID, p_webhook UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  item UUID;
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  IF NOT EXISTS (SELECT 1 FROM integrations.webhooks w WHERE w.id = p_webhook AND w.tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'Webhook not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM integrations.webhooks w WHERE w.id = p_webhook AND w.enabled) THEN
    RAISE EXCEPTION 'Turn the webhook on first';
  END IF;
  IF EXISTS (SELECT 1 FROM integrations.deliveries d WHERE d.webhook_id = p_webhook AND d.event = 'test'
      AND d.created_at > now() - interval '10 seconds') THEN
    RAISE EXCEPTION 'A test was just sent. Wait a few seconds and try again.';
  END IF;

  IF integrations.enqueue(p_tenant, 'test', jsonb_build_object('message', 'This is a test event.'), p_webhook) = 0 THEN
    RAISE EXCEPTION 'The daily limit of webhook events has been reached';
  END IF;
  SELECT d.id INTO item FROM integrations.deliveries d
    WHERE d.webhook_id = p_webhook AND d.event = 'test' ORDER BY d.created_at DESC LIMIT 1;
  PERFORM integrations.dispatch(item);
  RETURN json_build_object('id', item);
END;
$$;

-- The delivery log. It picks up any answers that came back since the last minute's run.
CREATE FUNCTION integrations.webhook_log(p_tenant UUID, p_webhook UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  IF NOT EXISTS (SELECT 1 FROM integrations.webhooks w WHERE w.id = p_webhook AND w.tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'Webhook not found';
  END IF;
  PERFORM integrations.collect(p_tenant);
  RETURN (
    SELECT coalesce(json_agg(r ORDER BY r.created_at DESC), '[]'::json) FROM (
      SELECT d.id, d.event, d.status, d.attempts, d.max_attempts, d.status_code, d.duration_ms, d.error,
        d.created_at, d.sent_at, d.finished_at,
        CASE WHEN d.status = 'pending' THEN d.next_attempt_at END AS next_attempt_at, d.payload
      FROM integrations.deliveries d
      WHERE d.webhook_id = p_webhook
      ORDER BY d.created_at DESC LIMIT 50
    ) r
  );
END;
$$;

CREATE FUNCTION integrations.retry_delivery(p_tenant UUID, p_delivery UUID)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  UPDATE integrations.deliveries d SET status = 'pending', attempts = 0, max_attempts = 1,
    next_attempt_at = now(), finished_at = NULL
    WHERE d.id = p_delivery AND d.tenant_id = p_tenant AND d.status = 'failed' AND d.event <> 'test'
      AND EXISTS (SELECT 1 FROM integrations.webhooks w WHERE w.id = d.webhook_id AND w.enabled);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only failed events on a webhook that is on can be sent again';
  END IF;
END;
$$;

-- API keys. The full key is shown once; only its sha256 hash is kept.
CREATE FUNCTION integrations.create_api_key(p_tenant UUID, p_name TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  new_key TEXT := 'gk_' || encode(extensions.gen_random_bytes(24), 'hex');
  new_id UUID;
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  IF length(trim(coalesce(p_name, ''))) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'Enter a name of up to 80 characters';
  END IF;
  IF (SELECT count(*) FROM integrations.api_keys k WHERE k.tenant_id = p_tenant AND k.revoked_at IS NULL)
      >= (integrations.limits()->>'api_keys_per_company')::int THEN
    RAISE EXCEPTION 'A company can have up to % active API keys', integrations.limits()->>'api_keys_per_company';
  END IF;
  INSERT INTO integrations.api_keys (tenant_id, name, prefix, key_hash, created_by)
    VALUES (p_tenant, trim(p_name), left(new_key, 11), encode(extensions.digest(new_key, 'sha256'), 'hex'), auth.uid())
    RETURNING id INTO new_id;
  RETURN json_build_object('id', new_id, 'key', new_key, 'prefix', left(new_key, 11));
END;
$$;

CREATE FUNCTION integrations.revoke_api_key(p_tenant UUID, p_key UUID)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM accounting.require_manager(p_tenant);
  UPDATE integrations.api_keys SET revoked_at = now() WHERE id = p_key AND tenant_id = p_tenant AND revoked_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'API key not found';
  END IF;
END;
$$;

-- Public API. The key decides the company. A key stops working when it is revoked, or when the
-- person who made it is no longer an owner or admin. Errors use PostgREST's PTxxx codes so the
-- HTTP status is right: 401 bad key, 404 not found, 429 too many requests.
CREATE FUNCTION integrations.key_tenant(p_key TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  found_key RECORD;
BEGIN
  IF p_key IS NULL OR p_key !~ '^gk_[0-9a-f]{48}$' THEN
    RAISE EXCEPTION 'Invalid API key' USING ERRCODE = 'PT401';
  END IF;
  UPDATE integrations.api_keys k SET
    last_used_at = now(),
    window_start = CASE WHEN k.window_start IS NULL OR k.window_start < now() - interval '1 minute' THEN now() ELSE k.window_start END,
    window_count = CASE WHEN k.window_start IS NULL OR k.window_start < now() - interval '1 minute' THEN 1 ELSE k.window_count + 1 END
  WHERE k.key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex')
    AND k.revoked_at IS NULL
    AND EXISTS (SELECT 1 FROM public.tenant_members m WHERE m.tenant_id = k.tenant_id AND m.user_id = k.created_by AND m.role IN ('owner', 'admin'))
    AND EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = k.tenant_id AND t.is_active IS NOT FALSE)
  RETURNING k.tenant_id, k.window_count INTO found_key;
  IF found_key.tenant_id IS NULL THEN
    RAISE EXCEPTION 'Invalid API key' USING ERRCODE = 'PT401';
  END IF;
  IF found_key.window_count > (integrations.limits()->>'api_requests_per_minute')::int THEN
    RAISE EXCEPTION 'Too many requests. Wait a minute and try again.' USING ERRCODE = 'PT429';
  END IF;
  RETURN found_key.tenant_id;
END;
$$;

-- The fields each resource returns. Sorted oldest first so pages don't shift as rows are added.
CREATE FUNCTION integrations.api_rows(p_tenant UUID, p_resource TEXT, p_id UUID, p_limit INT, p_offset INT)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
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
  ELSE
    RAISE EXCEPTION 'Unknown resource. Use contacts, invoices, items or deals.' USING ERRCODE = 'PT404';
  END IF;
  RETURN result;
END;
$$;

CREATE FUNCTION integrations.api_list(p_key TEXT, p_resource TEXT, p_limit INT DEFAULT 25, p_offset INT DEFAULT 0)
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
  found := integrations.api_rows(company, p_resource, NULL, page_size + 1, start_at);
  more := json_array_length(found) > page_size;
  IF more THEN
    SELECT json_agg(e) INTO found FROM (SELECT e FROM json_array_elements(found) WITH ORDINALITY AS x(e, n) WHERE n <= page_size ORDER BY n) y;
  END IF;
  RETURN json_build_object('object', 'list', 'resource', p_resource, 'data', found,
    'limit', page_size, 'offset', start_at, 'has_more', more,
    'next_offset', CASE WHEN more THEN start_at + page_size END);
END;
$$;

CREATE FUNCTION integrations.api_get(p_key TEXT, p_resource TEXT, p_id UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  company UUID := integrations.key_tenant(p_key);
  found JSON;
BEGIN
  found := integrations.api_rows(company, p_resource, p_id, 1, 0);
  IF p_id IS NULL OR json_array_length(found) = 0 THEN
    RAISE EXCEPTION 'Not found' USING ERRCODE = 'PT404';
  END IF;
  RETURN found->0;
END;
$$;

DO $$
DECLARE
  fn TEXT;
BEGIN
  -- Used only inside other functions, triggers and pg_cron
  FOREACH fn IN ARRAY ARRAY['integrations.drop_secret()', 'integrations.alert_managers(uuid, text, text, text)',
      'integrations.enqueue(uuid, text, jsonb, uuid)', 'integrations.finish(uuid, boolean, integer, text, integer)',
      'integrations.dispatch(uuid)', 'integrations.collect(uuid)', 'integrations.process_queue()', 'integrations.cleanup()',
      'integrations.safe_enqueue(uuid, text, jsonb)', 'integrations.on_invoice()', 'integrations.on_contact()',
      'integrations.on_lead()', 'integrations.on_deal()', 'integrations.on_leave()', 'integrations.on_pay_run()',
      'integrations.job_status()', 'integrations.key_tenant(text)',
      'integrations.api_rows(uuid, text, uuid, integer, integer)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
  END LOOP;

  -- Signed-in users; each checks the role itself
  FOREACH fn IN ARRAY ARRAY['integrations.limits()', 'integrations.url_problem(text)', 'integrations.overview(uuid)',
      'integrations.save_webhook(uuid, uuid, text, text, text[])', 'integrations.roll_webhook_secret(uuid, uuid)',
      'integrations.set_webhook_enabled(uuid, uuid, boolean)', 'integrations.delete_webhook(uuid, uuid)',
      'integrations.send_test(uuid, uuid)', 'integrations.webhook_log(uuid, uuid)',
      'integrations.retry_delivery(uuid, uuid)', 'integrations.create_api_key(uuid, text)',
      'integrations.revoke_api_key(uuid, uuid)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
  END LOOP;

  -- The public API: no signed-in user, the key is checked inside
  FOREACH fn IN ARRAY ARRAY['integrations.api_list(text, text, integer, integer)', 'integrations.api_get(text, text, uuid)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon, authenticated', fn);
  END LOOP;
END;
$$;

-- Background jobs. Run again safely: each is removed by name before it is added.
-- Old CRM alerts are already deleted every hour by crm.run_scheduled() ('crm-automations').
DO $$
BEGIN
  PERFORM cron.unschedule(j.jobname) FROM cron.job j WHERE j.jobname IN ('integrations-webhooks', 'integrations-cleanup');
  PERFORM cron.schedule('integrations-webhooks', '* * * * *', 'SELECT integrations.process_queue()');
  PERFORM cron.schedule('integrations-cleanup', '17 3 * * *', 'SELECT integrations.cleanup()');
END;
$$;

-- Add this schema to the API, keeping every schema already listed (other products add theirs too)
DO $$
DECLARE
  current_list TEXT;
BEGIN
  SELECT substring(c FROM length('pgrst.db_schemas=') + 1) INTO current_list
    FROM pg_roles r, unnest(r.rolconfig) c
    WHERE r.rolname = 'authenticator' AND c LIKE 'pgrst.db_schemas=%';
  current_list := coalesce(nullif(trim(current_list), ''), 'public, graphql_public');
  IF NOT 'integrations' = ANY (string_to_array(replace(current_list, ' ', ''), ',')) THEN
    EXECUTE format('ALTER ROLE authenticator SET pgrst.db_schemas = %L', current_list || ', integrations');
  END IF;
END;
$$;
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';
