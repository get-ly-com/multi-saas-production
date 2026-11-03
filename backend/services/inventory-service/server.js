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

const sendError = (res, error) => {
  if (error.code === '23505') return res.status(409).json({ error: 'That SKU already exists' });
  if (error.code === '23514') return res.status(400).json({ error: 'Not enough stock' });
  res.status(400).json({ error: error.message });
};

const parseWhole = (value, label) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a whole number`);
  return parsed;
};

const parsePrice = (value) => {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!(parsed >= 0)) throw new Error('Enter a valid price');
  return parsed;
};

// Blank means "at the average cost"
const parseCost = (value) => {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!(parsed >= 0) || parsed >= 1e10) throw new Error('Enter a valid unit cost');
  return parsed;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const adjustStock = async (req, itemId, change, reason, unitCost = null, opening = false) => {
  const { data, error } = await db(req).rpc('adjust_stock', {
    p_tenant: req.tenantId,
    p_item: itemId,
    p_change: change,
    p_reason: reason || null,
    p_unit_cost: unitCost,
    p_opening: opening
  });

  if (error) throw error;
  return data;
};

app.use(express.json());
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

app.get('/items', async (req, res) => {
  try {
    const { data, error } = await items(req).select('*').eq('tenant_id', req.tenantId).order('name');
    if (error) throw error;
    res.json(data || []);
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

    const { data, error } = await items(req)
      .insert([{
        tenant_id: req.tenantId,
        sku,
        name,
        price: parsePrice(price),
        reorder_level: parseWhole(reorder_level || 0, 'Reorder level')
      }])
      .select();

    if (error) throw error;
    const item = opening > 0
      ? await adjustStock(req, data[0].id, opening, 'Opening stock', cost, true)
      : data[0];
    res.status(201).json(item);
  } catch (error) {
    sendError(res, error);
  }
});

// Quantity only changes through /adjust, so every change is in the history
app.put('/items/:id', async (req, res) => {
  try {
    const { sku, name, price, reorder_level } = req.body;
    const updates = { updated_at: new Date().toISOString() };

    if (sku !== undefined) {
      if (!sku) throw new Error('SKU is required');
      updates.sku = sku;
    }
    if (name !== undefined) {
      if (!name) throw new Error('Name is required');
      updates.name = name;
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
    if (!Number.isInteger(change) || change === 0) {
      throw new Error('Change must be a whole number, positive or negative');
    }
    res.json(await adjustStock(req, req.params.id, change, req.body.reason, change > 0 ? parseCost(req.body.unit_cost) : null));
  } catch (error) {
    sendError(res, error);
  }
});

// Values stock that was on hand before costs were tracked
app.post('/items/:id/cost', async (req, res) => {
  try {
    const cost = parseCost(req.body.unit_cost);
    if (cost === null) throw new Error('Enter a valid unit cost');
    const { data, error } = await db(req).rpc('set_item_cost', { p_tenant: req.tenantId, p_item: req.params.id, p_unit_cost: cost });
    if (error) throw error;
    res.json(data);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/profit', async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!DATE.test(from || '') || !DATE.test(to || '')) throw new Error('Choose a start and end date');
    const { data, error } = await db(req).rpc('product_profit', { p_tenant: req.tenantId, p_from: from, p_to: to });
    if (error) throw error;
    res.json(data);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/items/:id/movements', async (req, res) => {
  try {
    const { data, error } = await db(req)
      .from('movements')
      .select('*')
      .eq('item_id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    sendError(res, error);
  }
});

app.listen(PORT, () => console.log(`📦 Inventory Service on ${PORT}`));
