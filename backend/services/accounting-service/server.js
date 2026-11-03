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
const RECURRING_FREQUENCIES = ['monthly', 'quarterly', 'yearly'];
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

  return lineItems.map(({ description, quantity, unit_price, tax_rate_id, item_id }) => {
    const qty = Number(quantity);
    const price = Number(unit_price);
    if (!description || !(qty > 0) || !(price >= 0)) {
      throw new Error('Each line needs a description, quantity and price');
    }
    return { description, quantity: qty, unit_price: price, tax_rate_id: tax_rate_id || null, item_id: item_id || null };
  });
};

const parseAmount = (value) => {
  const amount = Number(value);
  if (value === '' || value === null || value === undefined || !(amount >= 0)) {
    throw new Error('Enter a valid amount');
  }
  return amount;
};

// One document-currency unit in the base currency. The database ignores it for base-currency documents.
const parseRate = (value) => {
  const rate = value === undefined || value === null || value === '' ? 1 : Number(value);
  if (!(rate > 0)) throw new Error('Enter an exchange rate above zero');
  return rate;
};

const parseBillLines = (lineItems) => {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new Error('Add at least one line');
  }

  // A stock line names the item and quantity, and the database posts it to Inventory
  return lineItems.map(({ description, account_id, amount, tax_rate_id, cost_center_id, item_id, quantity }) => {
    if (item_id) {
      const qty = Number(quantity);
      if (!UUID.test(item_id) || !Number.isInteger(qty) || qty <= 0 || !(Number(amount) > 0)) {
        throw new Error('Each stock line needs an item, a whole quantity and an amount');
      }
      return {
        description: description || null,
        item_id,
        quantity: qty,
        amount: Number(amount),
        tax_rate_id: tax_rate_id || null,
        cost_center_id: cost_center_id || null
      };
    }
    if (!UUID.test(account_id || '') || !(Number(amount) > 0)) {
      throw new Error('Each line needs an account and an amount');
    }
    return {
      description: description || null,
      account_id,
      amount: Number(amount),
      tax_rate_id: tax_rate_id || null,
      cost_center_id: cost_center_id || null
    };
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

    // What the stock on this invoice cost, so the page can show gross profit
    const { data: moves, error: moveError } = await req.db.schema('inventory')
      .from('movements')
      .select('cost')
      .eq('invoice_id', data.id)
      .eq('tenant_id', req.tenantId);
    if (moveError) throw moveError;
    res.json({ ...data, stock_cost: -moves.reduce((sum, move) => sum + Number(move.cost), 0) });
  } catch (error) {
    sendError(res, error);
  }
});

// Create invoice
app.post('/invoices', async (req, res) => {
  try {
    const { customer_id, invoice_date, due_date, description, invoice_number, line_items, cost_center_id, currency, exchange_rate } = req.body;
    if (!UUID.test(customer_id || '')) throw new Error('Choose a customer');

    const row = {
      tenant_id: req.tenantId,
      invoice_number: invoice_number || await nextInvoiceNumber(req),
      customer_id,
      due_date: due_date || null,
      description: description || null,
      amount: 0,
      cost_center_id: cost_center_id || null,
      currency: currency || null,
      exchange_rate: parseRate(exchange_rate),
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
    const { customer_id, invoice_date, due_date, description, status, line_items, cost_center_id, currency, exchange_rate } = req.body;
    const updates = { updated_at: new Date().toISOString() };

    if (customer_id !== undefined) {
      if (!UUID.test(customer_id || '')) throw new Error('Choose a customer');
      updates.customer_id = customer_id;
    }
    if (invoice_date) updates.invoice_date = invoice_date;
    if (cost_center_id !== undefined) updates.cost_center_id = cost_center_id || null;
    if (currency) updates.currency = currency;
    if (exchange_rate !== undefined) updates.exchange_rate = parseRate(exchange_rate);
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
    const { amount, category, description, expense_date, account_id, cost_center_id } = req.body;
    const row = {
      tenant_id: req.tenantId,
      amount: parseAmount(amount),
      category: category || null,
      description: description || null,
      account_id: account_id || null,
      cost_center_id: cost_center_id || null
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
    const { amount, category, description, expense_date, account_id, cost_center_id } = req.body;
    const updates = {};

    if (amount !== undefined) updates.amount = parseAmount(amount);
    if (category !== undefined) updates.category = category || null;
    if (description !== undefined) updates.description = description || null;
    if (expense_date) updates.expense_date = expense_date;
    if (account_id) updates.account_id = account_id;
    if (cost_center_id !== undefined) updates.cost_center_id = cost_center_id || null;

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
      .select('*, vendor:vendors(id, name), payments(*, account:accounts(code, name)), vendor_credits(*, account:accounts(code, name))')
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
    const { vendor_id, vendor_ref, bill_date, due_date, notes, line_items, currency, exchange_rate } = req.body;
    if (!UUID.test(vendor_id || '')) throw new Error('Choose a vendor');

    const row = {
      tenant_id: req.tenantId,
      vendor_id,
      vendor_ref: vendor_ref || null,
      due_date: due_date || null,
      notes: notes || null,
      currency: currency || null,
      exchange_rate: parseRate(exchange_rate),
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
    const { vendor_id, vendor_ref, bill_date, due_date, notes, status, line_items, currency, exchange_rate } = req.body;
    const updates = { updated_at: new Date().toISOString() };

    if (currency) updates.currency = currency;
    if (exchange_rate !== undefined) updates.exchange_rate = parseRate(exchange_rate);

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
    const { invoice_id, bill_id, account_id, payment_date, amount, reference, exchange_rate } = req.body;
    if (!DATE.test(payment_date || '')) throw new Error('Choose a date');

    const { data, error } = await ledger(req).rpc('record_payment', {
      p_tenant: req.tenantId,
      p_invoice: invoice_id || null,
      p_bill: bill_id || null,
      p_account: account_id,
      p_date: payment_date,
      p_amount: parseAmount(amount),
      p_reference: reference || null,
      p_rate: exchange_rate ? Number(exchange_rate) : null
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

// Currencies
app.get('/currencies', async (req, res) => {
  try {
    const { data, error } = await ledger(req).rpc('currency_overview', { p_tenant: req.tenantId });
    if (error) throw error;
    res.json(data);
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/currencies/rates', async (req, res) => {
  try {
    const { currency, rate_date, rate } = req.body;
    const { error } = await ledger(req).rpc('save_exchange_rate', {
      p_tenant: req.tenantId,
      p_currency: currency,
      p_date: parseDate(rate_date, 'a date'),
      p_rate: Number(rate)
    });

    if (error) throw error;
    res.status(201).json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

app.put('/currencies/base', async (req, res) => {
  try {
    const { error } = await ledger(req).rpc('set_base_currency', {
      p_tenant: req.tenantId,
      p_currency: req.body.currency
    });

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

// Refunds and vendor credits
app.post('/refunds', async (req, res) => {
  try {
    const { invoice_id, credit_date, amount, account_id, reason, exchange_rate } = req.body;
    const { data, error } = await ledger(req).rpc('create_refund', {
      p_tenant: req.tenantId,
      p_invoice: invoice_id,
      p_date: parseDate(credit_date, 'a date'),
      p_amount: parseAmount(amount),
      p_account: account_id,
      p_reason: reason,
      p_rate: exchange_rate ? parseRate(exchange_rate) : null
    });

    if (error) throw error;
    res.status(201).json({ id: data });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/vendor-credits', async (req, res) => {
  try {
    const { bill_id, credit_date, amount, account_id, reason } = req.body;
    const { data, error } = await ledger(req).rpc('create_vendor_credit', {
      p_tenant: req.tenantId,
      p_bill: bill_id,
      p_date: parseDate(credit_date, 'a date'),
      p_amount: parseAmount(amount),
      p_account: account_id,
      p_reason: reason
    });

    if (error) throw error;
    res.status(201).json({ id: data });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/vendor-credits/:id/void', async (req, res) => {
  try {
    const { error } = await ledger(req).rpc('void_vendor_credit', {
      p_tenant: req.tenantId,
      p_credit: req.params.id
    });

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

// Cost centers
const costCenters = (req) => req.db.schema('accounting').from('cost_centers');

app.get('/cost-centers', async (req, res) => {
  try {
    const { data, error } = await costCenters(req)
      .select('*')
      .eq('tenant_id', req.tenantId)
      .order('code');

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/cost-centers', async (req, res) => {
  try {
    const { code, name } = req.body;
    if (!code || !name) throw new Error('Code and name are required');

    const { data, error } = await costCenters(req)
      .insert([{ tenant_id: req.tenantId, code, name }])
      .select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (error) {
    sendError(res, error);
  }
});

app.put('/cost-centers/:id', async (req, res) => {
  try {
    const { data, error } = await costCenters(req)
      .update({ is_active: Boolean(req.body.is_active) })
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .select();

    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Cost center not found' });
    res.json(data[0]);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/reports/cost-centers', async (req, res) => {
  try {
    const { data, error } = await ledger(req).rpc('pl_by_cost_center', {
      p_tenant: req.tenantId,
      p_from: parseDate(req.query.from, 'a start date'),
      p_to: parseDate(req.query.to, 'an end date')
    });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    sendError(res, error);
  }
});

// Budgets
app.get('/budgets', async (req, res) => {
  try {
    const { data, error } = await ledger(req).from('budgets')
      .select('*, lines:budget_lines(account_id, month, amount)')
      .eq('tenant_id', req.tenantId)
      .order('fiscal_year', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/budgets', async (req, res) => {
  try {
    const { id, name, fiscal_year, lines } = req.body;
    if (!name) throw new Error('Name is required');
    if (!Array.isArray(lines)) throw new Error('Add budget amounts');

    const { data, error } = await ledger(req).rpc('save_budget', {
      p_tenant: req.tenantId,
      p_budget: id || null,
      p_name: name,
      p_year: Number(fiscal_year),
      p_lines: lines
    });

    if (error) throw error;
    res.status(201).json({ id: data });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/budgets/:id', async (req, res) => {
  try {
    const { error } = await ledger(req).rpc('delete_budget', {
      p_tenant: req.tenantId,
      p_budget: req.params.id
    });

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/budgets/:id/actual', async (req, res) => {
  try {
    const { data, error } = await ledger(req).rpc('budget_vs_actual', {
      p_tenant: req.tenantId,
      p_budget: req.params.id,
      p_from_month: Number(req.query.from) || 1,
      p_to_month: Number(req.query.to) || 12
    });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    sendError(res, error);
  }
});

// Fixed assets
app.get('/assets', async (req, res) => {
  try {
    const { data, error } = await ledger(req).rpc('asset_register', { p_tenant: req.tenantId });
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/assets', async (req, res) => {
  try {
    const { name, cost, salvage, life_months, start_date, paid_from } = req.body;
    if (!name) throw new Error('Name is required');
    if (!(Number(life_months) >= 1)) throw new Error('Enter the useful life in months');

    const { data, error } = await ledger(req).rpc('register_asset', {
      p_tenant: req.tenantId,
      p_name: name,
      p_cost: parseAmount(cost),
      p_salvage: Number(salvage) || 0,
      p_life_months: Number(life_months),
      p_start: parseDate(start_date, 'a start date'),
      p_paid_from: paid_from || null
    });

    if (error) throw error;
    res.status(201).json({ id: data });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/assets/depreciate', async (req, res) => {
  try {
    const { data, error } = await ledger(req).rpc('run_depreciation', {
      p_tenant: req.tenantId,
      p_through: parseDate(req.body.through, 'a date')
    });

    if (error) throw error;
    res.json({ months_posted: data });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/assets/:id/dispose', async (req, res) => {
  try {
    const { disposed_on, proceeds, account_id } = req.body;
    const { data, error } = await ledger(req).rpc('dispose_asset', {
      p_tenant: req.tenantId,
      p_asset: req.params.id,
      p_date: parseDate(disposed_on, 'a date'),
      p_proceeds: Number(proceeds) || 0,
      p_account: account_id || null
    });

    if (error) throw error;
    res.status(201).json({ id: data });
  } catch (error) {
    sendError(res, error);
  }
});

// Runs a database function, which checks the caller's role and company itself
const callLedger = async (req, res, name, params, status = 200) => {
  try {
    const { data, error } = await ledger(req).rpc(name, { p_tenant: req.tenantId, ...params() });
    if (error) throw error;
    res.status(status).json(data ?? { success: true });
  } catch (error) {
    sendError(res, error);
  }
};

// Purchase orders
app.get('/purchase-orders', async (req, res) => {
  try {
    const { data, error } = await ledger(req).from('purchase_orders')
      .select('*, vendor:vendors(id, name)')
      .eq('tenant_id', req.tenantId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/purchase-orders', (req, res) => callLedger(req, res, 'save_purchase_order', () => ({
  p_order: req.body.id || null,
  p_vendor: req.body.vendor_id,
  p_date: parseDate(req.body.order_date, 'an order date'),
  p_expected: req.body.expected_date || null,
  p_currency: req.body.currency || null,
  p_rate: parseRate(req.body.exchange_rate),
  p_lines: req.body.line_items,
  p_notes: req.body.notes || null
}), 201));

app.post('/purchase-orders/:id/submit', (req, res) =>
  callLedger(req, res, 'submit_purchase_order', () => ({ p_order: req.params.id })));

app.post('/purchase-orders/:id/decide', (req, res) => callLedger(req, res, 'decide_purchase_order', () => ({
  p_order: req.params.id,
  p_approve: req.body.approve === true,
  p_note: req.body.note || null
})));

app.post('/purchase-orders/:id/bill', (req, res) =>
  callLedger(req, res, 'bill_purchase_order', () => ({ p_order: req.params.id }), 201));

app.delete('/purchase-orders/:id', (req, res) =>
  callLedger(req, res, 'delete_purchase_order', () => ({ p_order: req.params.id })));

// Recurring invoices
app.get('/recurring', async (req, res) => {
  try {
    const { data, error } = await ledger(req).from('recurring_invoices')
      .select('*, customer:customers(id, name)')
      .eq('tenant_id', req.tenantId)
      .order('name');

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/recurring/run', (req, res) => callLedger(req, res, 'run_recurring_invoices', () => ({
  p_through: parseDate(req.body.through, 'a date')
})));

app.post('/recurring', (req, res) => callLedger(req, res, 'save_recurring_invoice', () => {
  const { id, name, customer_id, frequency, start_date, end_date, due_days, currency, exchange_rate, cost_center_id, line_items, auto_send } = req.body;
  if (!name) throw new Error('Name is required');
  if (!RECURRING_FREQUENCIES.includes(frequency)) throw new Error('Choose how often');

  return {
    p_id: id || null,
    p_name: name,
    p_customer: customer_id,
    p_frequency: frequency,
    p_start: parseDate(start_date, 'a start date'),
    p_end: end_date || null,
    p_due_days: Number(due_days) || 0,
    p_currency: currency || null,
    p_rate: parseRate(exchange_rate),
    p_cost_center: cost_center_id || null,
    p_lines: parseLineItems(line_items),
    p_auto_send: Boolean(auto_send)
  };
}, 201));

app.put('/recurring/:id/active', (req, res) => callLedger(req, res, 'set_recurring_active', () => ({
  p_id: req.params.id,
  p_active: Boolean(req.body.is_active)
})));

// Revenue recognition
app.get('/revenue', (req, res) => callLedger(req, res, 'revenue_overview', () => ({})));

app.post('/revenue', (req, res) => callLedger(req, res, 'create_revenue_schedule', () => ({
  p_invoice: req.body.invoice_id,
  p_start: parseDate(req.body.start_date, 'a start date'),
  p_months: Number(req.body.months)
}), 201));

app.post('/revenue/run', (req, res) => callLedger(req, res, 'run_revenue_recognition', () => ({
  p_through: parseDate(req.body.through, 'a date')
})));

app.post('/revenue/:id/cancel', (req, res) =>
  callLedger(req, res, 'cancel_revenue_schedule', () => ({ p_schedule: req.params.id })));

// Company groups
app.get('/group', (req, res) => callLedger(req, res, 'group_overview', () => ({})));

app.post('/group', (req, res) => callLedger(req, res, 'create_group', () => ({
  p_name: req.body.name,
  p_currency: req.body.currency
}), 201));

app.post('/group/companies', (req, res) => callLedger(req, res, 'add_group_company', () => ({
  p_company: req.body.company_id
}), 201));

app.delete('/group/companies/:id', (req, res) => callLedger(req, res, 'remove_group_company', () => ({
  p_company: req.params.id
})));

app.post('/group/rates', (req, res) => callLedger(req, res, 'save_group_rate', () => ({
  p_currency: req.body.currency,
  p_date: parseDate(req.body.rate_date, 'a date'),
  p_closing: parseRate(req.body.closing_rate),
  p_average: parseRate(req.body.average_rate)
}), 201));

app.post('/group/intercompany', (req, res) => callLedger(req, res, 'create_intercompany', () => ({
  p_kind: req.body.kind,
  p_from: req.body.from_company,
  p_to: req.body.to_company,
  p_date: parseDate(req.body.entry_date, 'a date'),
  p_amount: parseAmount(req.body.amount),
  p_rate: req.body.exchange_rate ? parseRate(req.body.exchange_rate) : null,
  p_from_account: req.body.from_account,
  p_to_account: req.body.to_account,
  p_memo: req.body.memo
}), 201));

app.post('/group/intercompany/:id/void', (req, res) => callLedger(req, res, 'void_intercompany', () => ({
  p_entry: req.params.id
})));

app.get('/group/profit-and-loss', (req, res) => callLedger(req, res, 'consolidated_pl', () => ({
  p_from: parseDate(req.query.from, 'a start date'),
  p_to: parseDate(req.query.to, 'an end date')
})));

app.get('/group/balance-sheet', (req, res) => callLedger(req, res, 'consolidated_bs', () => ({
  p_as_of: parseDate(req.query.as_of, 'a date')
})));

// Period lock and year-end close
app.get('/books', async (req, res) => {
  try {
    const { data, error } = await req.db.schema('accounting').from('settings')
      .select('lock_date, bill_approval_limit')
      .eq('tenant_id', req.tenantId)
      .maybeSingle();

    if (error) throw error;
    res.json({ lock_date: data?.lock_date || null, bill_approval_limit: data?.bill_approval_limit ?? null });
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

app.put('/books/approval-limit', async (req, res) => {
  try {
    const { bill_approval_limit: limit } = req.body;
    const { error } = await ledger(req).rpc('set_approval_limit', {
      p_tenant: req.tenantId,
      p_limit: limit === '' || limit === null || limit === undefined ? null : parseAmount(limit)
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
