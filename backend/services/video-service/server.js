require('dotenv').config();
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3005;

app.use(express.json());
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'video-service' }));

app.post('/rooms', (req, res) => {
  const roomId = Math.random().toString(36).substring(7);
  res.status(201).json({ roomId, createdAt: new Date() });
});

app.get('/rooms/:roomId', (req, res) => {
  res.json({ roomId: req.params.roomId, participants: [] });
});

app.listen(PORT, () => console.log(`📹 Video Service on ${PORT}`));
