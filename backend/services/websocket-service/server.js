require('dotenv').config();
const express = require('express');

// Live updates don't need a server of our own: Supabase Realtime (free) pushes table changes
// straight to the browser, and its row level security decides who sees what. This service
// only answers health checks and can be turned off.
const app = express();
const PORT = process.env.PORT || 3009;

app.get('/health', (req, res) => res.json({
  status: 'ok',
  service: 'websocket-service',
  note: 'Not used. Live updates come from Supabase Realtime.'
}));

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

app.listen(PORT, () => console.log(`WebSocket service (health only) on ${PORT}`));
