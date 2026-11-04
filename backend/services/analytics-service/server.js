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

// Only our own messages and the ones our database functions raise (P0001) reach people
const sendError = (res, error) => {
  const code = error?.code || '';
  if (error?.status) return res.status(error.status).json({ error: error.message });
  if (!code && error?.constructor === Error) return res.status(400).json({ error: error.message });
  if (code === 'P0001') {
    if (error.message === 'Not found') return res.status(404).json({ error: 'Company not found' });
    return res.status(400).json({ error: error.message });
  }
  if (/^PT[45]\d\d$/.test(code)) return res.status(Number(code.slice(2))).json({ error: error.message });

  console.error('Analytics error:', error);
  if (code === '42501') return res.status(403).json({ error: 'You don’t have access to that' });
  if (code === '22P02') return res.status(404).json({ error: 'Not found' });
  if (code === '23503') return res.status(409).json({ error: 'That is still in use' });
  if (code === '23505') return res.status(409).json({ error: 'That is already saved' });
  if (code === '23514') return res.status(400).json({ error: 'That value isn’t allowed' });
  res.status(400).json({ error: 'That didn’t work. Please check and try again.' });
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

// Receipt pictures are the one large body; everything else stays small
const smallJson = express.json({ limit: '16kb' });
const receiptJson = express.json({ limit: '6mb' });
app.use((req, res, next) => (req.path === '/assistant/receipt' ? receiptJson : smallJson)(req, res, next));
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

// The dashboard's totals for any other range, to compare against (for example the same dates last year)
app.get('/compare', callAnalytics('compare', (req) => {
  const from = date(req.query.from, 'Choose a start date');
  const to = date(req.query.to, 'Choose an end date');
  if (from > to) throw new Error('Choose a start date before the end date');
  return { p_from: from, p_to: to };
}));

// Report builder. The database only accepts the dataset, group, measure, date and filter keys it
// knows; nothing sent here is put into a query as text.
const KEY = /^[a-z_]{1,30}$/;
const reportSpec = (body) => {
  const spec = body && typeof body === 'object' ? body : {};
  const pick = (name) => (typeof spec[name] === 'string' && KEY.test(spec[name]) ? spec[name] : undefined);
  const day = (name) => (typeof spec[name] === 'string' && DATE.test(spec[name]) ? spec[name] : undefined);
  return {
    dataset: pick('dataset'),
    group: pick('group'),
    measure: pick('measure'),
    date_field: pick('date_field'),
    filter: pick('filter'),
    by_month: spec.by_month === true,
    period: pick('period'),
    chart: pick('chart'),
    from: day('from'),
    to: day('to')
  };
};

const id = (value, label) => {
  if (!UUID.test(value || '')) {
    const error = new Error(`${label} not found`);
    error.status = 404;
    throw error;
  }
  return value;
};

app.get('/reports', callAnalytics('list_reports', () => ({})));
app.post('/reports/run', callAnalytics('run_report', (req) => ({ p_spec: reportSpec(req.body?.spec) })));
app.post('/reports', callAnalytics('save_report', (req) => ({
  p_report: null,
  p_name: String(req.body?.name ?? '').slice(0, 80),
  p_spec: reportSpec(req.body?.spec)
})));
app.put('/reports/:id', callAnalytics('save_report', (req) => ({
  p_report: id(req.params.id, 'Report'),
  p_name: String(req.body?.name ?? '').slice(0, 80),
  p_spec: reportSpec(req.body?.spec)
})));
app.delete('/reports/:id', callAnalytics('delete_report', (req) => ({ p_report: id(req.params.id, 'Report') })));

// Monthly goals. Owners and admins set them; everyone in the company sees progress.
app.get('/goals', callAnalytics('goal_progress', (req) => ({
  p_month: req.query.month ? date(req.query.month, 'Choose a month') : null
})));
app.post('/goals', callAnalytics('set_goal', (req) => {
  const target = req.body?.target === null || req.body?.target === '' ? null : Number(req.body?.target);
  if (target !== null && !(Number.isFinite(target) && target >= 0)) throw new Error('Enter a goal of 0 or more');
  const months = Number(req.body?.months || 1);
  if (!Number.isInteger(months)) throw new Error('Set a goal for 1 to 12 months at a time');
  return {
    p_metric: String(req.body?.metric ?? ''),
    p_month: date(req.body?.month, 'Choose a month'),
    p_target: target,
    p_months: months
  };
}));

// Daily snapshots of money owed, pipeline, stock, staff, open leads and chats
app.get('/history', callAnalytics('snapshot_history', (req) => ({
  p_days: Math.min(Math.max(Number.parseInt(req.query.days, 10) || 90, 7), 400)
})));

// To do list, questions about the numbers and reading receipts
require('./assistant')(app, { sendError, call });

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

app.listen(PORT, () => console.log(`Analytics Service on ${PORT}`));
