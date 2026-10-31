require('dotenv').config();
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3010;

app.use(express.json());
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'analytics-service' }));

app.get('/metrics', (req, res) => {
  res.json({
    activeUsers: Math.floor(Math.random() * 1000),
    revenue: Math.floor(Math.random() * 100000),
    engagement: Math.random() * 100
  });
});

app.post('/events', (req, res) => {
  res.json({ success: true, eventId: Math.random().toString(36).substring(7) });
});

app.listen(PORT, () => console.log(`📊 Analytics Service on ${PORT}`));
