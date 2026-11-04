import { FormEvent, KeyboardEvent, MouseEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { ScanWithCamera } from '@/components/BarcodeScanner';
import Drawer from '@/components/Drawer';
import EmptyState from '@/components/EmptyState';
import Icon from '@/components/Icon';
import InventoryNav, { StockBar, stockLevel } from '@/components/InventoryNav';
import Modal from '@/components/Modal';
import Skeleton, { SkeletonStats, SkeletonTable } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api, formatDate, money } from '@/lib/api';
import { count } from '@/lib/format';
import useSubmit from '@/lib/useSubmit';
import styles from '@/styles/inventory.module.css';

const blankItem = {
  sku: '', name: '', barcode: '', unit: 'units', category_id: '', vendor_id: '',
  quantity: '0', unit_cost: '', location_id: '', price: '', reorder_level: '0', reorder_to: '0'
};

const UNITS = ['units', 'pcs', 'boxes', 'packs', 'pairs', 'kg', 'g', 'litres', 'ml', 'metres', 'rolls', 'sets'];

const STOCK_WORDS: Record<string, string> = { good: 'In stock', low: 'Low', out: 'Out of stock' };

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
  const [level, setLevel] = useState('');
  const [scan, setScan] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [itemForm, setItemForm] = useState<any>(null);
  const [adjusting, setAdjusting] = useState<any>(null);
  const [costing, setCosting] = useState<any>(null);
  const [open, setOpen] = useState<any>(null);
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
      setOpen(null);
      await load();
      toast.success('Item deleted', { detail: item.name });
    } catch (err: any) {
      toast.error('Could not delete', { detail: err.message });
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
        const found = await api.get(`/api/inventory/items/lookup?code=${encodeURIComponent(code)}`);
        setOpen(items.find((row) => row.id === found.id) || found);
        setScan('');
        setError('');
      } catch (err: any) {
        toast.error('No item with that code', { detail: err.message });
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

  // Opening a form closes the drawer, so only one panel is ever on top
  const fromDrawer = (show: () => void) => {
    setOpen(null);
    show();
  };

  const openRow = (event: KeyboardEvent<HTMLTableRowElement>, item: any) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(item);
    }
  };

  const activePlaces = places.filter((row) => row.active);
  const query = search.trim().toLowerCase();
  const visible = items.filter((item) =>
    `${item.name} ${item.sku} ${item.barcode || ''}`.toLowerCase().includes(query)
    && (!category || (category === 'none' ? !item.category_id : item.category_id === category))
    && (!place || levelAt(item, place) > 0)
    && (!level || stockLevel(item) === level || (level === 'low' && stockLevel(item) === 'out')));
  const costValue = items.reduce((sum, item) => sum + Number(item.stock_value || 0), 0);
  const priceValue = items.reduce((sum, item) => sum + item.quantity * Number(item.price || 0), 0);
  const uncosted = items.filter((item) => item.quantity > 0 && !Number(item.stock_value)).length;
  const lowCount = items.filter((item) => item.quantity <= item.reorder_level).length;
  const outCount = items.filter((item) => item.quantity === 0).length;
  const placeName = places.find((row) => row.id === place)?.name;
  const filtered = Boolean(query || category || place || level);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Inventory</h1>
          <p className="muted">{loading ? ' ' : `${count(items.length)} items, ${money(costValue)} at cost`}</p>
        </div>
        <div className="row-actions">
          <button onClick={() => setManagingCategories(true)}>Categories</button>
          <button className="primary" onClick={() => setItemForm({ ...blankItem })}>New item</button>
        </div>
      </div>
      <InventoryNav />

      {error && <p className="error">{error}</p>}

      {loading ? <SkeletonStats count={4} /> : (
        <div className="stats">
          <div className="card"><div className="stat-label">Items</div><div className="stat-value">{count(items.length)}</div><div className="muted">{categories.length} categories</div></div>
          <div className="card"><div className="stat-label">Stock value at cost</div><div className="stat-value">{money(costValue)}</div><div className="muted">Matches the Inventory account</div></div>
          <div className="card"><div className="stat-label">At selling price</div><div className="stat-value">{money(priceValue)}</div>
            {priceValue > costValue && costValue > 0 && <div className="muted">{money(priceValue - costValue)} above cost</div>}</div>
          <div className="card">
            <div className="stat-label">Low or out of stock</div>
            <div className="stat-value">{lowCount}</div>
            {lowCount > 0 ? (
              <button type="button" className="link small always" aria-pressed={level === 'low'} onClick={() => setLevel(level === 'low' ? '' : 'low')}>
                {level === 'low' ? 'Show everything' : `${outCount} out. Show them`}
              </button>
            ) : <div className="muted">All stocked up</div>}
          </div>
        </div>
      )}

      {uncosted > 0 && (
        <p className="muted">
          <span className="badge low">{uncosted} without a cost</span>{' '}
          {uncosted === 1 ? 'This item has' : 'These items have'} stock with no cost yet, so sales of {uncosted === 1 ? 'it' : 'them'} show full profit.
          Use Set cost to value what&apos;s on hand. Buy new stock on a bill in Accounting so it comes in at what you paid.
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
          <input type="search" aria-label="Search items" placeholder="Name, SKU or barcode" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <label>Category
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {categories.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            <option value="none">No category</option>
          </select>
        </label>
        <label>Stock
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">Any level</option>
            <option value="low">Low or out</option>
            <option value="out">Out of stock</option>
            <option value="good">In stock</option>
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

      {loading ? <SkeletonTable rows={8} columns={6} /> : items.length === 0 ? (
        <div className="card">
          <EmptyState icon="inventory" title="No items yet" line="Add what you sell or keep on the shelf, and we track stock and its value as it moves."
            action={{ label: 'New item', onClick: () => setItemForm({ ...blankItem }) }} />
        </div>
      ) : visible.length === 0 ? (
        <div className="card">
          <EmptyState compact icon="search" title={level === 'low' && !query && !category && !place ? 'Nothing low on stock' : 'No matches'}
            line={level === 'low' && !query && !category && !place ? 'Every item is above its reorder level.' : 'Try another name or code, or clear the filters.'}
            tone={level === 'low' && !query && !category && !place ? 'done' : 'plain'}
            action={filtered ? { label: 'Clear filters', onClick: () => { setSearch(''); setCategory(''); setPlace(''); setLevel(''); } } : undefined} />
        </div>
      ) : (
        <div className={`card table-wrap ${styles.list}`}>
          <table>
            <thead>
              <tr>
                <th>Item</th><th>SKU</th>
                <th>{placeName ? `At ${placeName}` : 'Stock'}</th>
                <th className="num">Average cost</th><th className="num">Value</th><th className="num">Price</th><th className="num">Margin</th><th />
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => (
                <tr key={item.id} tabIndex={0} onClick={() => setOpen(item)} onKeyDown={(e) => openRow(e, item)} aria-label={`Open ${item.name}`}>
                  <td className="wrap">
                    <div className={styles.itemName}>{item.name}</div>
                    {item.category && <span className="muted small">{item.category.name}</span>}
                  </td>
                  <td><span className={styles.sku}>{item.sku}</span></td>
                  <td>
                    <StockBar item={item} quantity={place ? levelAt(item, place) : undefined} />
                    {place && <div className="muted small">of {item.quantity} in all</div>}
                  </td>
                  <td className="num">{Number(item.avg_cost) ? money(item.avg_cost) : '—'}</td>
                  <td className="num">{money(item.stock_value)}</td>
                  <td className="num">{item.price === null ? '—' : money(item.price)}</td>
                  <td className="num">{margin(item)}</td>
                  <td>
                    <div className="row-actions">
                      <button className="small" onClick={(e: MouseEvent) => { e.stopPropagation(); setAdjusting(item); }}>Adjust</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Drawer open={!!open} title={open?.name || ''} subtitle={open ? <span className={styles.sku}>{open.sku}</span> : undefined} onClose={() => setOpen(null)}
        footer={open && (
          <>
            <button className="danger" disabled={busy} onClick={() => remove(open)}>Delete</button>
            <button onClick={() => fromDrawer(() => setItemForm(editForm(open)))}>Edit</button>
            <button onClick={() => fromDrawer(() => setCosting(open))}>Set cost</button>
            <button className="primary" onClick={() => fromDrawer(() => setAdjusting(open))}>Adjust stock</button>
          </>
        )}>
        {open && <ItemDetails item={open} places={places} suppliers={suppliers} />}
      </Drawer>

      {itemForm && (
        <ItemForm initial={itemForm} categories={categories} suppliers={suppliers} places={activePlaces}
          onClose={() => setItemForm(null)} onSaved={async () => { await load(); toast.success(itemForm.id ? 'Item saved' : 'Item added', { detail: itemForm.name }); }} />
      )}
      {adjusting && (
        <AdjustForm item={adjusting} places={places} onClose={() => setAdjusting(null)}
          onSaved={async () => { await load(); toast.success('Stock adjusted', { detail: adjusting.name }); }} />
      )}
      {costing && (
        <CostForm item={costing} onClose={() => setCosting(null)}
          onSaved={async () => { await load(); toast.success('Cost set', { detail: `${costing.name} is valued at the new cost.` }); }} />
      )}
      {managingCategories && <Categories rows={categories} onClose={() => setManagingCategories(false)} onSaved={load} />}
    </div>
  );
}

// What the drawer shows: the numbers, where it is, and every stock change
function ItemDetails({ item, places, suppliers }: { item: any; places: any[]; suppliers: any[] }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setRows(null);
    setError('');
    api.get(`/api/inventory/items/${item.id}/movements`).then(setRows).catch((err) => setError(err.message));
  }, [item.id]);

  const state = stockLevel(item);
  const held = places.filter((row) => levelAt(item, row.id) > 0);
  const most = Math.max(1, ...held.map((row) => levelAt(item, row.id)));
  const supplier = suppliers.find((row) => row.id === item.vendor_id)?.name;

  return (
    <>
      <div className={styles.drawerTop}>
        <div className={styles.tile}><span className="stat-label">On hand</span><strong>{count(item.quantity)} <span className="muted small">{item.unit}</span></strong></div>
        <div className={styles.tile}><span className="stat-label">Value</span><strong>{money(item.stock_value)}</strong></div>
        <div className={styles.tile}><span className="stat-label">Margin</span><strong>{margin(item)}</strong></div>
      </div>
      <div style={{ marginBottom: 20 }}>
        <div className="row-actions" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <span className={`badge ${state === 'good' ? 'active' : state}`}>{STOCK_WORDS[state]}</span>
          <span className="muted small">Reorder at {item.reorder_level}{item.reorder_to > item.reorder_level ? `, up to ${item.reorder_to}` : ''}</span>
        </div>
        <StockBar item={item} bare />
      </div>
      <dl className={styles.facts}>
        <div><dt>SKU</dt><dd className={styles.sku}>{item.sku}</dd></div>
        <div><dt>Barcode</dt><dd className={styles.sku}>{item.barcode || '—'}</dd></div>
        <div><dt>Category</dt><dd>{item.category?.name || 'None'}</dd></div>
        <div><dt>Usual supplier</dt><dd>{supplier || 'None'}</dd></div>
        <div><dt>Average cost</dt><dd>{Number(item.avg_cost) ? money(item.avg_cost) : '—'}</dd></div>
        <div><dt>Selling price</dt><dd>{item.price === null ? '—' : money(item.price)}</dd></div>
      </dl>

      {places.length > 1 && (
        <>
          <h3 className={styles.section}>Where it is</h3>
          {held.length === 0 ? <p className="muted">None in any place.</p> : (
            <div className={styles.places}>
              {held.map((row) => (
                <div key={row.id} className={styles.place}>
                  <span>{row.name}</span>
                  <span className={styles.bar}><span style={{ width: `${Math.round((levelAt(item, row.id) / most) * 100)}%` }} /></span>
                  <strong className="num">{levelAt(item, row.id)}</strong>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <h3 className={styles.section}>Stock changes</h3>
      {error && <p className="error">{error}</p>}
      {!rows && !error && <div style={{ display: 'grid', gap: 12 }}>{[0, 1, 2].map((n) => <Skeleton key={n} height={28} />)}</div>}
      {rows && rows.length === 0 && <EmptyState compact icon="inventory" title="No stock changes yet" line="Sales, bills, counts and adjustments show up here." />}
      {rows && rows.length > 0 && (
        <ul className={styles.moves}>
          {rows.map((row) => {
            const way = row.change > 0 ? 'in' : row.change < 0 ? 'out' : '';
            return (
              <li key={row.id} className={styles.move}>
                <span className={`${styles.moveIcon} ${way ? styles[way] : ''}`} aria-hidden="true">
                  <Icon name={row.change > 0 ? 'plus' : row.change < 0 ? 'arrow-right' : 'money'} size={14} />
                </span>
                <span className={styles.moveText}>
                  <span>{row.reason || 'Stock change'}</span>
                  <span className="muted small">{formatDate(row.created_at)}{row.location?.name ? ` · ${row.location.name}` : ''}
                    {Number(row.cost) ? ` · ${Number(row.cost) > 0 ? '+' : '−'}${money(Math.abs(Number(row.cost)))}` : ''}</span>
                </span>
                <span className={`${styles.moveQty} ${way ? styles[way] : ''}`}>{row.change > 0 ? `+${row.change}` : row.change || '—'}</span>
              </li>
            );
          })}
        </ul>
      )}
    </>
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
