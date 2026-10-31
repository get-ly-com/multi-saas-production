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
app.use(cors({ origin: allowedOrigins, allowedHeaders: ['Authorization', 'Content-Type'] }));
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

const findMembership = async (req) => {
  const { data, error } = await req.db
    .from('tenant_members')
    .select('role, tenant:tenants(id, name)')
    .eq('user_id', req.user.id)
    .maybeSingle();

  if (error) throw error;
  return data;
};

// The tenant always comes from the membership, never from the client
const requireTenant = async (req, res, next) => {
  try {
    const membership = await findMembership(req);
    if (!membership) {
      return res.status(403).json({ error: 'Create a company first' });
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
    const membership = await findMembership(req);
    res.json({
      user: { id: req.user.id, email: req.user.email },
      tenant: membership ? { ...membership.tenant, role: membership.role } : null
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
