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
// Partial and paid come from payments, which the database works out
const INVOICE_STATUSES = ['sent', 'void'];
const BILL_STATUSES = ['open', 'void'];
const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const invoices = (req) => req.db.schema('accounting').from('invoices');
const expenses = (req) => req.db.schema('accounting').from('expenses');
const accounts = (req) => req.db.schema('accounting').from('accounts');
const entries = (req) => req.db.schema('accounting').from('journal_entries');
const bills = (req) => req.db.schema('accounting').from('bills');
const taxRates = (req) => req.db.schema('accounting').from('tax_rates');
const ledger = (req) => req.db.schema('accounting');

const sendError = (res, error) => {
  console.error('Accounting error:', error);
  if (error.code === '23505') {
    return res.status(409).json({ error: 'That number is already used' });
  }
  res.status(400).json({ error: error.message });
};

// The database works out totals and tax from these lines
const parseLineItems = (lineItems) => {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new Error('Add at least one line item');
  }

  return lineItems.map(({ description, quantity, unit_price, tax_rate_id }) => {
    const qty = Number(quantity);
    const price = Number(unit_price);
    if (!description || !(qty > 0) || !(price >= 0)) {
      throw new Error('Each line needs a description, quantity and price');
    }
    return { description, quantity: qty, unit_price: price, tax_rate_id: tax_rate_id || null };
  });
};

const parseAmount = (value) => {
  const amount = Number(value);
  if (value === '' || value === null || value === undefined || !(amount >= 0)) {
    throw new Error('Enter a valid amount');
  }
  return amount;
};

const parseBillLines = (lineItems) => {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new Error('Add at least one line');
  }

  return lineItems.map(({ description, account_id, amount, tax_rate_id }) => {
    if (!UUID.test(account_id || '') || !(Number(amount) > 0)) {
      throw new Error('Each line needs an account and an amount');
    }
    return { description: description || null, account_id, amount: Number(amount), tax_rate_id: tax_rate_id || null };
  });
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

// Bank statement imports can be a few thousand lines
app.use(express.json({ limit: '2mb' }));

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

// Get one invoice with what has been paid and credited
app.get('/invoices/:id', async (req, res) => {
  try {
    const { data, error } = await invoices(req)
      .select('*, payments(*, account:accounts(code, name)), credit_notes(*)')
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Invoice not found' });
    res.json(data);
  } catch (error) {
    sendError(res, error);
  }
});

// Create invoice
app.post('/invoices', async (req, res) => {
  try {
    const { customer_id, invoice_date, due_date, description, invoice_number, line_items } = req.body;
    if (!UUID.test(customer_id || '')) throw new Error('Choose a customer');

    const row = {
      tenant_id: req.tenantId,
      invoice_number: invoice_number || await nextInvoiceNumber(req),
      customer_id,
      due_date: due_date || null,
      description: description || null,
      amount: 0,
      line_items: parseLineItems(line_items)
    };
    if (invoice_date) row.invoice_date = invoice_date;

    const { data, error } = await invoices(req).insert([row]).select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (error) {
    sendError(res, error);
  }
});

// Update invoice
app.put('/invoices/:id', async (req, res) => {
  try {
    const { customer_id, invoice_date, due_date, description, status, line_items } = req.body;
    const updates = { updated_at: new Date().toISOString() };

    if (customer_id !== undefined) {
      if (!UUID.test(customer_id || '')) throw new Error('Choose a customer');
      updates.customer_id = customer_id;
    }
    if (invoice_date) updates.invoice_date = invoice_date;
    if (due_date !== undefined) updates.due_date = due_date || null;
    if (description !== undefined) updates.description = description || null;
    if (line_items !== undefined) updates.line_items = parseLineItems(line_items);
    if (status !== undefined) {
      if (!INVOICE_STATUSES.includes(status)) throw new Error('Unknown invoice status');
      updates.status = status;
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

// Bills
app.get('/bills', async (req, res) => {
  try {
    const { data, error } = await bills(req)
      .select('*, vendor:vendors(id, name), payments(*, account:accounts(code, name))')
      .eq('tenant_id', req.tenantId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/bills', async (req, res) => {
  try {
    const { vendor_id, vendor_ref, bill_date, due_date, notes, line_items } = req.body;
    if (!UUID.test(vendor_id || '')) throw new Error('Choose a vendor');

    const row = {
      tenant_id: req.tenantId,
      vendor_id,
      vendor_ref: vendor_ref || null,
      due_date: due_date || null,
      notes: notes || null,
      line_items: parseBillLines(line_items)
    };
    if (bill_date) row.bill_date = bill_date;

    const { data, error } = await bills(req).insert([row]).select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (error) {
    sendError(res, error);
  }
});

app.put('/bills/:id', async (req, res) => {
  try {
    const { vendor_id, vendor_ref, bill_date, due_date, notes, status, line_items } = req.body;
    const updates = { updated_at: new Date().toISOString() };

    if (vendor_id !== undefined) {
      if (!UUID.test(vendor_id || '')) throw new Error('Choose a vendor');
      updates.vendor_id = vendor_id;
    }
    if (vendor_ref !== undefined) updates.vendor_ref = vendor_ref || null;
    if (bill_date) updates.bill_date = bill_date;
    if (due_date !== undefined) updates.due_date = due_date || null;
    if (notes !== undefined) updates.notes = notes || null;
    if (line_items !== undefined) updates.line_items = parseBillLines(line_items);
    if (status !== undefined) {
      if (!BILL_STATUSES.includes(status)) throw new Error('Unknown bill status');
      updates.status = status;
    }

    const { data, error } = await bills(req)
      .update(updates)
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .select();

    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Bill not found' });
    res.json(data[0]);
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/bills/:id', async (req, res) => {
  try {
    const { data, error } = await bills(req)
      .delete()
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .select('id');

    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Bill not found' });
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

// Payments are for an invoice or a bill
app.post('/payments', async (req, res) => {
  try {
    const { invoice_id, bill_id, account_id, payment_date, amount, reference } = req.body;
    if (!DATE.test(payment_date || '')) throw new Error('Choose a date');

    const { data, error } = await ledger(req).rpc('record_payment', {
      p_tenant: req.tenantId,
      p_invoice: invoice_id || null,
      p_bill: bill_id || null,
      p_account: account_id,
      p_date: payment_date,
      p_amount: parseAmount(amount),
      p_reference: reference || null
    });

    if (error) throw error;
    res.status(201).json({ id: data });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/payments/:id/void', async (req, res) => {
  try {
    const { error } = await ledger(req).rpc('void_payment', {
      p_tenant: req.tenantId,
      p_payment: req.params.id
    });

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

// Credit notes
app.post('/credit-notes', async (req, res) => {
  try {
    const { invoice_id, credit_date, amount, reason } = req.body;
    if (!DATE.test(credit_date || '')) throw new Error('Choose a date');

    const { data, error } = await ledger(req).rpc('create_credit_note', {
      p_tenant: req.tenantId,
      p_invoice: invoice_id,
      p_date: credit_date,
      p_amount: parseAmount(amount),
      p_reason: reason
    });

    if (error) throw error;
    res.status(201).json({ id: data });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/credit-notes/:id/void', async (req, res) => {
  try {
    const { error } = await ledger(req).rpc('void_credit_note', {
      p_tenant: req.tenantId,
      p_credit: req.params.id
    });

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

// Customers and vendors share the same shape
[['customers', 'customer_list', 'Customer'], ['vendors', 'vendor_list', 'Vendor']].forEach(([table, list, label]) => {
  const rows = (req) => req.db.schema('accounting').from(table);

  app.get(`/${table}`, async (req, res) => {
    try {
      const { data, error } = await ledger(req).rpc(list, { p_tenant: req.tenantId });
      if (error) throw error;
      res.json(data || []);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post(`/${table}`, async (req, res) => {
    try {
      const { name, email, phone, address } = req.body;
      if (!name) throw new Error('Name is required');

      const { data, error } = await rows(req)
        .insert([{
          tenant_id: req.tenantId,
          name,
          email: email || null,
          phone: phone || null,
          address: address || null
        }])
        .select();

      if (error) throw error;
      res.status(201).json(data[0]);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put(`/${table}/:id`, async (req, res) => {
    try {
      const { name, email, phone, address, is_active } = req.body;
      const updates = {};

      if (name !== undefined) {
        if (!name) throw new Error('Name is required');
        updates.name = name;
      }
      if (email !== undefined) updates.email = email || null;
      if (phone !== undefined) updates.phone = phone || null;
      if (address !== undefined) updates.address = address || null;
      if (is_active !== undefined) updates.is_active = Boolean(is_active);

      const { data, error } = await rows(req)
        .update(updates)
        .eq('id', req.params.id)
        .eq('tenant_id', req.tenantId)
        .select();

      if (error) throw error;
      if (!data.length) return res.status(404).json({ error: `${label} not found` });
      res.json(data[0]);
    } catch (error) {
      sendError(res, error);
    }
  });
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
    const { code, name, type, is_cash } = req.body;
    if (!code || !name) throw new Error('Code and name are required');
    if (!ACCOUNT_TYPES.includes(type)) throw new Error('Choose an account type');
    if (is_cash && type !== 'asset') throw new Error('Only asset accounts can be cash or bank accounts');

    const { data, error } = await accounts(req)
      .insert([{ tenant_id: req.tenantId, code, name, type, is_cash: Boolean(is_cash) }])
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

const parseDate = (value, label) => {
  if (!DATE.test(value || '')) throw new Error(`Choose ${label}`);
  return value;
};

app.get('/reports/profit-and-loss', async (req, res) => {
  try {
    const { data, error } = await ledger(req).rpc('profit_and_loss', {
      p_tenant: req.tenantId,
      p_from: parseDate(req.query.from, 'a start date'),
      p_to: parseDate(req.query.to, 'an end date')
    });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/reports/balance-sheet', async (req, res) => {
  try {
    const { data, error } = await ledger(req).rpc('balance_sheet', {
      p_tenant: req.tenantId,
      p_as_of: parseDate(req.query.as_of, 'a date')
    });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/reports/cash-flow', async (req, res) => {
  try {
    const { data, error } = await ledger(req).rpc('cash_flow', {
      p_tenant: req.tenantId,
      p_from: parseDate(req.query.from, 'a start date'),
      p_to: parseDate(req.query.to, 'an end date')
    });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/reports/aged/:kind', async (req, res) => {
  try {
    if (!['receivable', 'payable'].includes(req.params.kind)) throw new Error('Unknown report');

    const { data, error } = await ledger(req).rpc('aged_balances', {
      p_tenant: req.tenantId,
      p_kind: req.params.kind
    });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/reports/tax', async (req, res) => {
  try {
    const { data, error } = await ledger(req).rpc('tax_summary', {
      p_tenant: req.tenantId,
      p_from: parseDate(req.query.from, 'a start date'),
      p_to: parseDate(req.query.to, 'an end date')
    });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    sendError(res, error);
  }
});

// Tax rates are replaced, never edited, so posted documents stay correct
app.get('/tax-rates', async (req, res) => {
  try {
    const { data, error } = await taxRates(req)
      .select('*')
      .eq('tenant_id', req.tenantId)
      .order('name');

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/tax-rates', async (req, res) => {
  try {
    const { name, rate } = req.body;
    const percent = parseAmount(rate);
    if (!name) throw new Error('Name is required');
    if (percent > 100) throw new Error('Enter a rate up to 100');

    const { data, error } = await taxRates(req)
      .insert([{ tenant_id: req.tenantId, name, rate: percent }])
      .select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (error) {
    sendError(res, error);
  }
});

app.put('/tax-rates/:id', async (req, res) => {
  try {
    const { data, error } = await taxRates(req)
      .update({ is_active: Boolean(req.body.is_active) })
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .select();

    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Tax rate not found' });
    res.json(data[0]);
  } catch (error) {
    sendError(res, error);
  }
});

// Banking
app.get('/bank/lines', async (req, res) => {
  try {
    const { data, error } = await ledger(req).rpc('bank_feed', {
      p_tenant: req.tenantId,
      p_account: req.query.account_id
    });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/bank/import', async (req, res) => {
  try {
    const { account_id, lines } = req.body;
    const { data, error } = await ledger(req).rpc('import_bank_lines', {
      p_tenant: req.tenantId,
      p_account: account_id,
      p_lines: lines
    });

    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/bank/lines/:id/match', async (req, res) => {
  try {
    const { error } = await ledger(req).rpc('match_bank_line', {
      p_tenant: req.tenantId,
      p_line: req.params.id,
      p_journal_line: req.body.journal_line_id
    });

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/bank/lines/:id/post', async (req, res) => {
  try {
    const { account_id, memo } = req.body;
    const { data, error } = await ledger(req).rpc('post_bank_line', {
      p_tenant: req.tenantId,
      p_line: req.params.id,
      p_account: account_id,
      p_memo: memo || null
    });

    if (error) throw error;
    res.status(201).json({ id: data });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/bank/lines/:id/unmatch', async (req, res) => {
  try {
    const { error } = await ledger(req).rpc('unmatch_bank_line', {
      p_tenant: req.tenantId,
      p_line: req.params.id
    });

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/bank/lines/:id/ignore', async (req, res) => {
  try {
    const { error } = await ledger(req).rpc('set_bank_line_ignored', {
      p_tenant: req.tenantId,
      p_line: req.params.id,
      p_ignored: Boolean(req.body.ignored)
    });

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/bank/clear', async (req, res) => {
  try {
    const { error } = await ledger(req).rpc('clear_book_line', {
      p_tenant: req.tenantId,
      p_journal_line: req.body.journal_line_id
    });

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/bank/reconcile', async (req, res) => {
  try {
    const { data, error } = await ledger(req).rpc('reconcile_status', {
      p_tenant: req.tenantId,
      p_account: req.query.account_id,
      p_as_of: parseDate(req.query.as_of, 'a statement date')
    });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/bank/reconcile', async (req, res) => {
  try {
    const { account_id, statement_date, statement_balance } = req.body;
    const balance = Number(statement_balance);
    if (statement_balance === '' || statement_balance === null || !Number.isFinite(balance)) {
      throw new Error('Enter the statement balance');
    }

    const { data, error } = await ledger(req).rpc('finish_reconciliation', {
      p_tenant: req.tenantId,
      p_account: account_id,
      p_date: parseDate(statement_date, 'a statement date'),
      p_balance: balance
    });

    if (error) throw error;
    res.status(201).json({ id: data });
  } catch (error) {
    sendError(res, error);
  }
});

// Period lock and year-end close
app.get('/books', async (req, res) => {
  try {
    const { data, error } = await req.db.schema('accounting').from('settings')
      .select('lock_date')
      .eq('tenant_id', req.tenantId)
      .maybeSingle();

    if (error) throw error;
    res.json({ lock_date: data?.lock_date || null });
  } catch (error) {
    sendError(res, error);
  }
});

app.put('/books/lock', async (req, res) => {
  try {
    const { lock_date } = req.body;
    if (lock_date && !DATE.test(lock_date)) throw new Error('Choose a date');

    const { error } = await ledger(req).rpc('set_lock_date', {
      p_tenant: req.tenantId,
      p_date: lock_date || null
    });

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/books/close-year', async (req, res) => {
  try {
    const { data, error } = await ledger(req).rpc('close_year', {
      p_tenant: req.tenantId,
      p_date: parseDate(req.body.date, 'a year-end date')
    });

    if (error) throw error;
    res.status(201).json({ id: data });
  } catch (error) {
    sendError(res, error);
  }
});

// Only owners and admins can read this, which the database enforces
app.get('/audit', async (req, res) => {
  try {
    const { data, error } = await req.db.schema('accounting').from('audit_log')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) throw error;
    res.json(data || []);
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
