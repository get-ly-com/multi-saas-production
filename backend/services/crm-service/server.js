require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3002;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'crm-service' }));

// Contacts endpoints
app.get('/contacts', async (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'];
    const { data, error } = await supabase
      .from('crm.contacts')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/contacts', async (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'];
    const { name, email, phone, company } = req.body;

    const { data, error } = await supabase
      .from('crm.contacts')
      .insert([{ tenant_id: tenantId, name, email, phone, company }])
      .select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Deals endpoints
app.get('/deals', async (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'];
    const { data, error } = await supabase
      .from('crm.deals')
      .select('*, contact:crm.contacts(*)')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/deals', async (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'];
    const { contact_id, title, value, stage } = req.body;

    const { data, error } = await supabase
      .from('crm.deals')
      .insert([{ tenant_id: tenantId, contact_id, title, value, stage: stage || 'prospecting' }])
      .select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.listen(PORT, () => console.log(`👥 CRM Service running on port ${PORT}`));
