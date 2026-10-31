require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3002;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEAL_STAGES = ['prospecting', 'qualified', 'proposal', 'won', 'lost'];

const contacts = () => supabase.schema('crm').from('contacts');
const deals = () => supabase.schema('crm').from('deals');

// A deal may only point at a contact in the same company
const assertContactInTenant = async (contactId, tenantId) => {
  if (!contactId) return;
  const { data, error } = await contacts()
    .select('id')
    .eq('id', contactId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error('Contact not found');
};

const parseValue = (value) => {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!(parsed >= 0)) throw new Error('Enter a valid deal value');
  return parsed;
};

app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'crm-service' }));

// Only the gateway reaches this service, and it sets the tenant
app.use((req, res, next) => {
  req.tenantId = req.headers['x-tenant-id'];
  if (!UUID.test(req.tenantId || '')) {
    return res.status(400).json({ error: 'Missing tenant' });
  }
  next();
});

// Contacts endpoints
app.get('/contacts', async (req, res) => {
  try {
    const { data, error } = await contacts()
      .select('*')
      .eq('tenant_id', req.tenantId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/contacts', async (req, res) => {
  try {
    const { name, email, phone, company, notes } = req.body;
    if (!name) throw new Error('Name is required');

    const { data, error } = await contacts()
      .insert([{ tenant_id: req.tenantId, name, email, phone, company, notes }])
      .select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/contacts/:id', async (req, res) => {
  try {
    const { name, email, phone, company, notes } = req.body;
    if (name !== undefined && !name) throw new Error('Name is required');

    const { data, error } = await contacts()
      .update({ name, email, phone, company, notes, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .select();

    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Contact not found' });
    res.json(data[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/contacts/:id', async (req, res) => {
  try {
    const { data, error } = await contacts()
      .delete()
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .select('id');

    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Contact not found' });
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Deals endpoints
app.get('/deals', async (req, res) => {
  try {
    const { data, error } = await deals()
      .select('*, contact:contacts(id, name, company)')
      .eq('tenant_id', req.tenantId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/deals', async (req, res) => {
  try {
    const { contact_id, title, value, stage } = req.body;
    if (!title) throw new Error('Title is required');
    if (stage && !DEAL_STAGES.includes(stage)) throw new Error('Unknown deal stage');
    await assertContactInTenant(contact_id, req.tenantId);

    const { data, error } = await deals()
      .insert([{
        tenant_id: req.tenantId,
        contact_id: contact_id || null,
        title,
        value: parseValue(value),
        stage: stage || 'prospecting'
      }])
      .select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/deals/:id', async (req, res) => {
  try {
    const { contact_id, title, value, stage } = req.body;
    const updates = { updated_at: new Date().toISOString() };

    if (title !== undefined) {
      if (!title) throw new Error('Title is required');
      updates.title = title;
    }
    if (value !== undefined) updates.value = parseValue(value);
    if (stage !== undefined) {
      if (!DEAL_STAGES.includes(stage)) throw new Error('Unknown deal stage');
      updates.stage = stage;
    }
    if (contact_id !== undefined) {
      await assertContactInTenant(contact_id, req.tenantId);
      updates.contact_id = contact_id || null;
    }

    const { data, error } = await deals()
      .update(updates)
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .select();

    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Deal not found' });
    res.json(data[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/deals/:id', async (req, res) => {
  try {
    const { data, error } = await deals()
      .delete()
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .select('id');

    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Deal not found' });
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.listen(PORT, () => console.log(`👥 CRM Service running on port ${PORT}`));
