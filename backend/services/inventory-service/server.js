require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3003;

// Queries run as the signed-in user, so database policies apply to them
const supabaseFor = (authorization) =>
  createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false }
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const db = (req) => req.db.schema('inventory');
const items = (req) => db(req).from('items');

const DUPLICATES = {
  items_tenant_id_sku_key: 'That SKU already exists',
  items_barcode_key: 'Another item already has that barcode',
  locations_name_key: 'A place with that name already exists',
  categories_name_key: 'A category with that name already exists'
};

// Only our own messages and the ones our database functions raise (P0001) reach people
const sendError = (res, error) => {
  const code = error?.code || '';
  if (error?.status) return res.status(error.status).json({ error: error.message });
  if (!code && error?.constructor === Error) return res.status(400).json({ error: error.message });
  if (code === 'P0001') return res.status(400).json({ error: error.message });
  if (/^PT[45]\d\d$/.test(code)) return res.status(Number(code.slice(2))).json({ error: error.message });

  console.error('Inventory error:', error);
  if (code === '42501') return res.status(403).json({ error: 'You don’t have access to that' });
  if (code === '22P02') return res.status(404).json({ error: 'Not found' });
  if (code === '23503') return res.status(409).json({ error: 'That is still in use' });
  if (code === '23505') {
    const key = Object.keys(DUPLICATES).find((name) => (error.message || '').includes(name));
    return res.status(409).json({ error: key ? DUPLICATES[key] : 'That already exists' });
  }
  // items_quantity_check and stock_levels_quantity_check stop stock going below zero
  if (code === '23514') {
    return res.status(400).json({ error: /quantity/.test(error.message || '') ? 'Not enough stock' : 'That value isn’t allowed' });
  }
  res.status(400).json({ error: 'That didn’t work. Please check and try again.' });
};

const parseWhole = (value, label) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 999999999) throw new Error(`${label} must be a whole number`);
  return parsed;
};

const parsePrice = (value) => {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed >= 1e10) throw new Error('Enter a valid price');
  return parsed;
};

// Blank means "at the average cost"
const parseCost = (value) => {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed >= 1e10) throw new Error('Enter a valid unit cost');
  return parsed;
};

// Blank means "none"; anything else must look like an id
const parseId = (value, label) => {
  if (value === '' || value === null || value === undefined) return null;
  if (!UUID.test(String(value))) throw new Error(`Choose a valid ${label}`);
  return String(value);
};

const parseText = (value, label, max) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text.length > max) throw new Error(`Keep the ${label} under ${max} characters`);
  return text || null;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const adjustStock = async (req, itemId, change, reason, unitCost = null, opening = false, location = null) => {
  const { data, error } = await db(req).rpc('adjust_stock', {
    p_tenant: req.tenantId,
    p_item: itemId,
    p_change: change,
    p_reason: reason || null,
    p_unit_cost: unitCost,
    p_opening: opening,
    p_location: location
  });

  if (error) throw error;
  return data;
};

const rpc = async (req, name, args) => {
  const { data, error } = await db(req).rpc(name, { p_tenant: req.tenantId, ...args });
  if (error) throw error;
  return data;
};

// The optional item fields that can be set when adding or editing an item
const itemDetails = (body) => {
  const details = {};
  if (body.category_id !== undefined) details.category_id = parseId(body.category_id, 'category');
  if (body.vendor_id !== undefined) details.vendor_id = parseId(body.vendor_id, 'supplier');
  if (body.barcode !== undefined) details.barcode = parseText(body.barcode, 'barcode', 64);
  if (body.unit !== undefined) details.unit = parseText(body.unit, 'unit', 20) || 'units';
  if (body.reorder_to !== undefined) details.reorder_to = parseWhole(body.reorder_to || 0, 'Order up to');
  return details;
};

app.use(express.json({ limit: '1mb' }));
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'inventory-service' }));

// Only the gateway reaches this service, and it sets the tenant
app.use((req, res, next) => {
  req.tenantId = req.headers['x-tenant-id'];
  if (!UUID.test(req.tenantId || '') || !req.headers.authorization) {
    return res.status(400).json({ error: 'Missing tenant' });
  }
  req.db = supabaseFor(req.headers.authorization);
  next();
});

// Ids in the path must look like ids, so bad links get a clear answer
app.param('id', (req, res, next, id) => {
  if (!UUID.test(id)) return res.status(404).json({ error: 'Not found' });
  next();
});

// ---------------------------------------------------------------- items

app.get('/items', async (req, res) => {
  try {
    const { data, error } = await items(req)
      .select('*, category:categories(id, name), levels:stock_levels(location_id, quantity)')
      .eq('tenant_id', req.tenantId)
      .order('name');
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    sendError(res, error);
  }
});

// Exact match on barcode or SKU, for scanners and quick search
app.get('/items/lookup', async (req, res) => {
  try {
    const code = String(req.query.code || '').trim();
    if (!code || code.length > 64) throw new Error('Scan or type a barcode or SKU');
    const found = async (column) => {
      const { data, error } = await items(req)
        .select('*, category:categories(id, name), levels:stock_levels(location_id, quantity)')
        .eq('tenant_id', req.tenantId)
        .eq(column, code)
        .limit(1);
      if (error) throw error;
      return data[0];
    };
    const item = (await found('barcode')) || (await found('sku'));
    if (!item) return res.status(404).json({ error: `No item with barcode or SKU ${code}` });
    res.json(item);
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/items', async (req, res) => {
  try {
    const { sku, name, quantity, price, reorder_level, unit_cost } = req.body;
    if (!sku || !name) throw new Error('SKU and name are required');
    const opening = parseWhole(quantity || 0, 'Quantity');
    const cost = parseCost(unit_cost);
    const location = parseId(req.body.location_id, 'place');

    const { data, error } = await items(req)
      .insert([{
        tenant_id: req.tenantId,
        sku: String(sku).trim(),
        name: String(name).trim(),
        price: parsePrice(price),
        reorder_level: parseWhole(reorder_level || 0, 'Reorder level'),
        ...itemDetails(req.body)
      }])
      .select();

    if (error) throw error;
    if (opening === 0) return res.status(201).json(data[0]);
    try {
      res.status(201).json(await adjustStock(req, data[0].id, opening, 'Opening stock', cost, true, location));
    } catch (stockError) {
      // Take the new item back out, so trying again doesn't say the SKU already exists
      const { error: undoError } = await items(req).delete().eq('id', data[0].id).eq('tenant_id', req.tenantId);
      if (undoError) console.error('Inventory error: could not remove an item whose opening stock failed:', undoError);
      throw stockError;
    }
  } catch (error) {
    sendError(res, error);
  }
});

// Quantity only changes through stock moves, so every change is in the history
app.put('/items/:id', async (req, res) => {
  try {
    const { sku, name, price, reorder_level } = req.body;
    const updates = { updated_at: new Date().toISOString(), ...itemDetails(req.body) };

    if (sku !== undefined) {
      if (!sku) throw new Error('SKU is required');
      updates.sku = String(sku).trim();
    }
    if (name !== undefined) {
      if (!name) throw new Error('Name is required');
      updates.name = String(name).trim();
    }
    if (price !== undefined) updates.price = parsePrice(price);
    if (reorder_level !== undefined) updates.reorder_level = parseWhole(reorder_level, 'Reorder level');

    const { data, error } = await items(req)
      .update(updates)
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .select();

    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Item not found' });
    res.json(data[0]);
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/items/:id', async (req, res) => {
  try {
    const { data, error } = await items(req)
      .delete()
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .select('id');

    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Item not found' });
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/items/:id/adjust', async (req, res) => {
  try {
    const change = Number(req.body.change);
    if (!Number.isInteger(change) || change === 0 || Math.abs(change) > 999999999) {
      throw new Error('Change must be a whole number, positive or negative');
    }
    res.json(await adjustStock(req, req.params.id, change, parseText(req.body.reason, 'reason', 200),
      change > 0 ? parseCost(req.body.unit_cost) : null, false, parseId(req.body.location_id, 'place')));
  } catch (error) {
    sendError(res, error);
  }
});

// Values stock that was on hand before costs were tracked
app.post('/items/:id/cost', async (req, res) => {
  try {
    const cost = parseCost(req.body.unit_cost);
    if (cost === null) throw new Error('Enter a valid unit cost');
    res.json(await rpc(req, 'set_item_cost', { p_item: req.params.id, p_unit_cost: cost }));
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/items/:id/movements', async (req, res) => {
  try {
    const { data, error } = await db(req)
      .from('movements')
      .select('*, location:locations(name)')
      .eq('item_id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    sendError(res, error);
  }
});

// Suppliers to choose from on an item; they live in Accounting
app.get('/suppliers', async (req, res) => {
  try {
    const { data, error } = await req.db.schema('accounting').from('vendors')
      .select('id, name')
      .eq('tenant_id', req.tenantId)
      .order('name');
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    sendError(res, error);
  }
});

// ---------------------------------------------------------------- categories

app.get('/categories', async (req, res) => {
  try {
    const { data, error } = await db(req).from('categories')
      .select('id, name, items(count)')
      .eq('tenant_id', req.tenantId)
      .order('name');
    if (error) throw error;
    res.json((data || []).map(({ items: counted, ...row }) => ({ ...row, items: counted?.[0]?.count || 0 })));
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/categories', async (req, res) => {
  try {
    const name = parseText(req.body.name, 'name', 80);
    if (!name) throw new Error('Enter a name');
    const { data, error } = await db(req).from('categories')
      .insert([{ tenant_id: req.tenantId, name }])
      .select();
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (error) {
    sendError(res, error);
  }
});

app.put('/categories/:id', async (req, res) => {
  try {
    const name = parseText(req.body.name, 'name', 80);
    if (!name) throw new Error('Enter a name');
    const { data, error } = await db(req).from('categories')
      .update({ name })
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .select();
    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Category not found' });
    res.json(data[0]);
  } catch (error) {
    sendError(res, error);
  }
});

// Items in it keep going, just without a category
app.delete('/categories/:id', async (req, res) => {
  try {
    const { data, error } = await db(req).from('categories')
      .delete()
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .select('id');
    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Category not found' });
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

// ---------------------------------------------------------------- warehouses and transfers

app.get('/locations', async (req, res) => {
  try {
    res.json(await rpc(req, 'list_locations', {}));
  } catch (error) {
    sendError(res, error);
  }
});

const saveLocation = async (req, res, id) => {
  try {
    const name = parseText(req.body.name, 'name', 80);
    if (!name) throw new Error('Enter a name');
    const saved = await rpc(req, 'save_location', {
      p_location: id,
      p_name: name,
      p_active: req.body.active !== false,
      p_main: req.body.is_main === true
    });
    res.status(id ? 200 : 201).json({ id: saved });
  } catch (error) {
    sendError(res, error);
  }
};

app.post('/locations', (req, res) => saveLocation(req, res, null));
app.put('/locations/:id', (req, res) => saveLocation(req, res, req.params.id));

// Each place's stock, item by item
app.get('/locations/:id/stock', async (req, res) => {
  try {
    const { data, error } = await db(req).from('stock_levels')
      .select('quantity, item:items(id, sku, name, unit, quantity, stock_value)')
      .eq('tenant_id', req.tenantId)
      .eq('location_id', req.params.id)
      .gt('quantity', 0);
    if (error) throw error;
    res.json((data || []).sort((a, b) => a.item.name.localeCompare(b.item.name)));
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/transfers', async (req, res) => {
  try {
    const { data, error } = await db(req).from('transfers')
      .select('*, from:locations!transfers_from_location_fkey(name), to:locations!transfers_to_location_fkey(name), movements(item_id, change, item:items(name, sku, unit))')
      .eq('tenant_id', req.tenantId)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json((data || []).map(({ movements, ...row }) => ({
      ...row,
      lines: (movements || []).filter((move) => move.change > 0)
        .map((move) => ({ item_id: move.item_id, quantity: move.change, ...move.item }))
    })));
  } catch (error) {
    sendError(res, error);
  }
});

const parseLines = (lines, max = 500) => {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('Add at least one item');
  if (lines.length > max) throw new Error(`Add up to ${max} lines at a time`);
  return lines.map((line) => ({
    item_id: parseId(line?.item_id, 'item'),
    quantity: (() => {
      const quantity = parseWhole(line?.quantity, 'Quantity');
      if (quantity === 0) throw new Error('Quantities must be more than zero');
      return quantity;
    })()
  }));
};

app.post('/transfers', async (req, res) => {
  try {
    const from = parseId(req.body.from_location, 'place to move from');
    const to = parseId(req.body.to_location, 'place to move to');
    if (!from || !to) throw new Error('Choose where the stock is moving from and to');
    res.status(201).json(await rpc(req, 'transfer_stock', {
      p_from: from,
      p_to: to,
      p_lines: parseLines(req.body.lines),
      p_note: parseText(req.body.note, 'note', 500)
    }));
  } catch (error) {
    sendError(res, error);
  }
});

// ---------------------------------------------------------------- stock counts

app.get('/counts', async (req, res) => {
  try {
    const { data, error } = await db(req).from('counts')
      .select('*, location:locations(name), category:categories(name), count_lines(counted)')
      .eq('tenant_id', req.tenantId)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json((data || []).map(({ count_lines: lines, ...row }) => ({
      ...row,
      lines: (lines || []).length,
      counted: (lines || []).filter((line) => line.counted !== null).length
    })));
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/counts/:id', async (req, res) => {
  try {
    const { data, error } = await db(req).from('counts')
      .select('*, location:locations(id, name), category:categories(name), count_lines(item_id, expected, counted, difference, item:items(sku, name, unit, barcode, avg_cost))')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Count not found' });
    const { count_lines: lines, ...count } = data;

    // What is there now, so an open sheet shows changes made since it started
    const { data: levels, error: levelError } = await db(req).from('stock_levels')
      .select('item_id, quantity')
      .eq('tenant_id', req.tenantId)
      .eq('location_id', count.location_id);
    if (levelError) throw levelError;
    const now = Object.fromEntries((levels || []).map((level) => [level.item_id, level.quantity]));

    res.json({
      ...count,
      lines: (lines || [])
        .map(({ item, ...line }) => ({ ...line, ...item, on_hand: now[line.item_id] || 0 }))
        .sort((a, b) => a.name.localeCompare(b.name))
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/counts', async (req, res) => {
  try {
    const location = parseId(req.body.location_id, 'place');
    if (!location) throw new Error('Choose where you are counting');
    const id = await rpc(req, 'start_count', {
      p_location: location,
      p_category: parseId(req.body.category_id, 'category'),
      p_note: parseText(req.body.note, 'note', 500)
    });
    res.status(201).json({ id });
  } catch (error) {
    sendError(res, error);
  }
});

// Saves counted quantities; a blank count is "not counted yet"
app.put('/counts/:id', async (req, res) => {
  try {
    const lines = req.body.lines;
    if (!Array.isArray(lines) || lines.length > 5000) throw new Error('Nothing to save');
    await rpc(req, 'save_count', {
      p_count: req.params.id,
      p_lines: lines.map((line) => ({
        item_id: parseId(line?.item_id, 'item'),
        counted: line?.counted === '' || line?.counted === null || line?.counted === undefined
          ? null : parseWhole(line.counted, 'Counts')
      }))
    });
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/counts/:id/apply', async (req, res) => {
  try {
    res.json(await rpc(req, 'apply_count', { p_count: req.params.id }));
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/counts/:id/cancel', async (req, res) => {
  try {
    await rpc(req, 'cancel_count', { p_count: req.params.id });
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

// ---------------------------------------------------------------- reports and reordering

app.get('/profit', async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!DATE.test(from || '') || !DATE.test(to || '')) throw new Error('Choose a start and end date');
    res.json(await rpc(req, 'product_profit', { p_from: from, p_to: to }));
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/valuation', async (req, res) => {
  try {
    const { date } = req.query;
    if (!DATE.test(date || '') || Number.isNaN(Date.parse(date))) throw new Error('Choose a date');
    res.json(await rpc(req, 'stock_valuation', { p_date: date, p_location: parseId(req.query.location, 'place') }));
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/reorder', async (req, res) => {
  try {
    res.json(await rpc(req, 'reorder_suggestions', {}));
  } catch (error) {
    sendError(res, error);
  }
});

// Makes draft purchase orders, one per supplier, from the chosen suggestions
app.post('/reorder', async (req, res) => {
  try {
    const { lines, expected_date } = req.body;
    if (!Array.isArray(lines) || lines.length === 0) throw new Error('Choose at least one item to order');
    if (lines.length > 500) throw new Error('Order up to 500 items at a time');
    if (expected_date && !DATE.test(expected_date)) throw new Error('Choose a valid expected date');
    const parsed = lines.map((line) => {
      const vendor = parseId(line?.vendor_id, 'supplier');
      if (!vendor) throw new Error('Choose a supplier for every item');
      const quantity = parseWhole(line?.quantity, 'Quantity');
      if (quantity === 0) throw new Error('Quantities must be more than zero');
      const price = parseCost(line?.unit_price);
      return {
        item_id: parseId(line?.item_id, 'item'),
        quantity,
        unit_price: String(Math.round((price || 0) * 10000) / 10000),
        vendor_id: vendor
      };
    });
    res.status(201).json(await rpc(req, 'create_reorder_orders', { p_lines: parsed, p_expected: expected_date || null }));
  } catch (error) {
    sendError(res, error);
  }
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  // Bad JSON and too-large bodies are the sender's mistake, not ours
  if (err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.status === 413 ? 'That is too large to send' : 'That request could not be read' });
  }
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));

app.listen(PORT, () => console.log(`📦 Inventory Service on ${PORT}`));
