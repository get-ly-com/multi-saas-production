require('dotenv').config();
const express = require('express');

// Most background jobs run inside the database with pg_cron (webhook sending, cleanup, CRM rules).
// Owners and admins can see their status on the Integrations page.
// This worker has one job of its own: every 15 minutes it asks the scheduler service to check
// everyone's own calendars for busy times. That needs the internet, so it can't run in the
// database. Without CALENDAR_SYNC_SECRET (the same value as on the scheduler service) it only
// answers health checks. SCHEDULER_SERVICE_URL defaults to the private Railway address.
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
