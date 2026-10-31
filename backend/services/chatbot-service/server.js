require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3004;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

app.use(express.json());
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'chatbot-service' }));

app.post('/chat', async (req, res) => {
  const { message, context } = req.body;
  const tenantId = req.headers['x-tenant-id'];

  // Placeholder for AI chat logic
  const response = {
    id: Math.random().toString(36).substring(7),
    message: `Echo: ${message}`,
    timestamp: new Date(),
    tenantId
  };

  res.json(response);
});

app.get('/conversations', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'];
  res.json([{ id: '1', tenantId, messages: [] }]);
});

app.listen(PORT, () => console.log(`🤖 Chatbot Service on ${PORT}`));
