require('dotenv').config();
const express = require('express');
const httpProxy = require('express-http-proxy');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3100')
  .split(',')
  .map((origin) => origin.trim());

// Railway terminates TLS in front of the gateway
app.set('trust proxy', 1);

// Middleware
app.use(helmet());
app.use(cors({ origin: allowedOrigins, allowedHeaders: ['Authorization', 'Content-Type', 'X-Company'] }));
app.use(morgan('combined'));
app.use(rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Queries run as the signed-in user, so database policies apply to them
const supabaseFor = (token) =>
  createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false }
  });

const requireUser = async (req, res, next) => {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Sign in required' });
  }

  try {
    const db = supabaseFor(token);
    const { data, error } = await db.auth.getUser(token);
    if (error || !data.user) {
      return res.status(401).json({ error: 'Sign in required' });
    }
    req.user = data.user;
    req.db = db;
    next();
  } catch (error) {
    next(error);
  }
};

const findMemberships = async (req) => {
  const { data, error } = await req.db
    .from('tenant_members')
    .select('role, tenant:tenants(id, name)')
    .eq('user_id', req.user.id)
    .order('created_at');

  if (error) throw error;
  return data || [];
};

// The client may pick a company, but only one of its own memberships. A pick that no longer
// matches is refused, so a write can never land in a different company from the one on screen.
const requireTenant = async (req, res, next) => {
  try {
    const memberships = await findMemberships(req);
    if (memberships.length === 0) {
      return res.status(403).json({ error: 'Create a company first' });
    }
    const chosen = req.headers['x-company'];
    const membership = chosen ? memberships.find(({ tenant }) => tenant.id === chosen) : memberships[0];
    if (!membership) {
      return res.status(403).json({ error: 'You no longer have access to that company' });
    }
    req.tenantId = membership.tenant.id;
    next();
  } catch (error) {
    next(error);
  }
};

// Account
app.get('/api/me', requireUser, async (req, res, next) => {
  try {
    const memberships = await findMemberships(req);
    const membership = memberships.find(({ tenant }) => tenant.id === req.headers['x-company']) || memberships[0];
    res.json({
      user: { id: req.user.id, email: req.user.email },
      tenant: membership ? { ...membership.tenant, role: membership.role } : null,
      tenants: memberships.map(({ tenant, role }) => ({ ...tenant, role }))
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/tenants', requireUser, express.json(), async (req, res) => {
  const { data, error } = await req.db.rpc('create_tenant', { company_name: req.body?.name });
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// Runs a database function as the signed-in user. The function checks their role.
const callFunction = async (req, res, name, params, status = 200) => {
  const { data, error } = await req.db.rpc(name, params);
  if (error) return res.status(400).json({ error: error.message });
  res.status(status).json(data ?? { success: true });
};

// Invites waiting for this person's email address
app.get('/api/invites', requireUser, (req, res) => callFunction(req, res, 'my_invites', {}));

app.post('/api/invites/:id/accept', requireUser, (req, res) =>
  callFunction(req, res, 'accept_invite', { p_invite: req.params.id }));

// Team
app.get('/api/team', requireUser, requireTenant, (req, res) =>
  callFunction(req, res, 'team_overview', { p_tenant: req.tenantId }));

app.post('/api/team/invites', requireUser, requireTenant, express.json(), (req, res) =>
  callFunction(req, res, 'invite_member', {
    p_tenant: req.tenantId,
    p_email: req.body?.email,
    p_role: req.body?.role
  }, 201));

app.delete('/api/team/invites/:id', requireUser, requireTenant, (req, res) =>
  callFunction(req, res, 'revoke_invite', { p_tenant: req.tenantId, p_invite: req.params.id }));

app.put('/api/team/members/:id', requireUser, requireTenant, express.json(), (req, res) =>
  callFunction(req, res, 'set_member_role', {
    p_tenant: req.tenantId,
    p_user: req.params.id,
    p_role: req.body?.role
  }));

app.delete('/api/team/members/:id', requireUser, requireTenant, (req, res) =>
  callFunction(req, res, 'remove_member', { p_tenant: req.tenantId, p_user: req.params.id }));

// Public web forms. There is no signed-in user, so each company is found by its private form key.
const formLimit = rateLimit({ windowMs: 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });

const publicDb = () =>
  createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

app.get('/api/forms/:key', async (req, res) => {
  const { data, error } = await publicDb().rpc('form_info', { p_key: req.params.key });
  if (error) return res.status(400).json({ error: 'This form is not available' });
  if (!data) return res.status(404).json({ error: 'This form is not available' });
  res.json(data);
});

app.post('/api/forms/:key', formLimit, express.json({ limit: '16kb' }), async (req, res) => {
  // Real visitors never see the website box, so anything in it came from a bot
  if (req.body?.website) return res.json({ thanks: 'Thank you.' });

  const { data, error } = await publicDb().rpc('capture_lead', {
    p_key: req.params.key,
    p_lead: {
      name: req.body?.name,
      email: req.body?.email,
      phone: req.body?.phone,
      company: req.body?.company,
      message: req.body?.message
    }
  });
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// ---- Public API (Integrations) ----
// Read-only. Authenticates with a company API key (Authorization: Bearer gk_...), not a
// signed-in user. The database checks the key's hash, picks the company and counts requests;
// these limits stop floods before they reach it. Documented at /saas/integrations/api.
{
  const crypto = require('crypto');
  const API_RESOURCES = ['contacts', 'invoices', 'items', 'deals'];
  const API_KEY = /^gk_[0-9a-f]{48}$/;
  const API_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const apiKeyOf = (req) => {
    const [scheme, key] = (req.headers.authorization || '').split(' ');
    return scheme === 'Bearer' && API_KEY.test(key || '') ? key : null;
  };

  const perAddress = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many requests. Wait a minute and try again.' } });
  const perKey = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => crypto.createHash('sha256').update(req.apiKey).digest('hex'),
    message: { error: 'Too many requests for this API key. Wait a minute and try again.' } });

  const requireApiKey = (req, res, next) => {
    req.apiKey = apiKeyOf(req);
    if (!req.apiKey) return res.status(401).json({ error: 'Send your API key as: Authorization: Bearer gk_...' });
    if (!API_RESOURCES.includes(req.params.resource)) {
      return res.status(404).json({ error: `Unknown resource. Use ${API_RESOURCES.join(', ')}.` });
    }
    next();
  };

  const sendApi = (res, { data, error, status }) => {
    if (!error) return res.json(data);
    if ([401, 404, 429].includes(status)) return res.status(status).json({ error: error.message });
    console.error('[public api]', error.message);
    res.status(400).json({ error: 'The request could not be completed' });
  };

  const whole = (value, fallback) => (/^\d{1,7}$/.test(value || '') ? Number(value) : fallback);

  app.get('/api/v1/:resource', perAddress, requireApiKey, perKey, async (req, res) => {
    sendApi(res, await publicDb().schema('integrations').rpc('api_list', {
      p_key: req.apiKey,
      p_resource: req.params.resource,
      p_limit: Math.min(whole(req.query.limit, 25), 100),
      p_offset: whole(req.query.offset, 0)
    }));
  });

  app.get('/api/v1/:resource/:id', perAddress, requireApiKey, perKey, async (req, res) => {
    if (!API_ID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    sendApi(res, await publicDb().schema('integrations').rpc('api_get', {
      p_key: req.apiKey,
      p_resource: req.params.resource,
      p_id: req.params.id
    }));
  });

  app.all('/api/v1/*', perAddress, (req, res) => res.status(405).json({ error: 'The API is read-only. Use GET.' }));
}
// ---- End of public API ----

// ---- Public booking pages (Scheduler) ----
// No signed-in user. Each company is found by its private booking key; a visitor's own booking
// by the secret in their cancel link. Only the database's own messages go back to the visitor.
const bookingLimit = rateLimit({ windowMs: 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const bookingReadLimit = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
const BOOKING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOOKING_KEY = /^[0-9a-f]{32}$/;
const BOOKING_TOKEN = /^[0-9a-f]{64}$/;

const bookingReply = (res, error, fallback) =>
  res.status(400).json({ error: error.code === 'P0001' ? error.message : fallback });

app.get('/api/book/cancel/:token', bookingReadLimit, async (req, res) => {
  if (!BOOKING_TOKEN.test(req.params.token)) return res.status(404).json({ error: 'Booking not found' });
  const { data, error } = await publicDb().rpc('booking_by_token', { p_token: req.params.token });
  if (error) return bookingReply(res, error, 'Booking not found');
  if (!data) return res.status(404).json({ error: 'Booking not found' });
  res.json(data);
});

app.post('/api/book/cancel/:token', bookingLimit, express.json({ limit: '4kb' }), async (req, res) => {
  if (!BOOKING_TOKEN.test(req.params.token)) return res.status(404).json({ error: 'Booking not found' });
  const { data, error } = await publicDb().rpc('cancel_booking_by_token', {
    p_token: req.params.token,
    p_reason: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null
  });
  if (error) return bookingReply(res, error, 'Could not cancel. Please try again.');
  res.json(data);
});

app.get('/api/book/:key', bookingReadLimit, async (req, res) => {
  if (!BOOKING_KEY.test(req.params.key)) return res.status(404).json({ error: 'This booking page is not available' });
  const { data, error } = await publicDb().rpc('booking_page', { p_key: req.params.key });
  if (error || !data) return res.status(404).json({ error: 'This booking page is not available' });
  res.json(data);
});

app.get('/api/book/:key/slots', bookingReadLimit, async (req, res) => {
  const { service, staff, from } = req.query;
  const days = Number(req.query.days || 7);
  if (!BOOKING_KEY.test(req.params.key) || !BOOKING_ID.test(service || '') || (staff && !BOOKING_ID.test(staff))
      || !/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !Number.isInteger(days) || days < 1 || days > 14) {
    return res.status(400).json({ error: 'Choose a service and a date' });
  }
  const { data, error } = await publicDb().rpc('booking_slots', {
    p_key: req.params.key, p_service: service, p_staff: staff || null, p_from: from, p_days: days
  });
  if (error) return bookingReply(res, error, 'Could not load times. Please try again.');
  res.json(data);
});

app.post('/api/book/:key', bookingLimit, express.json({ limit: '16kb' }), async (req, res) => {
  // Real visitors never see the website box, so anything in it came from a bot
  if (req.body?.website) return res.status(201).json({ thanks: 'Thank you.' });

  const { service_id: service, staff_id: staff, start } = req.body || {};
  if (!BOOKING_KEY.test(req.params.key) || !BOOKING_ID.test(service || '') || (staff && !BOOKING_ID.test(staff))
      || typeof start !== 'string' || Number.isNaN(Date.parse(start))) {
    return res.status(400).json({ error: 'Choose a service and a time' });
  }
  const field = (name, max) => (typeof req.body[name] === 'string' ? req.body[name].slice(0, max) : '');
  const { data, error } = await publicDb().rpc('book_slot', {
    p_key: req.params.key,
    p_service: service,
    p_staff: staff || null,
    p_start: new Date(start).toISOString(),
    p_visitor: { name: field('name', 200), email: field('email', 254), phone: field('phone', 40), notes: field('notes', 2000) }
  });
  if (error) return bookingReply(res, error, 'Could not book. Please try again.');
  res.status(201).json(data);
});
// ---- End of public booking pages ----

// ---- Public customer chat (Chat) ----
// No signed-in user. Each company is found by its private chat key; a visitor's conversation by
// its secret token, which is sent in the body (never the URL) so it stays out of logs. The
// database caps message length and messages per chat and per company each day; these limits stop
// floods before they reach it. Only the database's own messages go back to the visitor.
{
  const crypto = require('crypto');
  const CHAT_KEY = /^[0-9a-f]{32}$/;
  const CHAT_TOKEN = /^[0-9a-f]{64}$/;
  const limitOf = (limit) => rateLimit({ windowMs: 60 * 1000, limit, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many messages. Please wait a minute and try again.' } });
  const chatStartLimit = limitOf(5);
  const chatSendLimit = limitOf(20);
  // The chat page checks for replies every few seconds
  const chatReadLimit = limitOf(60);

  const chatReply = (res, error, fallback) =>
    res.status(400).json({ error: error.code === 'P0001' ? error.message : fallback });

  const chatKey = (req, res, next) => {
    if (!CHAT_KEY.test(req.params.key)) return res.status(404).json({ error: 'This chat is not available' });
    next();
  };

  const chatToken = (req, res, next) => {
    if (!CHAT_TOKEN.test(req.body?.token || '')) return res.status(404).json({ error: 'This chat is not available' });
    next();
  };

  const after = (req) => (Number.isSafeInteger(req.body?.after) && req.body.after > 0 ? req.body.after : 0);
  const field = (req, name, max) => (typeof req.body?.[name] === 'string' ? req.body[name].slice(0, max) : '');

  app.get('/api/chat/:key', chatReadLimit, chatKey, async (req, res) => {
    const { data, error } = await publicDb().rpc('chat_info', { p_key: req.params.key });
    if (error || !data) return res.status(404).json({ error: 'This chat is not available' });
    res.json(data);
  });

  app.post('/api/chat/:key/start', chatStartLimit, chatKey, express.json({ limit: '4kb' }), async (req, res) => {
    // Real visitors never see the website box, so anything in it came from a bot. It gets a
    // made-up chat that leads nowhere.
    if (req.body?.website) {
      return res.status(201).json({ token: crypto.randomBytes(32).toString('hex'), status: 'open', needs_contact: false, messages: [] });
    }
    const { data, error } = await publicDb().rpc('chat_start', {
      p_key: req.params.key,
      p_visitor: { name: field(req, 'name', 100), email: field(req, 'email', 254), page: field(req, 'page', 500) }
    });
    if (error) return chatReply(res, error, 'Could not start the chat. Please try again.');
    res.status(201).json(data);
  });

  app.post('/api/chat/:key/poll', chatReadLimit, chatKey, express.json({ limit: '2kb' }), chatToken, async (req, res) => {
    const { data, error } = await publicDb().rpc('chat_poll', { p_key: req.params.key, p_token: req.body.token, p_after: after(req) });
    if (error) return chatReply(res, error, 'This chat is not available');
    res.json(data);
  });

  app.post('/api/chat/:key/messages', chatSendLimit, chatKey, express.json({ limit: '8kb' }), chatToken, async (req, res) => {
    const body = field(req, 'body', 1001).trim();
    if (!body) return res.status(400).json({ error: 'Type a message' });
    const { data, error } = await publicDb().rpc('chat_send', {
      p_key: req.params.key, p_token: req.body.token, p_body: body, p_after: after(req)
    });
    if (error) return chatReply(res, error, 'Could not send. Please try again.');
    res.status(201).json(data);
  });

  app.post('/api/chat/:key/person', chatSendLimit, chatKey, express.json({ limit: '2kb' }), chatToken, async (req, res) => {
    const { data, error } = await publicDb().rpc('chat_person', { p_key: req.params.key, p_token: req.body.token, p_after: after(req) });
    if (error) return chatReply(res, error, 'Could not send. Please try again.');
    res.json(data);
  });

  app.post('/api/chat/:key/contact', chatSendLimit, chatKey, express.json({ limit: '4kb' }), chatToken, async (req, res) => {
    const { data, error } = await publicDb().rpc('chat_contact', {
      p_key: req.params.key, p_token: req.body.token,
      p_name: field(req, 'name', 100), p_email: field(req, 'email', 254), p_after: after(req)
    });
    if (error) return chatReply(res, error, 'Could not save. Please try again.');
    res.json(data);
  });
}
// ---- End of public customer chat ----

// Service routing - internal services
const serviceRoutes = [
  { path: '/api/accounting', service: 'accounting-service', port: 3001 },
  { path: '/api/crm', service: 'crm-service', port: 3002 },
  { path: '/api/inventory', service: 'inventory-service', port: 3003 },
  { path: '/api/chatbot', service: 'chatbot-service', port: 3004 },
  { path: '/api/video', service: 'video-service', port: 3005 },
  { path: '/api/scheduler', service: 'scheduler-service', port: 3006 },
  { path: '/api/hr', service: 'hr-service', port: 3007 },
  { path: '/api/social-media', service: 'social-media-service', port: 3008 },
  { path: '/api/analytics', service: 'analytics-service', port: 3010 },
  { path: '/api/integration', service: 'integration-service', port: 3011 },
];

const serviceHost = (service) =>
  process.env.NODE_ENV === 'production' ? `${service}.railway.internal` : 'localhost';

// Setup proxies
serviceRoutes.forEach(({ path, service, port }) => {
  const serviceUrl = `http://${serviceHost(service)}:${port}`;

  app.use(path, requireUser, requireTenant, httpProxy(serviceUrl, {
    proxyReqPathResolver: (req) => req.url,
    proxyReqOptDecorator: (proxyReqOpts, req) => {
      proxyReqOpts.headers['x-tenant-id'] = req.tenantId;
      return proxyReqOpts;
    },
    proxyErrorHandler: (err, res, next) => {
      console.error(`[ERROR] ${service}: ${err.message}`);
      res.status(503).json({ error: `${service} unavailable` });
    }
  }));
});

// WebSocket proxy (if needed)
app.use('/ws', requireUser, requireTenant, httpProxy(`http://${serviceHost('websocket-service')}:3009`, {
  ws: true
}));

// Health checks
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: 13
  });
});

// Service status endpoint
app.get('/status', requireUser, async (req, res) => {
  const statuses = {};

  for (const { service, port } of serviceRoutes) {
    try {
      const response = await fetch(`http://${serviceHost(service)}:${port}/health`, {
        signal: AbortSignal.timeout(2000)
      });
      statuses[service] = response.ok ? 'up' : 'down';
    } catch {
      statuses[service] = 'down';
    }
  }

  res.json(statuses);
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
    method: req.method
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 API Gateway running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Proxying to 13 microservices`);
});

module.exports = app;
