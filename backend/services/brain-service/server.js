require('dotenv').config();
const crypto = require('crypto');
const express = require('express');

// The Business Brain. It thinks about the whole company, proposes ideas with evidence, pros, cons
// and risks, waits for an owner or admin to approve one in the app, then carries out the approved
// actions as that person and later checks whether they worked.
//
//   In the app (through the gateway, /api/brain/*, signed-in person): ideas, decisions, think now
//   Daily job (worker, shared secret BRAIN_JOB_SECRET): /internal/think-all, /internal/check-outcomes
//   MCP server for AI tools (company API key): /mcp
//
// AI proposes, a human approves. Nothing changes in the business until a person with the right
// role approves an idea. AI tools over MCP can read, analyse and propose, never approve or execute.

const { userError } = require('./lib/business');
const { brainAs, brainService, companyFacts } = require('./lib/db');
const { think, companySnapshot } = require('./lib/think');
const { decide, approve, checkOutcomes } = require('./lib/execute');
const { forecastCash, simulateScenario } = require('./lib/numbers');
const { catalogList } = require('./lib/catalog');
const mcp = require('./lib/mcp');

const app = express();
const PORT = process.env.PORT || 3013;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Railway terminates TLS in front of the service (the MCP domain is public)
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Only our own messages and the ones the database functions raise (P0001) reach people
const sendError = (res, error) => {
  const code = error?.code || '';
  if (error?.status) return res.status(error.status).json({ error: error.message });
  if (code === 'P0001') {
    const message = error.message;
    if (message === 'Company not found' || message === 'Idea not found') return res.status(404).json({ error: message });
    if (/^Only owners and admins/.test(message)) return res.status(403).json({ error: message });
    if (/already been decided|has expired|not waiting|not being carried out/.test(message)) return res.status(409).json({ error: message });
    return res.status(400).json({ error: message });
  }
  if (/^PT[45]\d\d$/.test(code)) return res.status(Number(code.slice(2))).json({ error: error.message });
  if (error?.httpStatus === 401 || code === 'PGRST301' || code === 'PGRST303') return res.status(401).json({ error: 'Sign in required' });
  console.error('Brain error:', code, error?.message);
  if (code === '42501') return res.status(403).json({ error: 'You don’t have access to that' });
  if (code === '22P02') return res.status(404).json({ error: 'Not found' });
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
};

const handle = (fn) => async (req, res) => {
  try {
    const result = await fn(req, res);
    if (!res.headersSent) res.json(result ?? { success: true });
  } catch (error) {
    sendError(res, error);
  }
};

let daily = { running: false, last_run_at: null, last_result: null, last_error: null };

app.get('/health', (req, res) => res.json({
  status: 'ok',
  service: 'brain-service',
  ai: Boolean(process.env.ANTHROPIC_API_KEY),
  daily: { running: daily.running, last_run_at: daily.last_run_at, last_error: daily.last_error }
}));

// ---- MCP (company API key; reached directly, not through the gateway) ----
mcp.mount(app, express);

// ---- Daily job (worker) ----
// The worker calls these directly with the shared secret; requests through the gateway (which sets
// a company) are refused.
const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();
const fromWorker = (req, res, next) => {
  const secret = process.env.BRAIN_JOB_SECRET || '';
  const given = req.headers['x-brain-secret'] || '';
  if (secret.length < 16 || req.headers['x-tenant-id'] || !crypto.timingSafeEqual(digest(secret), digest(given))) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
};

const thinkForEveryone = async () => {
  const expired = await brainService('expire_old', {});
  const tenants = await brainService('active_tenants', {});
  const summary = { companies: tenants.length, thought: 0, ideas: 0, skipped: 0, failed: 0, expired };
  for (const tenantId of tenants) {
    try {
      const result = await think(tenantId, { trigger: 'daily', source: 'daily' });
      summary.thought += 1;
      summary.ideas += result.created.length;
    } catch (error) {
      if (error?.status === 429) summary.skipped += 1;
      else {
        summary.failed += 1;
        console.error('Brain daily think failed for a company:', error?.code || '', error?.message);
      }
    }
  }
  summary.outcomes = await checkOutcomes();
  return summary;
};

// Starts the daily run and answers straight away; the result shows on /health
app.post('/internal/think-all', fromWorker, (req, res) => {
  if (daily.running) return res.status(202).json({ started: false, running: true });
  daily = { ...daily, running: true, last_run_at: new Date().toISOString() };
  thinkForEveryone()
    .then((result) => {
      daily = { ...daily, running: false, last_result: result, last_error: null };
      console.log('Brain daily run:', JSON.stringify(result));
    })
    .catch((error) => {
      daily = { ...daily, running: false, last_error: error?.message || 'failed' };
      console.error('Brain daily run failed:', error?.message);
    });
  res.status(202).json({ started: true });
});

app.post('/internal/check-outcomes', fromWorker, handle(() => checkOutcomes()));

app.get('/internal/status', fromWorker, (req, res) => res.json(daily));

// ---- In the app, through the gateway (/api/brain/*) ----
// The gateway checks the sign-in and sets the company. This service is also reachable on its own
// domain (for MCP), so every route below checks the person again in the database with their own
// token before doing anything.
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  req.tenantId = req.headers['x-tenant-id'];
  const authorization = req.headers.authorization || '';
  if (!UUID.test(req.tenantId || '') || !/^Bearer\s+\S+/.test(authorization) || /^Bearer\s+gk_/.test(authorization)) {
    return res.status(400).json({ error: 'Missing tenant' });
  }
  req.ctx = { authorization, tenantId: req.tenantId };
  req.asUser = brainAs(authorization);
  next();
});

const proposalId = (req) => {
  if (!UUID.test(req.params.id || '')) throw userError('Idea not found', 404);
  return req.params.id.toLowerCase();
};
const note = (req) => (typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 1000) : '');
const roleOf = (req) => req.asUser('role_in', { p_tenant: req.tenantId });
const requireMember = async (req) => {
  const role = await roleOf(req);
  if (!role) throw userError('Company not found', 404);
  return role;
};

// Ideas
app.get('/proposals', handle((req) => req.asUser('list_proposals', {
  p_tenant: req.tenantId,
  p_status: typeof req.query.status === 'string' ? req.query.status : 'open',
  p_limit: Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200)
})));

app.get('/proposals/:id', handle((req) => req.asUser('get_proposal', { p_tenant: req.tenantId, p_proposal: proposalId(req) })));

app.post('/proposals/:id/approve', handle((req) => approve(req.ctx, proposalId(req), note(req))));

app.post('/proposals/:id/reject', handle(async (req) => {
  const proposal = await decide(req.ctx, proposalId(req), 'reject', note(req));
  return { proposal, message: 'Rejected. The Brain will remember why and won’t suggest this again for a while.' };
}));

app.post('/proposals/:id/request-changes', handle(async (req) => {
  if (!note(req)) throw userError('Say what should change');
  const proposal = await decide(req.ctx, proposalId(req), 'request_changes', note(req));
  return { proposal, message: 'Noted. The Brain will take your comments into account next time it thinks.' };
}));

// Think now. Anyone who can make changes may ask; only owners and admins decide.
app.post('/think', handle(async (req) => {
  const role = await requireMember(req);
  if (role === 'viewer') throw userError('You can look around this company but not ask the Brain to think.', 403);
  return think(req.tenantId, { trigger: 'app', source: `app:${role}` });
}));

// The company's memory
app.get('/history', handle((req) => req.asUser('history', {
  p_tenant: req.tenantId, p_limit: Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 30, 1), 100)
})));

// Numbers for the Brain page. Payroll totals are left out (they are for owners and admins only).
app.get('/snapshot', handle(async (req) => {
  await requireMember(req);
  const facts = await companyFacts(req.tenantId);
  const { snapshot } = await companySnapshot(req.tenantId, facts);
  return { snapshot, cash_balance: facts.cash_balance };
}));

app.get('/forecast', handle(async (req) => {
  await requireMember(req);
  return forecastCash(await companyFacts(req.tenantId), Number(req.query.days) || 90);
}));

app.post('/simulate', handle(async (req) => {
  await requireMember(req);
  const facts = await companyFacts(req.tenantId);
  const { snapshot } = await companySnapshot(req.tenantId, facts);
  return simulateScenario(snapshot, facts, req.body || {});
}));

// What approved ideas can do
app.get('/catalog', handle(async (req) => {
  await requireMember(req);
  return { actions: catalogList() };
}));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

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

app.listen(PORT, () => console.log(`Business Brain on ${PORT}`));

module.exports = app;
