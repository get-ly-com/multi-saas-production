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

// Only our own messages and the ones our database functions raise (P0001) reach people
const sendError = (res, error) => {
  const code = error?.code || '';
  if (error?.status) return res.status(error.status).json({ error: error.message });
  if (!code && error?.constructor === Error) return res.status(400).json({ error: error.message });
  if (code === 'P0001') return res.status(400).json({ error: error.message });
  if (/^PT[45]\d\d$/.test(code)) return res.status(Number(code.slice(2))).json({ error: error.message });

  console.error('Scheduler error:', error);
  if (code === '42501') return res.status(403).json({ error: 'You don’t have access to that' });
  if (code === '22P02') return res.status(404).json({ error: 'Not found' });
  if (code === '23503') return res.status(409).json({ error: 'This is in use. Turn it off instead of deleting it.' });
  if (code === '23505') return res.status(409).json({ error: 'That is already saved' });
  if (code === '23P01') return res.status(409).json({ error: 'That time is already booked. Please pick another time.' });
  if (code === '23514') return res.status(400).json({ error: 'That value isn’t allowed' });
  res.status(400).json({ error: 'That didn’t work. Please check and try again.' });
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
  notes: text(body.notes, 2000).trim(),
  answers: answers(body.answers)
});

// Answers to a service's questions: { question id: answer }. The database checks them.
const QUESTION_ID = /^[a-z0-9]{6,16}$/;
const answers = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const kept = {};
  for (const [key, answer] of Object.entries(value).slice(0, 10)) {
    if (QUESTION_ID.test(key) && (typeof answer === 'string' || typeof answer === 'number')) kept[key] = String(answer).slice(0, 2000);
  }
  return kept;
};

const QUESTION_KINDS = ['text', 'long', 'choice', 'yes_no'];
const questions = (value) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 10) throw new Error('Add up to 10 questions');
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Each question needs a label');
    if (!QUESTION_KINDS.includes(item.kind || 'text')) throw new Error('Choose the kind of answer for each question');
    const options = Array.isArray(item.options) ? item.options.slice(0, 20).map((option) => text(option, 100).trim()) : [];
    return {
      ...(QUESTION_ID.test(item.id || '') ? { id: item.id } : {}),
      label: text(item.label, 200).trim(),
      kind: item.kind || 'text',
      required: item.required === true,
      options
    };
  });
};

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
    capacity: whole(body.capacity || 1, 'Places', 1, 200),
    questions: questions(body.questions),
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
    welcome: text(req.body.welcome, 1000),
    draft_invoices: req.body.draft_invoices === undefined ? true : Boolean(req.body.draft_invoices)
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
  // Characters that would change the .or() filter or act as wildcards
  const search = text(req.query.search, 100).replace(/[%_,()*\\"]/g, ' ').trim();
  let query = req.db.schema('crm').from('contacts').select('id, name, email, phone').eq('tenant_id', req.tenantId);
  if (search) query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
  return rows(query.order('name').limit(20));
}));

const bookingData = (body) => ({
  service_id: id(body.service_id, 'Service'),
  staff_id: id(body.staff_id, 'Team member'),
  date: date(body.date, 'Choose a date'),
  time: time(body.time, 'Choose a time'),
  contact_id: optionalId(body.contact_id, 'Contact') || '',
  ...customer(body),
  // Set only after the person saw the warning that someone is on leave or the company is closed
  override_away: body.override_away === true ? 'true' : ''
});

// One booking, or the same booking every 1, 2 or 4 weeks (dates that can't be booked are skipped and listed)
app.post('/bookings', async (req, res) => {
  try {
    const repeat = req.body.repeat;
    if (repeat && repeat.every_weeks) {
      if (!['1', '2', '4'].includes(String(repeat.every_weeks))) throw new Error('Choose how often it repeats');
      const data = await call(req, 'create_repeat_bookings', {
        p_data: { ...bookingData(req.body), every_weeks: String(repeat.every_weeks), times: whole(repeat.times, 'Times', 2, 26) }
      });
      return res.status(201).json(data);
    }
    res.status(201).json(await call(req, 'create_booking', { p_data: bookingData(req.body) }));
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/bookings/:id/reschedule', callScheduler('reschedule_booking', (req) => ({
  p_booking: id(req.params.id, 'Booking'),
  p_data: {
    date: date(req.body.date, 'Choose a date'),
    time: time(req.body.time, 'Choose a time'),
    staff_id: optionalId(req.body.staff_id, 'Team member') || '',
    override_away: req.body.override_away === true ? 'true' : ''
  }
})));

app.post('/bookings/:id/cancel', callScheduler('cancel_booking', (req) => ({
  p_booking: id(req.params.id, 'Booking'),
  p_reason: text(req.body.reason, 500).trim() || null
})));

// This booking and the later ones in its repeat
app.post('/bookings/:id/cancel-repeats', callScheduler('cancel_repeats', (req) => ({
  p_booking: id(req.params.id, 'Booking'),
  p_reason: text(req.body.reason, 500).trim() || null
})));

// Attended or no-show, once the booking has started. An empty value clears it.
app.post('/bookings/:id/attendance', callScheduler('mark_attendance', (req) => {
  const value = req.body.value ?? '';
  if (!['attended', 'no_show', ''].includes(value)) throw new Error('Choose attended or no-show');
  return { p_booking: id(req.params.id, 'Booking'), p_value: value };
}));

// We don't send reminders, so staff tick off who they have reminded
app.post('/bookings/:id/reminded', callScheduler('mark_reminded', (req) => ({
  p_booking: id(req.params.id, 'Booking'),
  p_done: req.body.done !== false
})));

// Who to remind in the next 2 days, and past bookings still to mark
app.get('/follow-up', callScheduler('follow_up', (req) => ({ p_staff: optionalId(req.query.staff, 'Team member') })));

// Booking numbers for a date range
app.get('/stats', callScheduler('stats', (req) => ({
  p_from: date(req.query.from, 'Choose a start date'),
  p_to: date(req.query.to, 'Choose an end date')
})));

// The signed-in person's private calendar feed link
app.get('/feed', callScheduler('feed_link', () => ({})));
app.post('/feed', callScheduler('new_feed_link', () => ({})));
app.delete('/feed', callScheduler('stop_feed_link', () => ({})));

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

app.listen(PORT, () => console.log(`📅 Scheduler Service on ${PORT}`));
