require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3011;

// Queries run as the signed-in user, so database policies apply to them. Every function checks
// that the user is an owner or admin; webhooks are sent by the database itself (pg_net + pg_cron).
const supabaseFor = (authorization) =>
  createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false }
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENTS = ['invoice.created', 'invoice.paid', 'contact.created', 'lead.created', 'deal.won', 'deal.lost', 'leave.approved', 'payrun.approved',
  'booking.created', 'booking.cancelled', 'chat.started', 'chat.handed_over', 'social.posted'];

const id = (value, label) => {
  if (!UUID.test(value || '')) {
    const error = new Error(`${label} not found`);
    error.status = 404;
    throw error;
  }
  return value;
};

const text = (value, max) => (value === null || value === undefined ? '' : String(value).slice(0, max));

const webhookFields = (body) => {
  const events = Array.isArray(body.events) ? body.events.filter((event) => EVENTS.includes(event)) : [];
  if (!events.length) throw new Error('Choose at least one event');
  return {
    p_name: text(body.name, 80).trim(),
    p_url: text(body.url, 500).trim(),
    p_events: [...new Set(events)]
  };
};

// Only our own messages and the ones our database functions raise (P0001) reach people
const sendError = (res, error) => {
  const code = error?.code || '';
  if (error?.status) return res.status(error.status).json({ error: error.message });
  if (!code && error?.constructor === Error) return res.status(400).json({ error: error.message });
  if (code === 'P0001') return res.status(400).json({ error: error.message });
  if (/^PT[45]\d\d$/.test(code)) return res.status(Number(code.slice(2))).json({ error: error.message });

  console.error('Integration error:', error);
  if (code === '42501') return res.status(403).json({ error: 'You don’t have access to that' });
  if (code === '22P02') return res.status(404).json({ error: 'Not found' });
  if (code === '23503') return res.status(409).json({ error: 'That is still in use' });
  if (code === '23505') return res.status(409).json({ error: 'That is already saved' });
  if (code === '23514') return res.status(400).json({ error: 'That value isn’t allowed' });
  res.status(400).json({ error: 'That didn’t work. Please check and try again.' });
};

const call = (name, params, status = 200) => async (req, res) => {
  try {
    const { data, error } = await req.db.schema('integrations').rpc(name, { p_tenant: req.tenantId, ...params(req) });
    if (error) throw error;
    res.status(status).json(data ?? { success: true });
  } catch (error) {
    sendError(res, error);
  }
};

app.use(express.json({ limit: '32kb' }));
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'integration-service' }));

// Only the gateway reaches this service, and it sets the tenant
app.use((req, res, next) => {
  req.tenantId = req.headers['x-tenant-id'];
  if (!UUID.test(req.tenantId || '') || !req.headers.authorization) {
    return res.status(400).json({ error: 'Missing tenant' });
  }
  req.db = supabaseFor(req.headers.authorization);
  next();
});

app.get('/overview', call('overview', () => ({})));

// Webhooks. A new webhook's signing secret comes back once, in the reply to the POST.
app.post('/webhooks', call('save_webhook', (req) => ({ p_webhook: null, ...webhookFields(req.body) }), 201));
app.put('/webhooks/:id', call('save_webhook', (req) => ({ p_webhook: id(req.params.id, 'Webhook'), ...webhookFields(req.body) })));
app.post('/webhooks/:id/enabled', call('set_webhook_enabled', (req) => ({
  p_webhook: id(req.params.id, 'Webhook'),
  p_enabled: Boolean(req.body.enabled)
})));
app.post('/webhooks/:id/secret', call('roll_webhook_secret', (req) => ({ p_webhook: id(req.params.id, 'Webhook') })));
app.post('/webhooks/:id/test', call('send_test', (req) => ({ p_webhook: id(req.params.id, 'Webhook') })));
app.get('/webhooks/:id/deliveries', call('webhook_log', (req) => ({ p_webhook: id(req.params.id, 'Webhook') })));
app.delete('/webhooks/:id', call('delete_webhook', (req) => ({ p_webhook: id(req.params.id, 'Webhook') })));
app.post('/deliveries/:id/retry', call('retry_delivery', (req) => ({ p_delivery: id(req.params.id, 'Delivery') })));

// API keys. The key comes back once, in the reply to the POST; only its hash is kept.
app.delete('/api-keys/:id', call('revoke_api_key', (req) => ({ p_key: id(req.params.id, 'API key') })));

// A key that only reads, or one that can also add contacts and leads
app.post('/api-keys/scoped', call('make_api_key', (req) => ({
  p_name: text(req.body.name, 80).trim(),
  p_scope: req.body.scope === 'write' ? 'write' : 'read'
}), 201));
app.get('/api-keys/:id/requests', call('api_key_log', (req) => ({ p_key: id(req.params.id, 'API key') })));

// Incoming webhooks: secret addresses other tools post leads to. The address comes back once.
app.get('/inbound', call('inbound_overview', () => ({})));
app.post('/inbound', call('save_inbound', (req) => ({
  p_hook: null,
  p_name: text(req.body.name, 80).trim(),
  p_source: text(req.body.source, 100).trim()
}), 201));
app.put('/inbound/:id', call('save_inbound', (req) => ({
  p_hook: id(req.params.id, 'Incoming webhook'),
  p_name: text(req.body.name, 80).trim(),
  p_source: text(req.body.source, 100).trim()
})));
app.post('/inbound/:id/enabled', call('set_inbound_enabled', (req) => ({
  p_hook: id(req.params.id, 'Incoming webhook'),
  p_enabled: Boolean(req.body.enabled)
})));
app.post('/inbound/:id/token', call('roll_inbound_token', (req) => ({ p_hook: id(req.params.id, 'Incoming webhook') })));
app.get('/inbound/:id/log', call('inbound_history', (req) => ({ p_hook: id(req.params.id, 'Incoming webhook') })));
app.delete('/inbound/:id', call('delete_inbound', (req) => ({ p_hook: id(req.params.id, 'Incoming webhook') })));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  // Bad JSON and too-large bodies are the sender's mistake, not ours
  if (err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.status === 413 ? 'That is too large to send' : 'That request could not be read' });
  }
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));

app.listen(PORT, () => console.log(`Integration Service on ${PORT}`));
