require('dotenv').config();
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3006;

app.use(express.json());
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'scheduler-service' }));

app.get('/appointments', (req, res) => {
  const tenantId = req.headers['x-tenant-id'];
  res.json([]);
});

app.post('/appointments', (req, res) => {
  const { title, startTime, endTime } = req.body;
  res.status(201).json({ id: Math.random().toString(36).substring(7), title, startTime, endTime });
});

app.listen(PORT, () => console.log(`📅 Scheduler Service on ${PORT}`));
