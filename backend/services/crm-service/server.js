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
const leads = (req) => crm(req).from('leads');

const DEAL_FIELDS = '*, contact:contacts(id, name), company:companies(id, name), stage:stages(id, name, kind, probability, pipeline_id)';
const ACTIVITY_FIELDS = '*, contact:contacts(id, name), company:companies(id, name), deal:deals(id, title), lead:leads(id, name)';
const LEAD_STATUSES = ['new', 'working', 'disqualified'];

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

const requiredDate = (value) => {
  if (typeof value !== 'string' || !DATE.test(value)) throw new Error('Choose a start and end date');
  return value;
};

// A month comes as 2026-11 and is stored as its first day
const parseMonth = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error('Choose a month');
  return `${value}-01`;
};

const FORECAST_CATEGORIES = ['commit', 'best_case', 'pipeline', 'omit'];

// Blank means the stage's chance decides
const parseCategory = (value) => {
  if (value === '' || value === null) return null;
  if (!FORECAST_CATEGORIES.includes(value)) throw new Error('Choose a forecast category');
  return value;
};

// Forms send an empty string for "none"
const optional = (value) => (value === '' || value === undefined ? null : value);

// A list of tag ids; the database checks they belong to this company
const parseTags = (value) => {
  if (!Array.isArray(value) || value.length > 20 || !value.every((id) => typeof id === 'string' && UUID.test(id))) {
    throw new Error('Choose up to 20 tags');
  }
  return value;
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const parseTime = (value) => {
  if (value === '' || value === null || value === undefined) return null;
  if (typeof value !== 'string' || !TIME.test(value)) throw new Error('Enter a valid time');
  return value;
};

const optionalNumber = (value) => (value === '' || value === null || value === undefined ? null : Number(value));

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
      owner_id: optional,
      custom: (value) => value,
      tags: parseTags
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
      owner_id: optional,
      custom: (value) => value,
      tags: parseTags
    }),
    updated_at: new Date().toISOString()
  };
};

const leadFields = (body) => {
  if (body.name !== undefined && !body.name) throw new Error('Name is required');
  if (body.status !== undefined && !LEAD_STATUSES.includes(body.status)) throw new Error('Choose a status');
  return pick(body, {
    name: (value) => value,
    email: optional,
    phone: optional,
    company_name: optional,
    job_title: optional,
    source: optional,
    notes: optional,
    status: (value) => value,
    disqualified_reason: optional,
    owner_id: optional,
    custom: (value) => value,
    tags: parseTags
  });
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
    forecast_category: parseCategory,
    lost_reason: optional,
    custom: (value) => value,
    tags: parseTags
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
    due_time: parseTime,
    contact_id: optional,
    company_id: optional,
    deal_id: optional,
    lead_id: optional,
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
app.post('/contacts/:id/merge', callCrm('merge_contacts', (req) => ({ p_keep: req.params.id, p_drop: req.body.drop_id })));

// Leads
app.get('/leads', list((req) => leads(req)
  .select('*')
  .eq('tenant_id', req.tenantId)
  .order('created_at', { ascending: false })));
app.get('/leads/summary', callCrm('lead_summary', () => ({})));
app.post('/leads/import', callCrm('import_leads', (req) => ({ p_rows: req.body.rows })));
app.get('/leads/:id', one((req) => leads(req).select('*'), 'Lead'));
app.get('/leads/:id/matches', callCrm('lead_matches', (req) => ({ p_lead: req.params.id })));
app.post('/leads', create(leads, '*', (body) => {
  if (!body.name) throw new Error('Name is required');
  return leadFields(body);
}));
app.put('/leads/:id', update(leads, '*', leadFields, 'Lead'));
app.delete('/leads/:id', remove(leads, 'Lead'));
app.post('/leads/:id/convert', callCrm('convert_lead', (req) => ({
  p_lead: req.params.id,
  p_contact: optional(req.body.contact_id),
  p_company: optional(req.body.company_id),
  p_deal: req.body.deal || null
})));
app.post('/leads/:id/merge', callCrm('merge_leads', (req) => ({ p_keep: req.params.id, p_drop: req.body.drop_id })));

app.get('/duplicates', callCrm('duplicates', () => ({})));

app.get('/lead-settings', async (req, res) => {
  try {
    const [settings, rules] = await Promise.all([
      crm(req).from('lead_settings').select('*').eq('tenant_id', req.tenantId).maybeSingle(),
      crm(req).from('score_rules').select('*').eq('tenant_id', req.tenantId).order('points', { ascending: false })
    ]);
    if (settings.error) throw settings.error;
    if (rules.error) throw rules.error;
    res.json({ ...settings.data, rules: rules.data || [] });
  } catch (error) {
    sendError(res, error);
  }
});
app.post('/lead-settings', callCrm('save_lead_settings', (req) => ({ p_settings: req.body })));
app.post('/lead-settings/form-key', callCrm('new_form_key', () => ({})));

// Tags. Anyone who can edit can add or rename one; only owners and admins can delete.
const TAG_COLORS = ['grey', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'];
const tagsTable = (req) => crm(req).from('tags');
const tagFields = (body) => {
  const fields = {};
  if (body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name || name.length > 40) throw new Error('Name the tag in up to 40 characters');
    fields.name = name;
  }
  if (body.color !== undefined) {
    if (!TAG_COLORS.includes(body.color)) throw new Error('Choose a colour');
    fields.color = body.color;
  }
  return fields;
};
app.get('/tags', list((req) => tagsTable(req).select('*').eq('tenant_id', req.tenantId).order('name')));
app.post('/tags', create(tagsTable, '*', (body) => {
  if (!body.name) throw new Error('Name the tag');
  return tagFields(body);
}));
app.put('/tags/:id', update(tagsTable, '*', tagFields, 'Tag'));
app.delete('/tags/:id', remove(tagsTable, 'Tag'));

// Lost reasons to pick from. Only owners and admins can change the list.
const reasonsTable = (req) => crm(req).from('lost_reasons');
app.get('/lost-reasons', list((req) => reasonsTable(req).select('*').eq('tenant_id', req.tenantId).order('name')));
app.post('/lost-reasons', create(reasonsTable, '*', (body) => {
  const name = String(body.name || '').trim();
  if (!name || name.length > 80) throw new Error('Enter a reason in up to 80 characters');
  return { name };
}));
app.delete('/lost-reasons/:id', remove(reasonsTable, 'Reason'));

// Changing many records at once
const BULK_ENTITIES = ['contact', 'company', 'lead', 'deal'];
const BULK_ACTIONS = ['owner', 'add_tag', 'remove_tag', 'stage', 'status', 'delete'];
app.post('/bulk', callCrm('bulk_update', (req) => {
  const { entity, ids, action, value, reason } = req.body;
  if (!BULK_ENTITIES.includes(entity) || !BULK_ACTIONS.includes(action)) throw new Error('Choose what to change');
  if (!Array.isArray(ids) || !ids.length) throw new Error('Select at least one row');
  if (ids.length > 500) throw new Error('Select up to 500 rows at a time');
  if (!ids.every((id) => typeof id === 'string' && UUID.test(id))) throw new Error('Select at least one row');
  return {
    p_entity: entity,
    p_ids: ids,
    p_action: action,
    p_value: typeof value === 'string' ? value : null,
    p_reason: typeof reason === 'string' ? reason : null
  };
}));

// Custom fields
app.get('/custom-fields', list((req) => {
  const query = crm(req).from('custom_fields')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .order('position');
  return req.query.entity ? query.eq('entity', req.query.entity) : query;
}));
app.post('/custom-fields', callCrm('save_custom_field', (req) => ({
  p_field: req.body.id || null,
  p_entity: req.body.entity,
  p_label: req.body.label,
  p_kind: req.body.kind,
  p_options: req.body.options || [],
  p_required: Boolean(req.body.required)
})));
app.delete('/custom-fields/:id', callCrm('delete_custom_field', (req) => ({ p_field: req.params.id })));

// Saved views
const views = (req) => crm(req).from('saved_views');

app.get('/views', list((req) => views(req)
  .select('*')
  .eq('tenant_id', req.tenantId)
  .eq('entity', req.query.entity)
  .order('name')));
app.post('/views', create(views, '*', (body) => {
  if (!body.name) throw new Error('Enter a name');
  return { entity: body.entity, name: body.name, shared: Boolean(body.shared), filters: body.filters || {} };
}));
app.delete('/views/:id', remove(views, 'View'));

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
app.get('/deal-signals', callCrm('deal_signals', () => ({})));
app.get('/deals/:id', one((req) => deals(req).select(DEAL_FIELDS), 'Deal'));
app.get('/deals/:id/history', list((req) => crm(req).from('deal_history')
  .select('*, from_stage:stages!deal_history_from_stage_id_fkey(name), to_stage:stages!deal_history_to_stage_id_fkey(name)')
  .eq('deal_id', req.params.id)
  .eq('tenant_id', req.tenantId)
  .order('changed_at', { ascending: false })));
app.get('/deals/:id/profit', callCrm('deal_profit', (req) => ({ p_deal: req.params.id })));
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
  for (const link of ['contact_id', 'company_id', 'deal_id', 'lead_id']) {
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

// Planned calls, meetings, emails and tasks, for the activities list and calendar
app.get('/activities/schedule', list((req) => {
  let query = activities(req)
    .select(ACTIVITY_FIELDS)
    .eq('tenant_id', req.tenantId)
    .neq('kind', 'note')
    .order('due_on', { ascending: true, nullsFirst: false })
    .order('due_time', { ascending: true, nullsFirst: true })
    .limit(1000);
  if (req.query.from) query = query.gte('due_on', requiredDate(req.query.from));
  if (req.query.to) query = query.lte('due_on', requiredDate(req.query.to));
  if (req.query.done !== '1') query = query.is('done_at', null);
  if (req.query.owner) {
    if (!UUID.test(req.query.owner)) throw new Error('Choose a person');
    query = query.eq('owner_id', req.query.owner);
  }
  return query;
}));
app.post('/activities/:id/finish', callCrm('finish_activity', (req) => {
  const next = req.body.next;
  if (next !== undefined && next !== null && (typeof next !== 'object' || Array.isArray(next))) throw new Error('Choose the next step');
  return {
    p_activity: req.params.id,
    p_feedback: typeof req.body.feedback === 'string' ? req.body.feedback : null,
    p_next: next ? {
      kind: next.kind,
      subject: typeof next.subject === 'string' ? next.subject : '',
      due_on: parseDate(next.due_on),
      due_time: parseTime(next.due_time),
      owner_id: next.owner_id && UUID.test(next.owner_id) ? next.owner_id : null
    } : null
  };
}));

// Quotes
const QUOTE_FIELDS = '*, deal:deals(id, title), contact:contacts(id, name, email), company:companies(id, name)';

app.get('/quotes', list((req) => {
  const query = crm(req).from('quotes')
    .select(QUOTE_FIELDS)
    .eq('tenant_id', req.tenantId)
    .order('created_at', { ascending: false });
  return req.query.deal_id ? query.eq('deal_id', req.query.deal_id) : query;
}));
app.get('/quotes/:id', one((req) => crm(req).from('quotes').select(QUOTE_FIELDS), 'Quote'));
app.post('/quotes', callCrm('save_quote', (req) => ({
  p_quote: req.body.id || null,
  p_deal: optional(req.body.deal_id),
  p_contact: optional(req.body.contact_id),
  p_company: optional(req.body.company_id),
  p_issue: parseDate(req.body.issue_date),
  p_valid: parseDate(req.body.valid_until),
  p_due_days: req.body.due_days === '' || req.body.due_days === undefined ? null : Number(req.body.due_days),
  p_lines: req.body.line_items,
  p_notes: req.body.notes || null
})));
app.post('/quotes/:id/status', callCrm('set_quote_status', (req) => ({ p_quote: req.params.id, p_status: req.body.status })));
app.post('/quotes/:id/accept', callCrm('accept_quote', (req) => ({ p_quote: req.params.id })));
app.post('/quotes/:id/invoice', callCrm('reinvoice_quote', (req) => ({ p_quote: req.params.id })));
app.delete('/quotes/:id', callCrm('delete_quote', (req) => ({ p_quote: req.params.id })));

app.get('/billing', callCrm('billing', (req) => ({
  p_company: req.query.company_id || null,
  p_contact: req.query.contact_id || null
})));

// Automation
app.get('/automations', callCrm('automation_summary', () => ({})));
app.post('/automations', callCrm('save_automation', (req) => ({
  p_rule: req.body.id || null,
  p_name: req.body.name,
  p_event: req.body.event,
  p_stage: optional(req.body.stage_id),
  p_days: optionalNumber(req.body.days),
  p_source: optional(req.body.source),
  p_min_value: parseValue(req.body.min_value),
  p_actions: req.body.actions
})));
app.post('/automations/run', callCrm('run_automations_now', () => ({})));
app.post('/automations/task-reminders', callCrm('save_task_reminders', (req) => ({ p_enabled: Boolean(req.body.enabled) })));
app.post('/automations/:id/enabled', callCrm('set_automation_enabled', (req) => ({ p_rule: req.params.id, p_enabled: Boolean(req.body.enabled) })));
app.delete('/automations/:id', callCrm('delete_automation', (req) => ({ p_rule: req.params.id })));

// Alerts
app.get('/notifications', callCrm('my_notifications', () => ({})));
app.post('/notifications/read', callCrm('mark_notifications_read', (req) => ({
  p_ids: Array.isArray(req.body.ids) ? req.body.ids : null
})));

// Forecast and reports
app.get('/forecast', callCrm('forecast', (req) => ({
  p_from: parseMonth(req.query.from),
  p_to: parseMonth(req.query.to),
  p_pipeline: optional(req.query.pipeline)
})));
app.get('/reports/team', callCrm('team_report', (req) => ({
  p_from: requiredDate(req.query.from),
  p_to: requiredDate(req.query.to),
  p_pipeline: optional(req.query.pipeline)
})));
app.get('/targets', list((req) => crm(req).from('targets')
  .select('user_id, month, amount')
  .eq('tenant_id', req.tenantId)
  .eq('month', parseMonth(req.query.month))));
app.post('/targets', callCrm('save_targets', (req) => ({
  p_month: parseMonth(req.body.month),
  p_targets: Array.isArray(req.body.targets)
    ? req.body.targets.map(({ user_id, amount }) => ({ user_id: user_id || null, amount: amount ?? '' }))
    : []
})));

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

// Email. The database checks who may be emailed and the limits; the provider only sends.
const emailReady = () => Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);

// The company name shows as the sender, so nothing in it may break the header
const senderName = (name) => `"${String(name || 'Get-ly').replace(/["\\<>\r\n]/g, '').slice(0, 80)}"`;

const sendThroughProvider = async (email) => {
  try {
    const response = await fetch(process.env.EMAIL_API_URL || 'https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${senderName(email.from_name)} <${process.env.EMAIL_FROM}>`,
        to: [email.to],
        subject: email.subject,
        text: email.body,
        ...(email.reply_to ? { reply_to: email.reply_to } : {})
      }),
      signal: AbortSignal.timeout(15000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) return { error: result.message || `The email service answered ${response.status}` };
    return { id: result.id || null };
  } catch (error) {
    return { error: error.name === 'TimeoutError' ? 'The email service took too long to answer' : 'Could not reach the email service' };
  }
};

app.get('/emails/status', async (req, res) => {
  try {
    const { data, error } = await crm(req).rpc('email_usage', { p_tenant: req.tenantId });
    if (error) throw error;
    res.json({ configured: emailReady(), ...data });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/emails', async (req, res) => {
  try {
    if (!emailReady()) return res.status(503).json({ error: "Email sending isn't set up yet" });
    const { contact_id, lead_id, deal_id, to, subject, body } = req.body;
    const { data: email, error } = await crm(req).rpc('start_email', {
      p_tenant: req.tenantId,
      p_contact: optional(contact_id),
      p_lead: optional(lead_id),
      p_deal: optional(deal_id),
      p_to: optional(to),
      p_subject: typeof subject === 'string' ? subject : null,
      p_body: typeof body === 'string' ? body : null
    });
    if (error) throw error;

    const sent = await sendThroughProvider(email);
    const { data: result, error: finishError } = await crm(req).rpc('finish_email', {
      p_tenant: req.tenantId,
      p_email: email.id,
      p_provider_id: sent.id || null,
      p_error: sent.error || null
    });
    if (finishError) throw finishError;
    if (result.status === 'failed') return res.status(502).json({ error: `The email wasn't sent: ${result.error}` });
    res.status(201).json({ ...result, to: email.to });
  } catch (error) {
    sendError(res, error);
  }
});

const templates = (req) => crm(req).from('email_templates');
const templateFields = (body) => {
  if (body.name !== undefined && !String(body.name).trim()) throw new Error('Name the template');
  if (body.subject !== undefined && !String(body.subject).trim()) throw new Error('Enter a subject');
  if (body.body !== undefined && !String(body.body).trim()) throw new Error('Write the message');
  return pick(body, { name: (value) => String(value).trim(), subject: (value) => String(value).trim(), body: (value) => String(value) });
};
app.get('/email-templates', list((req) => templates(req).select('*').eq('tenant_id', req.tenantId).order('name')));
app.post('/email-templates', create(templates, '*', (body) => {
  if (!body.name || !body.subject || !body.body) throw new Error('A template needs a name, subject and message');
  return templateFields(body);
}));
app.put('/email-templates/:id', update(templates, '*', (body) => ({ ...templateFields(body), updated_at: new Date().toISOString() }), 'Template'));
app.delete('/email-templates/:id', remove(templates, 'Template'));

app.listen(PORT, () => console.log(`👥 CRM Service running on port ${PORT}`));
