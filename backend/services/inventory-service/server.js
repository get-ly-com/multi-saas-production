require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3003;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

app.use(express.json());
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'inventory-service' }));

app.get('/items', async (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'];
    const { data, error } = await supabase.schema('inventory').from('items').select('*').eq('tenant_id', tenantId);
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/items', async (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'];
    const { sku, name, quantity, price } = req.body;
    const { data, error } = await supabase.schema('inventory').from('items').insert([{ tenant_id: tenantId, sku, name, quantity: quantity || 0, price }]).select();
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch('/items/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.headers['x-tenant-id'];
    const { data, error } = await supabase.schema('inventory').from('items').update(req.body).eq('id', id).eq('tenant_id', tenantId).select();
    if (error) throw error;
    res.json(data[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.listen(PORT, () => console.log(`📦 Inventory Service on ${PORT}`));
