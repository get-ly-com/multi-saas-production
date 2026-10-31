require('dotenv').config();
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3011;

app.use(express.json());
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'integration-service' }));

app.get('/webhooks', (req, res) => res.json([]));
app.post('/webhooks', (req, res) => res.status(201).json({ id: '1', ...req.body }));
app.post('/trigger', (req, res) => res.json({ success: true, eventId: Math.random().toString(36).substring(7) }));

app.listen(PORT, () => console.log(`🔗 Integration Service on ${PORT}`));
