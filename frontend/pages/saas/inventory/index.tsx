import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import Modal from '@/components/Modal';
import { api, formatDate, money } from '@/lib/api';

const blankItem = { sku: '', name: '', quantity: '0', unit_cost: '', price: '', reorder_level: '0' };

const stockState = (item: any) => {
  if (item.quantity === 0) return { label: 'out of stock', style: 'out' };
  if (item.quantity <= item.reorder_level) return { label: 'low', style: 'low' };
  return { label: 'in stock', style: '' };
};

const margin = (item: any) => {
  const price = Number(item.price);
  if (!item.price || !price || !Number(item.avg_cost)) return '—';
  return `${Math.round(((price - Number(item.avg_cost)) / price) * 100)}%`;
};

export default function Inventory() {
  return <AppShell><InventoryApp /></AppShell>;
}

function InventoryApp() {
  const [items, setItems] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [itemForm, setItemForm] = useState<any>(null);
  const [adjusting, setAdjusting] = useState<any>(null);
  const [costing, setCosting] = useState<any>(null);
  const [history, setHistory] = useState<any>(null);

  const load = async () => {
    try {
      setItems(await api.get('/api/inventory/items'));
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const remove = async (item: any) => {
    if (!window.confirm(`Delete ${item.name} and its history? This can't be undone.`)) return;
    try {
      await api.delete(`/api/inventory/items/${item.id}`);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const query = search.trim().toLowerCase();
  const visible = items.filter((item) => `${item.name} ${item.sku}`.toLowerCase().includes(query));
  const costValue = items.reduce((sum, item) => sum + Number(item.stock_value || 0), 0);
  const priceValue = items.reduce((sum, item) => sum + item.quantity * Number(item.price || 0), 0);
  const uncosted = items.filter((item) => item.quantity > 0 && !Number(item.stock_value)).length;
  const lowCount = items.filter((item) => item.quantity <= item.reorder_level).length;

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Inventory</h1>
        <div className="row-actions">
          <Link href="/saas/inventory/profit">Profit by product</Link>
          <button className="primary" onClick={() => setItemForm(blankItem)}>New item</button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="stats">
        <div className="card"><div className="stat-label">Items</div><div className="stat-value">{items.length}</div></div>
        <div className="card"><div className="stat-label">Stock value at cost</div><div className="stat-value">{money(costValue)}</div><div className="muted">Matches the Inventory account</div></div>
        <div className="card"><div className="stat-label">At selling price</div><div className="stat-value">{money(priceValue)}</div></div>
        <div className="card"><div className="stat-label">Low or out of stock</div><div className="stat-value">{lowCount}</div></div>
      </div>

      {uncosted > 0 && (
        <p className="muted">
          {uncosted} {uncosted === 1 ? 'item has' : 'items have'} stock with no cost yet, so sales of {uncosted === 1 ? 'it' : 'them'} show full profit.
          Use Set cost to value what's on hand. Buy new stock on a bill in Accounting so it comes in at what you paid.
        </p>
      )}

      <input aria-label="Search items" placeholder="Search by name or SKU" value={search} onChange={(e) => setSearch(e.target.value)} />

      <div className="card table-wrap">
        {loading ? <p className="empty">Loading…</p> : (
          <table>
            <thead>
              <tr><th>SKU</th><th>Name</th><th>Status</th><th className="num">On hand</th><th className="num">Average cost</th><th className="num">Value</th><th className="num">Price</th><th className="num">Margin</th><th /></tr>
            </thead>
            <tbody>
              {visible.length === 0 && <tr><td colSpan={9} className="empty">{items.length ? 'No matches' : 'No items yet'}</td></tr>}
              {visible.map((item) => {
                const state = stockState(item);
                return (
                  <tr key={item.id}>
                    <td>{item.sku}</td>
                    <td className="wrap">{item.name}</td>
                    <td><span className={`badge ${state.style}`}>{state.label}</span></td>
                    <td className="num">{item.quantity}</td>
                    <td className="num">{Number(item.avg_cost) ? money(item.avg_cost) : '—'}</td>
                    <td className="num">{money(item.stock_value)}</td>
                    <td className="num">{item.price === null ? '—' : money(item.price)}</td>
                    <td className="num">{margin(item)}</td>
                    <td>
                      <div className="row-actions">
                        <button onClick={() => setAdjusting(item)}>Adjust stock</button>
                        <button onClick={() => setCosting(item)}>Set cost</button>
                        <button onClick={() => setHistory(item)}>History</button>
                        <button onClick={() => setItemForm({ ...item, price: item.price ?? '' })}>Edit</button>
                        <button className="danger" onClick={() => remove(item)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {itemForm && <ItemForm initial={itemForm} onClose={() => setItemForm(null)} onSaved={load} />}
      {adjusting && <AdjustForm item={adjusting} onClose={() => setAdjusting(null)} onSaved={load} />}
      {costing && <CostForm item={costing} onClose={() => setCosting(null)} onSaved={load} />}
      {history && <History item={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function ItemForm({ initial, onClose, onSaved }: { initial: any; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<any>(initial);
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm({ ...form, [field]: value });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const { sku, name, quantity, unit_cost, price, reorder_level } = form;
    try {
      if (form.id) await api.put(`/api/inventory/items/${form.id}`, { sku, name, price, reorder_level });
      else await api.post('/api/inventory/items', { sku, name, quantity, unit_cost, price, reorder_level });
      await onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title={form.id ? 'Edit item' : 'New item'}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>SKU<input required value={form.sku} onChange={(e) => set('sku', e.target.value)} /></label>
          <label>Name<input required value={form.name} onChange={(e) => set('name', e.target.value)} /></label>
          {!form.id && (
            <>
              <label>Opening stock<input type="number" min="0" step="1" value={form.quantity} onChange={(e) => set('quantity', e.target.value)} /></label>
              <label>Cost of each<input type="number" min="0" step="0.0001" placeholder="Unknown" value={form.unit_cost} onChange={(e) => set('unit_cost', e.target.value)} /></label>
            </>
          )}
          <label>Selling price<input type="number" min="0" step="0.01" value={form.price} onChange={(e) => set('price', e.target.value)} /></label>
          <label>Reorder level<input type="number" min="0" step="1" value={form.reorder_level} onChange={(e) => set('reorder_level', e.target.value)} /></label>
        </div>
        {!form.id && Number(form.quantity) > 0 && Number(form.unit_cost) > 0 && (
          <p className="muted">Opening stock of {money(Number(form.quantity) * Number(form.unit_cost))} goes on the books against Owner's Equity.</p>
        )}
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function AdjustForm({ item, onClose, onSaved }: { item: any; onClose: () => void; onSaved: () => void }) {
  const [change, setChange] = useState('');
  const [unitCostValue, setUnitCost] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const adding = Number(change) > 0;
  const average = Number(item.avg_cost);
  const value = adding
    ? Number(change) * (unitCostValue === '' ? average : Number(unitCostValue))
    : item.quantity + Number(change) === 0 ? -Number(item.stock_value) : (Number(item.stock_value) * Number(change)) / (item.quantity || 1);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post(`/api/inventory/items/${item.id}/adjust`, { change, reason, unit_cost: adding ? unitCostValue : '' });
      await onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title={`Adjust ${item.name}`}>
      <p>On hand: {item.quantity}{Number(item.stock_value) > 0 && `, worth ${money(item.stock_value)}`}</p>
      <p className="muted">For counts, damage and returns. Stock you buy from a supplier goes on a bill in Accounting, so it's paid and costed together.</p>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Change (use a minus for stock going out)<input required type="number" step="1" value={change} onChange={(e) => setChange(e.target.value)} /></label>
          {adding && (
            <label>Cost of each<input type="number" min="0" step="0.0001" placeholder={average ? `${average} (average)` : 'Unknown'} value={unitCostValue} onChange={(e) => setUnitCost(e.target.value)} /></label>
          )}
          <label>Reason<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        </div>
        {Number(change) !== 0 && Math.round(value * 100) !== 0 && (
          <p className="muted">{money(Math.abs(value))} {value > 0 ? 'added to' : 'taken off'} stock value, against Stock Adjustments.</p>
        )}
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function CostForm({ item, onClose, onSaved }: { item: any; onClose: () => void; onSaved: () => void }) {
  const [cost, setCost] = useState(Number(item.avg_cost) ? String(Number(item.avg_cost)) : '');
  const [error, setError] = useState('');
  const newValue = Math.round(item.quantity * Number(cost || 0) * 100) / 100;
  const difference = newValue - Number(item.stock_value);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post(`/api/inventory/items/${item.id}/cost`, { unit_cost: cost });
      await onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title={`Set cost of ${item.name}`}>
      <p className="muted">
        For stock you had before costs were tracked, or a cost that was wrong. The {item.quantity} on hand will be valued at this cost,
        and the difference goes to Owner's Equity. Only owners and admins can do this.
      </p>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Cost of each<input required type="number" min="0" step="0.0001" value={cost} onChange={(e) => setCost(e.target.value)} /></label>
        </div>
        {cost !== '' && (
          <p>Value {money(item.stock_value)} → {money(newValue)}{Math.round(difference * 100) !== 0 && ` (${difference > 0 ? '+' : ''}${money(difference)})`}</p>
        )}
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary">Set cost</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function History({ item, onClose }: { item: any; onClose: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/api/inventory/items/${item.id}/movements`).then(setRows).catch((err) => setError(err.message));
  }, []);

  return (
    <Modal title={`History for ${item.name}`}>
      {error && <p className="error">{error}</p>}
      {rows && rows.length === 0 && <p className="empty">No stock changes yet</p>}
      {rows && rows.length > 0 && (
        <table>
          <thead><tr><th>Date</th><th>Reason</th><th className="num">Change</th><th className="num">Value</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{formatDate(row.created_at)}</td>
                <td className="wrap">{row.reason || '—'}</td>
                <td className="num">{row.change > 0 ? `+${row.change}` : row.change || '—'}</td>
                <td className="num">{Number(row.cost) ? `${Number(row.cost) > 0 ? '+' : '−'}${money(Math.abs(Number(row.cost)))}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="form-actions"><button onClick={onClose}>Close</button></div>
    </Modal>
  );
}
