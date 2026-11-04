import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { ScanWithCamera } from '@/components/BarcodeScanner';
import InventoryNav from '@/components/InventoryNav';
import Modal from '@/components/Modal';
import { api, formatDate, money } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

const blankItem = {
  sku: '', name: '', barcode: '', unit: 'units', category_id: '', vendor_id: '',
  quantity: '0', unit_cost: '', location_id: '', price: '', reorder_level: '0', reorder_to: '0'
};

const UNITS = ['units', 'pcs', 'boxes', 'packs', 'pairs', 'kg', 'g', 'litres', 'ml', 'metres', 'rolls', 'sets'];

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

const levelAt = (item: any, placeId: string) =>
  (item.levels || []).find((level: any) => level.location_id === placeId)?.quantity || 0;

export default function Inventory() {
  return <AppShell><InventoryApp /></AppShell>;
}

function InventoryApp() {
  const [items, setItems] = useState<any[]>([]);
  const [places, setPlaces] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [place, setPlace] = useState('');
  const [scan, setScan] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [itemForm, setItemForm] = useState<any>(null);
  const [adjusting, setAdjusting] = useState<any>(null);
  const [costing, setCosting] = useState<any>(null);
  const [history, setHistory] = useState<any>(null);
  const [found, setFound] = useState<any>(null);
  const [managingCategories, setManagingCategories] = useState(false);

  const load = async () => {
    try {
      const [itemRows, placeRows, categoryRows, supplierRows] = await Promise.all([
        api.get('/api/inventory/items'),
        api.get('/api/inventory/locations'),
        api.get('/api/inventory/categories'),
        api.get('/api/inventory/suppliers').catch(() => [])
      ]);
      setItems(itemRows);
      setPlaces(placeRows);
      setCategories(categoryRows);
      setSuppliers(supplierRows);
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

  const remove = (item: any) => run(async () => {
    if (!window.confirm(`Delete ${item.name} and its history? This can't be undone.`)) return;
    try {
      await api.delete(`/api/inventory/items/${item.id}`);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  });

  // Scanners type the code and press Enter
  const { busy, run } = useSubmit();
  const lookUp = async (event: FormEvent) => {
    event.preventDefault();
    return findCode(scan);
  };
  // The camera fills the box and looks the code up at once
  const scannedWithCamera = (code: string) => {
    setScan(code);
    findCode(code);
  };
  const findCode = (typed: string) => {
    return run(async () => {
      const code = typed.trim();
      if (!code) return;
      try {
        setFound(await api.get(`/api/inventory/items/lookup?code=${encodeURIComponent(code)}`));
        setScan('');
        setError('');
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  const editForm = (item: any) => ({
    ...item,
    price: item.price ?? '',
    barcode: item.barcode || '',
    category_id: item.category_id || '',
    vendor_id: item.vendor_id || ''
  });

  const activePlaces = places.filter((row) => row.active);
  const query = search.trim().toLowerCase();
  const visible = items.filter((item) =>
    `${item.name} ${item.sku} ${item.barcode || ''}`.toLowerCase().includes(query)
    && (!category || (category === 'none' ? !item.category_id : item.category_id === category))
    && (!place || levelAt(item, place) > 0));
  const costValue = items.reduce((sum, item) => sum + Number(item.stock_value || 0), 0);
  const priceValue = items.reduce((sum, item) => sum + item.quantity * Number(item.price || 0), 0);
  const uncosted = items.filter((item) => item.quantity > 0 && !Number(item.stock_value)).length;
  const lowCount = items.filter((item) => item.quantity <= item.reorder_level).length;
  const placeName = places.find((row) => row.id === place)?.name;

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Inventory</h1>
        <div className="row-actions">
          <button onClick={() => setManagingCategories(true)}>Categories</button>
          <button className="primary" onClick={() => setItemForm({ ...blankItem })}>New item</button>
        </div>
      </div>
      <InventoryNav />

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

      <form className="report-filters" onSubmit={lookUp}>
        <label>Scan or type a barcode
          <span className="scan-box">
            <input aria-label="Barcode or SKU" placeholder="Barcode or SKU, then Enter" value={scan} onChange={(e) => setScan(e.target.value)} />
            <ScanWithCamera onCode={scannedWithCamera} label="Camera" />
          </span>
        </label>
        <label>Search
          <input aria-label="Search items" placeholder="Name, SKU or barcode" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <label>Category
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {categories.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            <option value="none">No category</option>
          </select>
        </label>
        {places.length > 1 && (
          <label>Place
            <select value={place} onChange={(e) => setPlace(e.target.value)}>
              <option value="">All places</option>
              {places.map((row) => <option key={row.id} value={row.id}>{row.name}{row.active ? '' : ' (archived)'}</option>)}
            </select>
          </label>
        )}
      </form>

      <div className="card table-wrap">
        {loading ? <p className="empty">Loading…</p> : (
          <table>
            <thead>
              <tr>
                <th>SKU</th><th>Name</th><th>Status</th>
                <th className="num">{placeName ? `At ${placeName}` : 'On hand'}</th>
                <th className="num">Average cost</th><th className="num">Value</th><th className="num">Price</th><th className="num">Margin</th><th />
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && <tr><td colSpan={9} className="empty">{items.length ? 'No matches' : 'No items yet'}</td></tr>}
              {visible.map((item) => {
                const state = stockState(item);
                return (
                  <tr key={item.id}>
                    <td>{item.sku}</td>
                    <td className="wrap">
                      {item.name}
                      {item.category && <div className="muted">{item.category.name}</div>}
                    </td>
                    <td><span className={`badge ${state.style}`}>{state.label}</span></td>
                    <td className="num">
                      {place ? levelAt(item, place) : item.quantity} <span className="muted">{item.unit}</span>
                      {place && <div className="muted">of {item.quantity}</div>}
                    </td>
                    <td className="num">{Number(item.avg_cost) ? money(item.avg_cost) : '—'}</td>
                    <td className="num">{money(item.stock_value)}</td>
                    <td className="num">{item.price === null ? '—' : money(item.price)}</td>
                    <td className="num">{margin(item)}</td>
                    <td>
                      <div className="row-actions">
                        <button onClick={() => setAdjusting(item)}>Adjust stock</button>
                        <button onClick={() => setCosting(item)}>Set cost</button>
                        <button onClick={() => setHistory(item)}>History</button>
                        <button onClick={() => setItemForm(editForm(item))}>Edit</button>
                        <button disabled={busy} className="danger" onClick={() => remove(item)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {itemForm && (
        <ItemForm initial={itemForm} categories={categories} suppliers={suppliers} places={activePlaces}
          onClose={() => setItemForm(null)} onSaved={load} />
      )}
      {adjusting && <AdjustForm item={adjusting} places={places} onClose={() => setAdjusting(null)} onSaved={load} />}
      {costing && <CostForm item={costing} onClose={() => setCosting(null)} onSaved={load} />}
      {history && <History item={history} onClose={() => setHistory(null)} />}
      {found && (
        <Found item={found} places={places} onClose={() => setFound(null)}
          onAdjust={() => { setAdjusting(found); setFound(null); }}
          onHistory={() => { setHistory(found); setFound(null); }} />
      )}
      {managingCategories && <Categories rows={categories} onClose={() => setManagingCategories(false)} onSaved={load} />}
    </div>
  );
}

function ItemForm({ initial, categories, suppliers, places, onClose, onSaved }: {
  initial: any; categories: any[]; suppliers: any[]; places: any[]; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState<any>(initial);
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm({ ...form, [field]: value });

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      const { sku, name, barcode, unit, category_id, vendor_id, quantity, unit_cost, location_id, price, reorder_level, reorder_to } = form;
      const details = { sku, name, barcode, unit, category_id, vendor_id, price, reorder_level, reorder_to };
      try {
        if (form.id) await api.put(`/api/inventory/items/${form.id}`, details);
        else await api.post('/api/inventory/items', { ...details, quantity, unit_cost, location_id });
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title={form.id ? 'Edit item' : 'New item'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>SKU<input required maxLength={100} value={form.sku} onChange={(e) => set('sku', e.target.value)} /></label>
          <label>Name<input required maxLength={200} value={form.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label>Barcode<input maxLength={64} placeholder="Optional" value={form.barcode} onChange={(e) => set('barcode', e.target.value)} /></label>
          <label>Counted in
            <input list="inventory-units" maxLength={20} value={form.unit} onChange={(e) => set('unit', e.target.value)} />
            <datalist id="inventory-units">{UNITS.map((unit) => <option key={unit} value={unit} />)}</datalist>
          </label>
          <label>Category
            <select value={form.category_id} onChange={(e) => set('category_id', e.target.value)}>
              <option value="">None</option>
              {categories.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </select>
          </label>
          <label>Usual supplier
            <select value={form.vendor_id} onChange={(e) => set('vendor_id', e.target.value)}>
              <option value="">None</option>
              {suppliers.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </select>
          </label>
          {!form.id && (
            <>
              <label>Opening stock<input type="number" min="0" step="1" value={form.quantity} onChange={(e) => set('quantity', e.target.value)} /></label>
              <label>Cost of each<input type="number" min="0" step="0.0001" placeholder="Unknown" value={form.unit_cost} onChange={(e) => set('unit_cost', e.target.value)} /></label>
              {places.length > 1 && (
                <label>Kept at
                  <select value={form.location_id} onChange={(e) => set('location_id', e.target.value)}>
                    <option value="">{places.find((row) => row.is_main)?.name || 'Main warehouse'}</option>
                    {places.filter((row) => !row.is_main).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
                  </select>
                </label>
              )}
            </>
          )}
          <label>Selling price<input type="number" min="0" step="0.01" value={form.price} onChange={(e) => set('price', e.target.value)} /></label>
          <label>Reorder level<input type="number" min="0" step="1" value={form.reorder_level} onChange={(e) => set('reorder_level', e.target.value)} /></label>
          <label>Order up to<input type="number" min="0" step="1" value={form.reorder_to} onChange={(e) => set('reorder_to', e.target.value)} /></label>
        </div>
        <p className="muted">
          When stock (plus what's already on order) falls to the reorder level, Reorder suggests enough to get back to "order up to".
        </p>
        {!form.id && Number(form.quantity) > 0 && Number(form.unit_cost) > 0 && (
          <p className="muted">Opening stock of {money(Number(form.quantity) * Number(form.unit_cost))} goes on the books against Owner's Equity.</p>
        )}
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function AdjustForm({ item, places, onClose, onSaved }: { item: any; places: any[]; onClose: () => void; onSaved: () => void }) {
  const [change, setChange] = useState('');
  const [unitCostValue, setUnitCost] = useState('');
  const [reason, setReason] = useState('');
  const [place, setPlace] = useState('');
  const [error, setError] = useState('');
  const adding = Number(change) > 0;
  const average = Number(item.avg_cost);
  const value = adding
    ? Number(change) * (unitCostValue === '' ? average : Number(unitCostValue))
    : item.quantity + Number(change) === 0 ? -Number(item.stock_value) : (Number(item.stock_value) * Number(change)) / (item.quantity || 1);
  const choosable = places.filter((row) => row.active || levelAt(item, row.id) > 0);

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api.post(`/api/inventory/items/${item.id}/adjust`, { change, reason, unit_cost: adding ? unitCostValue : '', location_id: place });
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title={`Adjust ${item.name}`} onClose={onClose}>
      <p>On hand: {item.quantity} {item.unit}{Number(item.stock_value) > 0 && `, worth ${money(item.stock_value)}`}</p>
      {places.length > 1 && <PlaceBreakdown item={item} places={places} />}
      <p className="muted">
        For damage, returns and one-off fixes. To count a whole shelf or store, use Stock counts. Stock you buy from a supplier
        goes on a bill in Accounting, so it's paid and costed together.
      </p>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Change (use a minus for stock going out)<input required type="number" step="1" value={change} onChange={(e) => setChange(e.target.value)} /></label>
          {adding && (
            <label>Cost of each<input type="number" min="0" step="0.0001" placeholder={average ? `${average} (average)` : 'Unknown'} value={unitCostValue} onChange={(e) => setUnitCost(e.target.value)} /></label>
          )}
          {places.length > 1 && (
            <label>Where
              <select value={place} onChange={(e) => setPlace(e.target.value)}>
                <option value="">{Number(change) < 0 ? 'Wherever it is (main warehouse first)' : places.find((row) => row.is_main)?.name || 'Main warehouse'}</option>
                {choosable.map((row) => <option key={row.id} value={row.id}>{row.name} ({levelAt(item, row.id)})</option>)}
              </select>
            </label>
          )}
          <label>Reason<input maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        </div>
        {Number(change) !== 0 && Math.round(value * 100) !== 0 && (
          <p className="muted">{money(Math.abs(value))} {value > 0 ? 'added to' : 'taken off'} stock value, against Stock Adjustments.</p>
        )}
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function PlaceBreakdown({ item, places }: { item: any; places: any[] }) {
  const held = places.filter((row) => levelAt(item, row.id) > 0);
  if (!held.length) return <p className="muted">None in any place.</p>;
  return (
    <p className="muted">
      {held.map((row) => `${row.name}: ${levelAt(item, row.id)}`).join(' · ')}
    </p>
  );
}

function CostForm({ item, onClose, onSaved }: { item: any; onClose: () => void; onSaved: () => void }) {
  const [cost, setCost] = useState(Number(item.avg_cost) ? String(Number(item.avg_cost)) : '');
  const [error, setError] = useState('');
  const newValue = Math.round(item.quantity * Number(cost || 0) * 100) / 100;
  const difference = newValue - Number(item.stock_value);

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api.post(`/api/inventory/items/${item.id}/cost`, { unit_cost: cost });
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title={`Set cost of ${item.name}`} onClose={onClose}>
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
          <button disabled={busy} className="primary">Set cost</button>
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
    <Modal title={`History for ${item.name}`} onClose={onClose}>
      {error && <p className="error">{error}</p>}
      {rows && rows.length === 0 && <p className="empty">No stock changes yet</p>}
      {rows && rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Reason</th><th>Where</th><th className="num">Change</th><th className="num">Value</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{formatDate(row.created_at)}</td>
                  <td className="wrap">{row.reason || '—'}</td>
                  <td>{row.location?.name || '—'}</td>
                  <td className="num">{row.change > 0 ? `+${row.change}` : row.change || '—'}</td>
                  <td className="num">{Number(row.cost) ? `${Number(row.cost) > 0 ? '+' : '−'}${money(Math.abs(Number(row.cost)))}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="form-actions"><button onClick={onClose}>Close</button></div>
    </Modal>
  );
}

function Found({ item, places, onClose, onAdjust, onHistory }: {
  item: any; places: any[]; onClose: () => void; onAdjust: () => void; onHistory: () => void;
}) {
  return (
    <Modal title={item.name} onClose={onClose}>
      <div className="facts">
        <div><div className="stat-label">SKU</div>{item.sku}</div>
        <div><div className="stat-label">Barcode</div>{item.barcode || '—'}</div>
        <div><div className="stat-label">On hand</div>{item.quantity} {item.unit}</div>
        <div><div className="stat-label">Value</div>{money(item.stock_value)}</div>
        <div><div className="stat-label">Price</div>{item.price === null ? '—' : money(item.price)}</div>
      </div>
      {places.length > 1 && <PlaceBreakdown item={item} places={places} />}
      <div className="form-actions">
        <button className="primary" onClick={onAdjust}>Adjust stock</button>
        <button onClick={onHistory}>History</button>
        <button onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

function Categories({ rows, onClose, onSaved }: { rows: any[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<any>(null);
  const [error, setError] = useState('');

  const { busy, run: once } = useSubmit();
  // One action at a time, so a double click cannot repeat it
  const run = (action: () => Promise<unknown>) => once(async () => {
    try {
      await action();
      await onSaved();
      setError('');
      return true;
    } catch (err: any) {
      setError(err.message);
      return false;
    }
  });

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (await run(() => api.post('/api/inventory/categories', { name }))) setName('');
  };

  const rename = async (event: FormEvent) => {
    event.preventDefault();
    if (await run(() => api.put(`/api/inventory/categories/${editing.id}`, { name: editing.name }))) setEditing(null);
  };

  const remove = (row: any) => {
    if (!window.confirm(`Delete the category ${row.name}? Its ${row.items} items stay, without a category.`)) return;
    run(() => api.delete(`/api/inventory/categories/${row.id}`));
  };

  return (
    <Modal title="Categories" onClose={() => setEditing(null)}>
      <form className="report-filters" onSubmit={add}>
        <label>New category<input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div className="form-actions"><button disabled={busy} className="primary">Add</button></div>
      </form>
      {error && <p className="error">{error}</p>}
      {rows.length === 0 ? <p className="empty">No categories yet</p> : (
        <table>
          <thead><tr><th>Name</th><th className="num">Items</th><th /></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  {editing?.id === row.id ? (
                    <form onSubmit={rename} className="row-actions">
                      <input aria-label="Category name" required maxLength={80} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                      <button disabled={busy} className="primary">Save</button>
                      <button type="button" onClick={() => setEditing(null)}>Cancel</button>
                    </form>
                  ) : row.name}
                </td>
                <td className="num">{row.items}</td>
                <td>
                  <div className="row-actions">
                    <button onClick={() => setEditing({ id: row.id, name: row.name })}>Rename</button>
                    <button className="danger" onClick={() => remove(row)}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="form-actions"><button onClick={onClose}>Close</button></div>
    </Modal>
  );
}
