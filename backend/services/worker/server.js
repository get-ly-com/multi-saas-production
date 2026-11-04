require('dotenv').config();
const express = require('express');

// Most background jobs run inside the database with pg_cron (webhook sending, cleanup, CRM rules).
// Owners and admins can see their status on the Integrations page.
// This worker has two jobs of its own. Every 15 minutes it asks the scheduler service to check
// everyone's own calendars for busy times. That needs the internet, so it can't run in the
// database. Without CALENDAR_SYNC_SECRET (the same value as on the scheduler service) that check
// is off. SCHEDULER_SERVICE_URL defaults to the private Railway address. Once a day it also starts
// the Business Brain (see below).
const app = express();

const BUSY_EVERY_MS = 15 * 60 * 1000;
const BUSY_TIMEOUT_MS = 5 * 60 * 1000;
const schedulerUrl = (process.env.SCHEDULER_SERVICE_URL
  || `http://${process.env.NODE_ENV === 'production' ? 'scheduler-service.railway.internal' : 'localhost'}:3006`).replace(/\/+$/, '');
const syncSecret = process.env.CALENDAR_SYNC_SECRET || '';
const busyJobOn = Boolean(schedulerUrl && syncSecret.length >= 16);

const busyJob = { on: busyJobOn, running: false, last_run_at: null, last_result: null, last_error: null };

const checkCalendars = async () => {
  if (busyJob.running) return;
  busyJob.running = true;
  busyJob.last_run_at = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BUSY_TIMEOUT_MS);
  try {
    const response = await fetch(`${schedulerUrl}/internal/busy-sync`, {
      method: 'POST',
      headers: { 'x-sync-secret': syncSecret, 'content-type': 'application/json' },
      body: '{}',
      signal: controller.signal
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Scheduler service answered ${response.status}`);
    busyJob.last_result = body;
    busyJob.last_error = null;
    if (body.checked) console.log(`Calendar busy times: checked ${body.checked}, problems ${body.failed || 0}`);
  } catch (error) {
    busyJob.last_error = error.name === 'AbortError' ? 'Timed out' : error.message;
    console.error('Calendar busy times check failed:', busyJob.last_error);
  } finally {
    clearTimeout(timer);
    busyJob.running = false;
  }
};

if (busyJobOn) {
  setTimeout(checkCalendars, 60 * 1000);
  setInterval(checkCalendars, BUSY_EVERY_MS);
} else {
  console.log('Calendar busy times check is off: set CALENDAR_SYNC_SECRET (16+ characters) to turn it on');
}

// ---- Business Brain: once a day ----
// Asks brain-service to think about every company (new ideas wait for an owner or admin to approve
// them in the app) and to check whether ideas carried out earlier worked. It runs at
// BRAIN_DAILY_HOUR_UTC (default 6, so about 06:00 UTC) and then every 24 hours. Without
// BRAIN_JOB_SECRET (the same value as on brain-service, 16+ characters) it is off.
// BRAIN_SERVICE_URL defaults to the private Railway address.
const brainUrl = (process.env.BRAIN_SERVICE_URL
  || `http://${process.env.NODE_ENV === 'production' ? 'brain-service.railway.internal' : 'localhost'}:3013`).replace(/\/+$/, '');
const brainSecret = process.env.BRAIN_JOB_SECRET || '';
const brainHour = Math.min(Math.max(Number.parseInt(process.env.BRAIN_DAILY_HOUR_UTC || '6', 10) || 0, 0), 23);
const brainJob = { on: Boolean(brainUrl && brainSecret.length >= 16), last_run_at: null, last_result: null, last_error: null, next_run_at: null };

const runBrain = async () => {
  brainJob.last_run_at = new Date().toISOString();
  try {
    const response = await fetch(`${brainUrl}/internal/think-all`, {
      method: 'POST',
      headers: { 'x-brain-secret': brainSecret, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(30 * 1000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Brain service answered ${response.status}`);
    brainJob.last_result = body;
    brainJob.last_error = null;
    console.log(`Business Brain daily run: ${body.started ? 'started' : 'already running'}`);
  } catch (error) {
    brainJob.last_error = error.name === 'TimeoutError' ? 'Timed out' : error.message;
    console.error('Business Brain daily run failed:', brainJob.last_error);
  }
};

const msUntilBrainHour = () => {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), brainHour, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
};

if (brainJob.on) {
  const wait = msUntilBrainHour();
  brainJob.next_run_at = new Date(Date.now() + wait).toISOString();
  setTimeout(() => {
    runBrain();
    setInterval(() => {
      brainJob.next_run_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      runBrain();
    }, 24 * 60 * 60 * 1000);
    brainJob.next_run_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }, wait);
} else {
  console.log('Business Brain daily run is off: set BRAIN_JOB_SECRET (16+ characters) to turn it on');
}

app.get('/health', (req, res) => res.json({
  status: 'ok',
  service: 'worker',
  jobs: 'Most background jobs run in the database with pg_cron.',
  calendar_busy_times: {
    on: busyJob.on,
    every_minutes: 15,
    running: busyJob.running,
    last_run_at: busyJob.last_run_at,
    last_result: busyJob.last_result,
    last_error: busyJob.last_error
  },
  business_brain: {
    on: brainJob.on,
    daily_at_utc: `${String(brainHour).padStart(2, '0')}:00`,
    next_run_at: brainJob.next_run_at,
    last_run_at: brainJob.last_run_at,
    last_result: brainJob.last_result,
    last_error: brainJob.last_error
  }
}));

const PORT = process.env.PORT || 3012;

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

app.listen(PORT, () => console.log(`Worker on ${PORT}`));
