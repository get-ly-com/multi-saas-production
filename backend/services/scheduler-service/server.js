require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3006;

// Queries run as the signed-in user, so database policies apply to them. Every change goes
// through a database function that checks the person's role and refuses double bookings.
const supabaseFor = (authorization) =>
  createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false }
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const LOCATIONS = ['in_person', 'phone', 'video'];

const scheduler = (req) => req.db.schema('scheduler');

const sendError = (res, error) => {
  if (error.status) return res.status(error.status).json({ error: error.message });
  if (error.code === '23505') return res.status(409).json({ error: 'That is already saved' });
  if (error.code === '23503') return res.status(409).json({ error: 'This is in use. Turn it off instead of deleting it.' });
  if (error.code === '23P01') return res.status(409).json({ error: 'That time is already booked. Please pick another time.' });
  res.status(400).json({ error: error.message });
};

const id = (value, label) => {
  if (!UUID.test(value || '')) throw new Error(`${label} not found`);
  return value;
};

const optionalId = (value, label) => (value === '' || value === null || value === undefined ? null : id(value, label));

const date = (value, message) => {
  if (typeof value !== 'string' || !DATE.test(value)) throw new Error(message);
  return value;
};

const time = (value, message) => {
  if (typeof value !== 'string' || !TIME.test(value)) throw new Error(message);
  return value;
};

const text = (value, max) => {
  if (value === null || value === undefined) return '';
  return String(value).slice(0, max);
};

const whole = (value, label, min, max) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${label} must be between ${min} and ${max}`);
  return String(parsed);
};

const ids = (value, label) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 50) throw new Error(`Choose who ${label}`);
  return value.map((item) => id(item, 'Person'));
};

const call = async (req, name, params) => {
  const { data, error } = await scheduler(req).rpc(name, { p_tenant: req.tenantId, ...params });
  if (error) throw error;
  return data ?? { success: true };
};

const callScheduler = (name, params, status = 200) => async (req, res) => {
  try {
    res.status(status).json(await call(req, name, params(req)));
  } catch (error) {
    sendError(res, error);
  }
};

const handle = (work) => async (req, res) => {
  try {
    res.json(await work(req));
  } catch (error) {
    sendError(res, error);
  }
};

const rows = async (query) => {
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
};

const customer = (body) => ({
  name: text(body.name, 200).trim(),
  email: text(body.email, 254).trim(),
  phone: text(body.phone, 40).trim(),
  notes: text(body.notes, 2000).trim()
});

const serviceFields = (body) => {
  if (!LOCATIONS.includes(body.location_type)) throw new Error('Choose where it happens');
  const price = body.price === '' || body.price === null || body.price === undefined ? '' : String(body.price).trim();
  if (price && !/^\d{1,9}(\.\d{1,2})?$/.test(price)) throw new Error('Enter a valid price');
  return {
    name: text(body.name, 100).trim(),
    description: text(body.description, 1000),
    duration_minutes: whole(body.duration_minutes, 'Length in minutes', 5, 480),
    buffer_minutes: whole(body.buffer_minutes || 0, 'Buffer in minutes', 0, 240),
    price,
    location_type: body.location_type,
    location_detail: text(body.location_detail, 300),
    staff_ids: ids(body.staff_ids, 'offers it'),
    ...(body.is_active === undefined ? {} : { is_active: Boolean(body.is_active) })
  };
};

app.use(express.json({ limit: '128kb' }));
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'scheduler-service' }));

// Only the gateway reaches this service, and it sets the tenant
app.use((req, res, next) => {
  req.tenantId = req.headers['x-tenant-id'];
  if (!UUID.test(req.tenantId || '') || !req.headers.authorization) {
    return res.status(400).json({ error: 'Missing tenant' });
  }
  req.db = supabaseFor(req.headers.authorization);
  next();
});

// Role, settings (with the booking link key), the team and their weekly hours
app.get('/overview', callScheduler('overview', () => ({})));

// Settings. Owners and admins only.
app.put('/settings', callScheduler('save_settings', (req) => ({
  p_data: {
    time_zone: text(req.body.time_zone, 64).trim() || 'UTC',
    booking_enabled: req.body.booking_enabled === undefined ? true : Boolean(req.body.booking_enabled),
    min_notice_minutes: whole(req.body.min_notice_minutes ?? 0, 'Minimum notice in minutes', 0, 43200),
    max_days_ahead: whole(req.body.max_days_ahead ?? 60, 'Days ahead', 1, 365),
    slot_step_minutes: whole(req.body.slot_step_minutes ?? 30, 'Start times every', 5, 120),
    welcome: text(req.body.welcome, 1000)
  }
})));
app.post('/settings/new-key', callScheduler('new_booking_key', () => ({})));

// Services people can book
app.get('/services', handle((req) =>
  rows(scheduler(req).from('services').select('*').eq('tenant_id', req.tenantId).order('name'))));
app.post('/services', callScheduler('save_service', (req) => ({ p_service: null, p_data: serviceFields(req.body) }), 201));
app.put('/services/:id', callScheduler('save_service', (req) => ({
  p_service: id(req.params.id, 'Service'),
  p_data: serviceFields(req.body)
})));
app.delete('/services/:id', callScheduler('delete_service', (req) => ({ p_service: id(req.params.id, 'Service') })));

// A team member's name for visitors, whether they take bookings, and their weekly hours
app.put('/staff/:userId', callScheduler('save_staff', (req) => {
  const hours = req.body.hours ?? [];
  if (!Array.isArray(hours) || hours.length > 28) throw new Error('Enter up to four blocks of hours a day');
  return {
    p_user: id(req.params.userId, 'Team member'),
    p_data: {
      display_name: text(req.body.display_name, 100).trim(),
      is_bookable: req.body.is_bookable === undefined ? true : Boolean(req.body.is_bookable),
      hours: hours.map((block) => {
        const weekday = Number(block?.weekday);
        if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error('Choose a day of the week');
        const end = block?.end === '24:00' ? '24:00' : time(block?.end, 'Enter hours like 09:00 to 17:00');
        return { weekday: String(weekday), start: time(block?.start, 'Enter hours like 09:00 to 17:00'), end };
      })
    }
  };
}));

// Days off. No person means the whole company is closed.
app.get('/days-off', handle((req) => {
  let query = scheduler(req).from('days_off').select('*').eq('tenant_id', req.tenantId);
  if (req.query.from) query = query.gte('off_date', date(req.query.from, 'Choose a valid date'));
  return rows(query.order('off_date').limit(500));
}));
app.post('/days-off', callScheduler('add_day_off', (req) => ({
  p_user: optionalId(req.body.user_id, 'Team member'),
  p_date: date(req.body.off_date, 'Choose a date'),
  p_note: text(req.body.note, 200).trim() || null
}), 201));
app.delete('/days-off/:id', callScheduler('delete_day_off', (req) => ({ p_day: id(req.params.id, 'Day off') })));

// Bookings and meetings for a run of days, in the company's time zone
app.get('/calendar', callScheduler('calendar', (req) => {
  const days = Number(req.query.days || 7);
  if (!Number.isInteger(days) || days < 1 || days > 42) throw new Error('Choose up to 6 weeks');
  return {
    p_from: date(req.query.from, 'Choose a start date'),
    p_days: days,
    p_staff: optionalId(req.query.staff, 'Team member'),
    p_cancelled: req.query.cancelled === 'true'
  };
}));

// Free start times on one day, for booking by hand or moving a booking
app.get('/free-times', callScheduler('free_times', (req) => ({
  p_service: id(req.query.service, 'Service'),
  p_staff: optionalId(req.query.staff, 'Team member'),
  p_date: date(req.query.date, 'Choose a date'),
  p_booking: optionalId(req.query.booking, 'Booking')
})));

// CRM contacts to link a booking to
app.get('/contacts', handle((req) => {
  const search = text(req.query.search, 100).replace(/[%_,()]/g, ' ').trim();
  let query = req.db.schema('crm').from('contacts').select('id, name, email, phone').eq('tenant_id', req.tenantId);
  if (search) query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
  return rows(query.order('name').limit(20));
}));

app.post('/bookings', callScheduler('create_booking', (req) => ({
  p_data: {
    service_id: id(req.body.service_id, 'Service'),
    staff_id: id(req.body.staff_id, 'Team member'),
    date: date(req.body.date, 'Choose a date'),
    time: time(req.body.time, 'Choose a time'),
    contact_id: optionalId(req.body.contact_id, 'Contact') || '',
    ...customer(req.body)
  }
}), 201));

app.post('/bookings/:id/reschedule', callScheduler('reschedule_booking', (req) => ({
  p_booking: id(req.params.id, 'Booking'),
  p_data: {
    date: date(req.body.date, 'Choose a date'),
    time: time(req.body.time, 'Choose a time'),
    staff_id: optionalId(req.body.staff_id, 'Team member') || ''
  }
})));

app.post('/bookings/:id/cancel', callScheduler('cancel_booking', (req) => ({
  p_booking: id(req.params.id, 'Booking'),
  p_reason: text(req.body.reason, 500).trim() || null
})));

app.listen(PORT, () => console.log(`📅 Scheduler Service on ${PORT}`));
