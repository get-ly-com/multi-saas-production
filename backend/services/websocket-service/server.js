require('dotenv').config();
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3009;

app.use(express.json());
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'websocket-service' }));

// WebSocket simulation
app.get('/connect', (req, res) => {
  res.json({ wsUrl: `ws://websocket-service:${PORT}`, connectionId: Math.random().toString(36).substring(7) });
});

app.listen(PORT, () => console.log(`🔌 WebSocket Service on ${PORT}`));
