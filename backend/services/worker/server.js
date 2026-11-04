require('dotenv').config();
const express = require('express');

// Background jobs run inside the database with pg_cron (webhook sending, cleanup, CRM rules),
// so this service has no work to do. It only answers health checks and can be turned off.
// Owners and admins can see the jobs' status on the Integrations page.
const app = express();

app.get('/health', (req, res) => res.json({
  status: 'ok',
  service: 'worker',
  jobs: 'Background jobs run in the database with pg_cron. This service is not needed.'
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

app.listen(PORT, () => console.log(`Worker (health only) on ${PORT}`));
