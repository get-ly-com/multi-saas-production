require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3005;

// Video meetings run on Jitsi Meet (meet.jit.si), which is free and needs no key. The database
// makes each room link with a long random part, and checks the person's role on every change.
const supabaseFor = (authorization) =>
  createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false }
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const sendError = (res, error) => {
  if (error.status) return res.status(error.status).json({ error: error.message });
  res.status(400).json({ error: error.message });
};

const id = (value, label) => {
  if (!UUID.test(value || '')) throw new Error(`${label} not found`);
  return value;
};

const text = (value, max) => {
  if (value === null || value === undefined) return '';
  return String(value).slice(0, max);
};

const contactIds = (value) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 25) throw new Error('Invite up to 25 contacts');
  return value.map((item) => id(item, 'Contact'));
};

const duration = (value) => {
  const minutes = Number(value ?? 30);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 720) throw new Error('Length must be between 5 and 720 minutes');
  return String(minutes);
};

const meetingFields = (body) => {
  if (typeof body.date !== 'string' || !DATE.test(body.date)) throw new Error('Choose a date');
  if (typeof body.time !== 'string' || !TIME.test(body.time)) throw new Error('Choose a time');
  return {
    title: text(body.title, 200).trim(),
    date: body.date,
    time: body.time,
    duration_minutes: duration(body.duration_minutes),
    notes: text(body.notes, 2000),
    contact_ids: contactIds(body.contact_ids)
  };
};

const call = (name, params, status = 200) => async (req, res) => {
  try {
    const { data, error } = await req.db.schema('scheduler').rpc(name, { p_tenant: req.tenantId, ...params(req) });
    if (error) throw error;
    res.status(status).json(data ?? { success: true });
  } catch (error) {
    sendError(res, error);
  }
};

app.use(express.json({ limit: '64kb' }));
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'video-service' }));

// Only the gateway reaches this service, and it sets the tenant
app.use((req, res, next) => {
  req.tenantId = req.headers['x-tenant-id'];
  if (!UUID.test(req.tenantId || '') || !req.headers.authorization) {
    return res.status(400).json({ error: 'Missing tenant' });
  }
  req.db = supabaseFor(req.headers.authorization);
  next();
});

// Upcoming meetings, or past and cancelled ones with ?past=true
app.get('/meetings', call('list_meetings', (req) => ({ p_past: req.query.past === 'true' })));

app.post('/meetings', call('create_meeting', (req) => ({ p_data: { ...meetingFields(req.body), now: false } }), 201));

// "Start now": a room that opens straight away
app.post('/meetings/now', call('create_meeting', (req) => ({
  p_data: { now: true, title: text(req.body.title, 200).trim(), duration_minutes: duration(req.body.duration_minutes),
    contact_ids: contactIds(req.body.contact_ids) }
}), 201));

app.put('/meetings/:id', call('update_meeting', (req) => ({ p_meeting: id(req.params.id, 'Meeting'), p_data: meetingFields(req.body) })));
app.post('/meetings/:id/cancel', call('cancel_meeting', (req) => ({ p_meeting: id(req.params.id, 'Meeting') })));

// CRM contacts to invite
app.get('/contacts', async (req, res) => {
  try {
    const search = text(req.query.search, 100).replace(/[%_,()]/g, ' ').trim();
    let query = req.db.schema('crm').from('contacts').select('id, name, email').eq('tenant_id', req.tenantId);
    if (search) query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
    const { data, error } = await query.order('name').limit(20);
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    sendError(res, error);
  }
});

app.listen(PORT, () => console.log(`🎥 Video Service on ${PORT}`));
