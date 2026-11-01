require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3002;

// Queries run as the signed-in user, so database policies apply to them
const supabaseFor = (authorization) =>
  createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false }
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACTIVITY_KINDS = ['note', 'call', 'email', 'meeting', 'task'];

const crm = (req) => req.db.schema('crm');
const contacts = (req) => crm(req).from('contacts');
const companies = (req) => crm(req).from('companies');
const deals = (req) => crm(req).from('deals');
const activities = (req) => crm(req).from('activities');

const DEAL_FIELDS = '*, contact:contacts(id, name), company:companies(id, name), stage:stages(id, name, kind, probability, pipeline_id)';
const ACTIVITY_FIELDS = '*, contact:contacts(id, name), company:companies(id, name), deal:deals(id, title)';

const parseValue = (value) => {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!(parsed >= 0)) throw new Error('Enter a valid deal value');
  return parsed;
};

const parseDate = (value) => {
  if (value === '' || value === null || value === undefined) return null;
  if (!DATE.test(value)) throw new Error('Enter a valid date');
  return value;
};

// Forms send an empty string for "none"
const optional = (value) => (value === '' || value === undefined ? null : value);

// Only the fields that were sent, so a stage move can't wipe the rest of a deal
const pick = (body, fields) => Object.fromEntries(
  Object.entries(fields)
    .filter(([field]) => body[field] !== undefined)
    .map(([field, parse]) => [field, parse(body[field])])
);

const sendError = (res, error) => {
  if (error.code === '23505') return res.status(409).json({ error: 'That name is already used' });
  res.status(400).json({ error: error.message });
};

const list = (query) => async (req, res) => {
  try {
    const { data, error } = await query(req);
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    sendError(res, error);
  }
};

const one = (query, label) => async (req, res) => {
  try {
    const { data, error } = await query(req).eq('id', req.params.id).eq('tenant_id', req.tenantId).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: `${label} not found` });
    res.json(data);
  } catch (error) {
    sendError(res, error);
  }
};

const create = (table, read, fields) => async (req, res) => {
  try {
    const { data, error } = await table(req).insert([{ tenant_id: req.tenantId, ...fields(req.body) }]).select(read);
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (error) {
    sendError(res, error);
  }
};

const update = (table, read, fields, label) => async (req, res) => {
  try {
    const { data, error } = await table(req)
      .update(fields(req.body))
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .select(read);

    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: `${label} not found` });
    res.json(data[0]);
  } catch (error) {
    sendError(res, error);
  }
};

const remove = (table, label) => async (req, res) => {
  try {
    const { data, error } = await table(req)
      .delete()
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .select('id');

    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: `${label} not found` });
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
};

// Runs a database function, which checks the caller's role and company itself
const callCrm = (name, params) => async (req, res) => {
  try {
    const { data, error } = await crm(req).rpc(name, { p_tenant: req.tenantId, ...params(req) });
    if (error) throw error;
    res.json(data ?? { success: true });
  } catch (error) {
    sendError(res, error);
  }
};

const companyFields = (body) => {
  if (body.name !== undefined && !body.name) throw new Error('Name is required');
  return {
    ...pick(body, {
      name: (value) => value,
      website: optional,
      industry: optional,
      phone: optional,
      notes: optional,
      owner_id: optional
    }),
    updated_at: new Date().toISOString()
  };
};

const contactFields = (body) => {
  if (body.name !== undefined && !body.name) throw new Error('Name is required');
  return {
    ...pick(body, {
      name: (value) => value,
      email: optional,
      phone: optional,
      job_title: optional,
      company_id: optional,
      notes: optional,
      owner_id: optional
    }),
    updated_at: new Date().toISOString()
  };
};

const dealFields = (body) => {
  if (body.title !== undefined && !body.title) throw new Error('Title is required');
  return pick(body, {
    title: (value) => value,
    value: parseValue,
    stage_id: optional,
    contact_id: optional,
    company_id: optional,
    owner_id: optional,
    expected_close: parseDate,
    lost_reason: optional
  });
};

const activityFields = (body) => {
  if (body.kind !== undefined && !ACTIVITY_KINDS.includes(body.kind)) throw new Error('Choose a type');
  if (body.subject !== undefined && !body.subject) throw new Error('Add a subject');
  return pick(body, {
    kind: (value) => value,
    subject: (value) => value,
    body: optional,
    due_on: parseDate,
    contact_id: optional,
    company_id: optional,
    deal_id: optional,
    owner_id: optional
  });
};

app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'crm-service' }));

// Only the gateway reaches this service, and it sets the tenant
app.use((req, res, next) => {
  req.tenantId = req.headers['x-tenant-id'];
  if (!UUID.test(req.tenantId || '') || !req.headers.authorization) {
    return res.status(400).json({ error: 'Missing tenant' });
  }
  req.db = supabaseFor(req.headers.authorization);
  next();
});

// Overview and search
app.get('/overview', callCrm('overview', () => ({})));
app.get('/search', callCrm('search', (req) => ({ p_query: req.query.q || '' })));

// Companies
app.get('/companies', list((req) => companies(req)
  .select('*, contacts(count), deals(count)')
  .eq('tenant_id', req.tenantId)
  .order('name')));
app.get('/companies/:id', one((req) => companies(req).select('*'), 'Company'));
app.post('/companies', create(companies, '*', (body) => {
  if (!body.name) throw new Error('Name is required');
  return companyFields(body);
}));
app.put('/companies/:id', update(companies, '*', companyFields, 'Company'));
app.delete('/companies/:id', remove(companies, 'Company'));

// Contacts
app.get('/contacts', list((req) => {
  const query = contacts(req)
    .select('*, company:companies(id, name)')
    .eq('tenant_id', req.tenantId)
    .order('created_at', { ascending: false });
  return req.query.company_id ? query.eq('company_id', req.query.company_id) : query;
}));
app.post('/contacts/import', callCrm('import_contacts', (req) => ({ p_rows: req.body.rows })));
app.get('/contacts/:id', one((req) => contacts(req).select('*, company:companies(id, name)'), 'Contact'));
app.post('/contacts', create(contacts, '*', (body) => {
  if (!body.name) throw new Error('Name is required');
  return contactFields(body);
}));
app.put('/contacts/:id', update(contacts, '*', contactFields, 'Contact'));
app.delete('/contacts/:id', remove(contacts, 'Contact'));

// Deals
app.get('/deals', list((req) => {
  let query = deals(req)
    .select(DEAL_FIELDS)
    .eq('tenant_id', req.tenantId)
    .order('created_at', { ascending: false });
  if (req.query.company_id) query = query.eq('company_id', req.query.company_id);
  if (req.query.contact_id) query = query.eq('contact_id', req.query.contact_id);
  return query;
}));
app.get('/deals/:id', one((req) => deals(req).select(DEAL_FIELDS), 'Deal'));
app.get('/deals/:id/history', list((req) => crm(req).from('deal_history')
  .select('*, from_stage:stages!deal_history_from_stage_id_fkey(name), to_stage:stages!deal_history_to_stage_id_fkey(name)')
  .eq('deal_id', req.params.id)
  .eq('tenant_id', req.tenantId)
  .order('changed_at', { ascending: false })));
app.post('/deals', create(deals, DEAL_FIELDS, (body) => {
  if (!body.title) throw new Error('Title is required');
  return dealFields(body);
}));
app.put('/deals/:id', update(deals, DEAL_FIELDS, dealFields, 'Deal'));
app.delete('/deals/:id', remove(deals, 'Deal'));

// Activities and tasks
app.get('/activities', list((req) => {
  let query = activities(req)
    .select(ACTIVITY_FIELDS)
    .eq('tenant_id', req.tenantId)
    .order('created_at', { ascending: false })
    .limit(200);
  for (const link of ['contact_id', 'company_id', 'deal_id']) {
    if (req.query[link]) query = query.eq(link, req.query[link]);
  }
  if (req.query.tasks === 'open') query = query.eq('kind', 'task').is('done_at', null);
  return query;
}));
app.post('/activities', create(activities, ACTIVITY_FIELDS, (body) => {
  if (!ACTIVITY_KINDS.includes(body.kind)) throw new Error('Choose a type');
  if (!body.subject) throw new Error('Add a subject');
  return activityFields(body);
}));
app.put('/activities/:id', update(activities, ACTIVITY_FIELDS, activityFields, 'Activity'));
app.put('/activities/:id/done', update(activities, ACTIVITY_FIELDS, (body) => ({
  done_at: body.done === false ? null : new Date().toISOString()
}), 'Activity'));
app.delete('/activities/:id', remove(activities, 'Activity'));

// Pipelines
app.get('/pipelines', list((req) => crm(req).from('pipelines')
  .select('*, stages(*)')
  .eq('tenant_id', req.tenantId)
  .order('is_default', { ascending: false })
  .order('name')
  .order('position', { referencedTable: 'stages' })));
app.post('/pipelines', callCrm('save_pipeline', (req) => ({
  p_pipeline: req.body.id || null,
  p_name: req.body.name,
  p_stages: req.body.stages
})));
app.delete('/pipelines/:id', callCrm('delete_pipeline', (req) => ({ p_pipeline: req.params.id })));

app.listen(PORT, () => console.log(`👥 CRM Service running on port ${PORT}`));
