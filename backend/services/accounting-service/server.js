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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'void'];

const invoices = () => supabase.schema('accounting').from('invoices');
const expenses = () => supabase.schema('accounting').from('expenses');

const sendError = (res, error) => {
  console.error('Accounting error:', error);
  if (error.code === '23505') {
    return res.status(409).json({ error: 'That invoice number is already used' });
  }
  res.status(400).json({ error: error.message });
};

const toCents = (value) => Math.round(Number(value) * 100);

// The total is always worked out here, so it cannot disagree with the lines
const parseLineItems = (lineItems) => {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new Error('Add at least one line item');
  }

  const items = lineItems.map(({ description, quantity, unit_price }) => {
    const qty = Number(quantity);
    const price = Number(unit_price);
    if (!description || !(qty > 0) || !(price >= 0)) {
      throw new Error('Each line needs a description, quantity and price');
    }
    return { description, quantity: qty, unit_price: price };
  });

  const cents = items.reduce((sum, item) => sum + toCents(item.quantity * item.unit_price), 0);
  return { line_items: items, amount: cents / 100 };
};

const parseAmount = (value) => {
  const amount = Number(value);
  if (value === '' || value === null || value === undefined || !(amount >= 0)) {
    throw new Error('Enter a valid amount');
  }
  return amount;
};

const nextInvoiceNumber = async (tenantId) => {
  const { data, error } = await invoices()
    .select('invoice_number')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) throw error;
  const last = Number((data[0]?.invoice_number || '').replace(/\D/g, '')) || 0;
  return `INV-${String(last + 1).padStart(4, '0')}`;
};

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'accounting-service' });
});

// Only the gateway reaches this service, and it sets the tenant
app.use((req, res, next) => {
  req.tenantId = req.headers['x-tenant-id'];
  if (!UUID.test(req.tenantId || '')) {
    return res.status(400).json({ error: 'Missing tenant' });
  }
  next();
});

// Get invoices
app.get('/invoices', async (req, res) => {
  try {
    const { data, error } = await invoices()
      .select('*')
      .eq('tenant_id', req.tenantId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    sendError(res, error);
  }
});

// Create invoice
app.post('/invoices', async (req, res) => {
  try {
    const { customer_name, customer_email, due_date, description, invoice_number, line_items } = req.body;
    if (!customer_name) throw new Error('Customer name is required');

    const { data, error } = await invoices()
      .insert([{
        tenant_id: req.tenantId,
        invoice_number: invoice_number || await nextInvoiceNumber(req.tenantId),
        customer_name,
        customer_email: customer_email || null,
        due_date: due_date || null,
        description: description || null,
        status: 'draft',
        ...parseLineItems(line_items)
      }])
      .select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (error) {
    sendError(res, error);
  }
});

// Update invoice
app.put('/invoices/:id', async (req, res) => {
  try {
    const { customer_name, customer_email, due_date, description, status, line_items } = req.body;
    const updates = { updated_at: new Date().toISOString() };

    if (customer_name !== undefined) {
      if (!customer_name) throw new Error('Customer name is required');
      updates.customer_name = customer_name;
    }
    if (customer_email !== undefined) updates.customer_email = customer_email || null;
    if (due_date !== undefined) updates.due_date = due_date || null;
    if (description !== undefined) updates.description = description || null;
    if (line_items !== undefined) Object.assign(updates, parseLineItems(line_items));
    if (status !== undefined) {
      if (!INVOICE_STATUSES.includes(status)) throw new Error('Unknown invoice status');
      updates.status = status;
      updates.paid_at = status === 'paid' ? new Date().toISOString() : null;
    }

    const { data, error } = await invoices()
      .update(updates)
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .select();

    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Invoice not found' });
    res.json(data[0]);
  } catch (error) {
    sendError(res, error);
  }
});

// Delete invoice
app.delete('/invoices/:id', async (req, res) => {
  try {
    const { data, error } = await invoices()
      .delete()
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .select('id');

    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Invoice not found' });
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

// Get expenses
app.get('/expenses', async (req, res) => {
  try {
    const { data, error } = await expenses()
      .select('*')
      .eq('tenant_id', req.tenantId)
      .order('expense_date', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    sendError(res, error);
  }
});

// Create expense
app.post('/expenses', async (req, res) => {
  try {
    const { amount, category, description, expense_date } = req.body;
    const row = {
      tenant_id: req.tenantId,
      amount: parseAmount(amount),
      category: category || null,
      description: description || null
    };
    if (expense_date) row.expense_date = expense_date;

    const { data, error } = await expenses().insert([row]).select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (error) {
    sendError(res, error);
  }
});

// Update expense
app.put('/expenses/:id', async (req, res) => {
  try {
    const { amount, category, description, expense_date } = req.body;
    const updates = {};

    if (amount !== undefined) updates.amount = parseAmount(amount);
    if (category !== undefined) updates.category = category || null;
    if (description !== undefined) updates.description = description || null;
    if (expense_date) updates.expense_date = expense_date;

    const { data, error } = await expenses()
      .update(updates)
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .select();

    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Expense not found' });
    res.json(data[0]);
  } catch (error) {
    sendError(res, error);
  }
});

// Delete expense
app.delete('/expenses/:id', async (req, res) => {
  try {
    const { data, error } = await expenses()
      .delete()
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .select('id');

    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Expense not found' });
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

// Analytics endpoint
app.get('/analytics', async (req, res) => {
  try {
    const { data: invoiceRows, error: invError } = await invoices()
      .select('amount, status, due_date')
      .eq('tenant_id', req.tenantId);

    const { data: expenseRows, error: expError } = await expenses()
      .select('amount')
      .eq('tenant_id', req.tenantId);

    if (invError || expError) throw invError || expError;

    const total = (rows) => rows.reduce((sum, row) => sum + toCents(row.amount), 0) / 100;
    const today = new Date().toISOString().slice(0, 10);
    const sent = invoiceRows.filter((i) => i.status === 'sent');

    const revenue = total(invoiceRows.filter((i) => i.status === 'paid'));
    const totalExpenses = total(expenseRows);

    res.json({
      revenue,
      outstanding: total(sent),
      overdue: total(sent.filter((i) => i.due_date && i.due_date < today)),
      totalExpenses,
      netProfit: Math.round((revenue - totalExpenses) * 100) / 100,
      invoiceCount: invoiceRows.length,
      expenseCount: expenseRows.length
    });
  } catch (error) {
    sendError(res, error);
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
