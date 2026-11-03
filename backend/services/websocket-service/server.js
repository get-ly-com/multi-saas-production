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

app.listen(PORT, () => console.log(`WebSocket service (health only) on ${PORT}`));
