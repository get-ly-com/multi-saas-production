require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3001;

// Queries run as the signed-in user, so database policies apply to them
const supabaseFor = (authorization) =>
  createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false }
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'void'];
const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const invoices = (req) => req.db.schema('accounting').from('invoices');
const expenses = (req) => req.db.schema('accounting').from('expenses');
const accounts = (req) => req.db.schema('accounting').from('accounts');
const entries = (req) => req.db.schema('accounting').from('journal_entries');
const ledger = (req) => req.db.schema('accounting');

const sendError = (res, error) => {
  console.error('Accounting error:', error);
  if (error.code === '23505') {
    return res.status(409).json({ error: 'That number is already used' });
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

const nextInvoiceNumber = async (req) => {
  const { data, error } = await invoices(req)
    .select('invoice_number')
    .eq('tenant_id', req.tenantId)
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
  if (!UUID.test(req.tenantId || '') || !req.headers.authorization) {
    return res.status(400).json({ error: 'Missing tenant' });
  }
  req.db = supabaseFor(req.headers.authorization);
  next();
});

// Get invoices
app.get('/invoices', async (req, res) => {
  try {
    const { data, error } = await invoices(req)
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

    const { data, error } = await invoices(req)
      .insert([{
        tenant_id: req.tenantId,
        invoice_number: invoice_number || await nextInvoiceNumber(req),
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

    const { data, error } = await invoices(req)
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
    const { data, error } = await invoices(req)
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
    const { data, error } = await expenses(req)
      .select('*, account:accounts(id, code, name)')
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
    const { amount, category, description, expense_date, account_id } = req.body;
    const row = {
      tenant_id: req.tenantId,
      amount: parseAmount(amount),
      category: category || null,
      description: description || null,
      account_id: account_id || null
    };
    if (expense_date) row.expense_date = expense_date;

    const { data, error } = await expenses(req).insert([row]).select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (error) {
    sendError(res, error);
  }
});

// Update expense
app.put('/expenses/:id', async (req, res) => {
  try {
    const { amount, category, description, expense_date, account_id } = req.body;
    const updates = {};

    if (amount !== undefined) updates.amount = parseAmount(amount);
    if (category !== undefined) updates.category = category || null;
    if (description !== undefined) updates.description = description || null;
    if (expense_date) updates.expense_date = expense_date;
    if (account_id) updates.account_id = account_id;

    const { data, error } = await expenses(req)
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
    const { data, error } = await expenses(req)
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
    const { data, error } = await ledger(req).rpc('summary', { p_tenant: req.tenantId });
    if (error) throw error;
    res.json(data);
  } catch (error) {
    sendError(res, error);
  }
});

// Chart of accounts
app.get('/accounts', async (req, res) => {
  try {
    const { data, error } = await accounts(req)
      .select('*')
      .eq('tenant_id', req.tenantId)
      .order('code');

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/accounts', async (req, res) => {
  try {
    const { code, name, type } = req.body;
    if (!code || !name) throw new Error('Code and name are required');
    if (!ACCOUNT_TYPES.includes(type)) throw new Error('Choose an account type');

    const { data, error } = await accounts(req)
      .insert([{ tenant_id: req.tenantId, code, name, type }])
      .select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (error) {
    sendError(res, error);
  }
});

app.put('/accounts/:id', async (req, res) => {
  try {
    const { name, is_active } = req.body;
    const updates = {};

    if (name !== undefined) {
      if (!name) throw new Error('Name is required');
      updates.name = name;
    }
    if (is_active !== undefined) updates.is_active = Boolean(is_active);

    const { data, error } = await accounts(req)
      .update(updates)
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .select();

    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Account not found' });
    res.json(data[0]);
  } catch (error) {
    sendError(res, error);
  }
});

// Journal entries
app.get('/journal', async (req, res) => {
  try {
    const { data, error } = await entries(req)
      .select('*, lines:journal_lines(id, debit, credit, account:accounts(id, code, name))')
      .eq('tenant_id', req.tenantId)
      .order('entry_number', { ascending: false })
      .limit(200);

    if (error) throw error;

    const { data: reversals, error: reversalError } = await entries(req)
      .select('reversal_of')
      .eq('tenant_id', req.tenantId)
      .in('reversal_of', data.map((entry) => entry.id));

    if (reversalError) throw reversalError;

    const reversed = new Set(reversals.map((entry) => entry.reversal_of));
    res.json(data.map((entry) => ({ ...entry, reversed: reversed.has(entry.id) })));
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/journal', async (req, res) => {
  try {
    const { entry_date, memo, lines } = req.body;
    if (!DATE.test(entry_date || '')) throw new Error('Choose a date');

    const { data, error } = await ledger(req).rpc('create_journal_entry', {
      p_tenant: req.tenantId,
      p_date: entry_date,
      p_memo: memo,
      p_lines: lines
    });

    if (error) throw error;
    res.status(201).json({ id: data });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/journal/:id/reverse', async (req, res) => {
  try {
    const { data, error } = await ledger(req).rpc('reverse_journal_entry', {
      p_tenant: req.tenantId,
      p_entry: req.params.id
    });

    if (error) throw error;
    res.status(201).json({ id: data });
  } catch (error) {
    sendError(res, error);
  }
});

// Reports
app.get('/ledger/:accountId', async (req, res) => {
  try {
    const { data, error } = await ledger(req).rpc('account_ledger', {
      p_tenant: req.tenantId,
      p_account: req.params.accountId
    });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/trial-balance', async (req, res) => {
  try {
    const asOf = DATE.test(req.query.as_of || '') ? req.query.as_of : new Date().toISOString().slice(0, 10);
    const { data, error } = await ledger(req).rpc('trial_balance', { p_tenant: req.tenantId, p_as_of: asOf });

    if (error) throw error;
    res.json({ as_of: asOf, rows: data || [] });
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
