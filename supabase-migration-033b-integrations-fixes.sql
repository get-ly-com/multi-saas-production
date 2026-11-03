-- Integrations fixes found in testing.
-- 1. An invoice becomes paid when a payment is recorded: the payment updates amount_paid and the
--    invoice's own trigger sets the status. A trigger limited to "UPDATE OF status" never sees that,
--    so the event triggers now watch every update and use WHEN to pick the change they need.
-- 2. When a webhook is turned off after too many failures, the delivery that tipped it over keeps
--    its real error instead of "Not sent".

DROP TRIGGER zz_webhooks ON accounting.invoices;
CREATE TRIGGER zz_webhooks AFTER INSERT ON accounting.invoices
  FOR EACH ROW EXECUTE FUNCTION integrations.on_invoice();
CREATE TRIGGER zz_webhooks_paid AFTER UPDATE ON accounting.invoices
  FOR EACH ROW WHEN (NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid')
  EXECUTE FUNCTION integrations.on_invoice();

DROP TRIGGER zz_webhooks ON crm.deals;
CREATE TRIGGER zz_webhooks AFTER INSERT ON crm.deals
  FOR EACH ROW EXECUTE FUNCTION integrations.on_deal();
CREATE TRIGGER zz_webhooks_stage AFTER UPDATE ON crm.deals
  FOR EACH ROW WHEN (NEW.stage_id IS DISTINCT FROM OLD.stage_id)
  EXECUTE FUNCTION integrations.on_deal();

DROP TRIGGER zz_webhooks ON hr.leave_requests;
CREATE TRIGGER zz_webhooks AFTER INSERT ON hr.leave_requests
  FOR EACH ROW WHEN (NEW.status = 'approved')
  EXECUTE FUNCTION integrations.on_leave();
CREATE TRIGGER zz_webhooks_status AFTER UPDATE ON hr.leave_requests
  FOR EACH ROW WHEN (NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved')
  EXECUTE FUNCTION integrations.on_leave();

DROP TRIGGER zz_webhooks ON hr.pay_runs;
CREATE TRIGGER zz_webhooks AFTER UPDATE ON hr.pay_runs
  FOR EACH ROW WHEN (NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved')
  EXECUTE FUNCTION integrations.on_pay_run();

CREATE OR REPLACE FUNCTION integrations.finish(p_delivery UUID, p_ok BOOLEAN, p_code INT, p_error TEXT, p_ms INT)
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
    UPDATE integrations.deliveries SET status = 'failed', finished_at = now(),
      error = CASE WHEN id = p_delivery THEN error ELSE 'Not sent: the webhook was turned off' END
      WHERE webhook_id = hook.id AND status = 'pending';
    PERFORM integrations.alert_managers(hook.tenant_id, 'A webhook was turned off',
      format('"%s" failed %s times in a row, so it was turned off. Check the address and turn it back on in Integrations.', hook.name, limit_off),
      'webhook-off:' || hook.id || ':' || to_char(now(), 'YYYY-MM-DD HH24:MI'));
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION integrations.finish(uuid, boolean, integer, text, integer) FROM PUBLIC, anon, authenticated;
