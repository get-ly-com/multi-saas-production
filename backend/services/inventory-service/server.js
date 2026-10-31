require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3003;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const db = () => supabase.schema('inventory');
const items = () => db().from('items');

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

const adjustStock = async (tenantId, itemId, change, reason) => {
  const { data, error } = await db().rpc('adjust_stock', {
    p_tenant: tenantId,
    p_item: itemId,
    p_change: change,
    p_reason: reason || null
  });

  if (error) throw error;
  return data;
};

app.use(express.json());
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'inventory-service' }));

// Only the gateway reaches this service, and it sets the tenant
app.use((req, res, next) => {
  req.tenantId = req.headers['x-tenant-id'];
  if (!UUID.test(req.tenantId || '')) {
    return res.status(400).json({ error: 'Missing tenant' });
  }
  next();
});

app.get('/items', async (req, res) => {
  try {
    const { data, error } = await items().select('*').eq('tenant_id', req.tenantId).order('name');
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/items', async (req, res) => {
  try {
    const { sku, name, quantity, price, reorder_level } = req.body;
    if (!sku || !name) throw new Error('SKU and name are required');
    const opening = parseWhole(quantity || 0, 'Quantity');

    const { data, error } = await items()
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
      ? await adjustStock(req.tenantId, data[0].id, opening, 'Opening stock')
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

    const { data, error } = await items()
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
    const { data, error } = await items()
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
    res.json(await adjustStock(req.tenantId, req.params.id, change, req.body.reason));
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/items/:id/movements', async (req, res) => {
  try {
    const { data, error } = await db()
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
