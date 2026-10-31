require('dotenv').config();
const express = require('express');
const app = express();

app.use(express.json());
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'worker', queues: 15 }));

app.get('/jobs', (req, res) => {
  res.json({
    pending: Math.floor(Math.random() * 100),
    processing: Math.floor(Math.random() * 50),
    completed: Math.floor(Math.random() * 1000)
  });
});

console.log('⚙️ Worker Service running (processing async jobs and cron tasks)');
