require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'accounting-service' });
});

// Get invoices
app.get('/invoices', async (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'];
    const { data, error } = await supabase
      .schema('accounting').from('invoices')
      .select('*')
      .eq('tenant_id', tenantId);

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error('Error fetching invoices:', error);
    res.status(400).json({ error: error.message });
  }
});

// Create invoice
app.post('/invoices', async (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'];
    const { invoice_number, amount, status, description } = req.body;

    const { data, error } = await supabase
      .schema('accounting').from('invoices')
      .insert([{
        tenant_id: tenantId,
        invoice_number,
        amount,
        status: status || 'draft',
        description
      }])
      .select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (error) {
    console.error('Error creating invoice:', error);
    res.status(400).json({ error: error.message });
  }
});

// Update invoice
app.put('/invoices/:id', async (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'];
    const { id } = req.params;
    const updates = req.body;

    const { data, error } = await supabase
      .schema('accounting').from('invoices')
      .update(updates)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select();

    if (error) throw error;
    res.json(data[0]);
  } catch (error) {
    console.error('Error updating invoice:', error);
    res.status(400).json({ error: error.message });
  }
});

// Delete invoice
app.delete('/invoices/:id', async (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'];
    const { id } = req.params;

    const { error } = await supabase
      .schema('accounting').from('invoices')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId);

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting invoice:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get expenses
app.get('/expenses', async (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'];
    const { data, error } = await supabase
      .schema('accounting').from('expenses')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error('Error fetching expenses:', error);
    res.status(400).json({ error: error.message });
  }
});

// Create expense
app.post('/expenses', async (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'];
    const { amount, category, description } = req.body;

    const { data, error } = await supabase
      .schema('accounting').from('expenses')
      .insert([{
        tenant_id: tenantId,
        amount,
        category,
        description
      }])
      .select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (error) {
    console.error('Error creating expense:', error);
    res.status(400).json({ error: error.message });
  }
});

// Analytics endpoint
app.get('/analytics', async (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'];

    const { data: invoices, error: invError } = await supabase
      .schema('accounting').from('invoices')
      .select('amount, status')
      .eq('tenant_id', tenantId);

    const { data: expenses, error: expError } = await supabase
      .schema('accounting').from('expenses')
      .select('amount, category')
      .eq('tenant_id', tenantId);

    if (invError || expError) throw invError || expError;

    const totalInvoiced = invoices?.reduce((sum, i) => sum + (i.amount || 0), 0) || 0;
    const totalExpenses = expenses?.reduce((sum, e) => sum + (e.amount || 0), 0) || 0;

    res.json({
      totalInvoiced,
      totalExpenses,
      netProfit: totalInvoiced - totalExpenses,
      invoiceCount: invoices?.length || 0,
      expenseCount: expenses?.length || 0
    });
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(400).json({ error: error.message });
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`📊 Accounting Service running on port ${PORT}`);
});
