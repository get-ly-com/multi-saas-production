require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3010;

// Queries run as the signed-in user. The database checks they belong to the company and only
// returns payroll totals to owners and admins.
const supabaseFor = (authorization) =>
  createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false }
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const analytics = (req) => req.db.schema('analytics');

const sendError = (res, error) => {
  if (error.status) return res.status(error.status).json({ error: error.message });
  if (error.message === 'Not found') return res.status(404).json({ error: 'Company not found' });
  res.status(400).json({ error: error.message });
};

const date = (value, message) => {
  if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(value))) throw new Error(message);
  return value;
};

const call = async (req, name, params) => {
  const { data, error } = await analytics(req).rpc(name, { p_tenant: req.tenantId, ...params });
  if (error) throw error;
  return data;
};

const callAnalytics = (name, params) => async (req, res) => {
  try {
    res.json(await call(req, name, params(req)));
  } catch (error) {
    sendError(res, error);
  }
};

app.use(express.json({ limit: '16kb' }));
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'analytics-service' }));

// Only the gateway reaches this service, and it sets the tenant
app.use((req, res, next) => {
  req.tenantId = req.headers['x-tenant-id'];
  if (!UUID.test(req.tenantId || '') || !req.headers.authorization) {
    return res.status(400).json({ error: 'Missing tenant' });
  }
  req.db = supabaseFor(req.headers.authorization);
  next();
});

// Everything on the dashboard for one period, compared with the period before it
app.get('/dashboard', callAnalytics('dashboard', (req) => {
  const from = date(req.query.from, 'Choose a start date');
  const to = date(req.query.to, 'Choose an end date');
  if (from > to) throw new Error('Choose a start date before the end date');
  return { p_from: from, p_to: to };
}));

app.listen(PORT, () => console.log(`Analytics Service on ${PORT}`));
