require('dotenv').config();
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3008;

app.use(express.json());
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'social-media-service' }));

app.get('/posts', (req, res) => res.json([]));
app.post('/posts', (req, res) => res.status(201).json({ id: '1', ...req.body, createdAt: new Date() }));
app.post('/publish', (req, res) => res.json({ success: true, platforms: ['instagram', 'twitter', 'facebook'] }));

app.listen(PORT, () => console.log(`📱 Social Media Service on ${PORT}`));
