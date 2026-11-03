import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import InventoryNav from '@/components/InventoryNav';
import Modal from '@/components/Modal';
import { api, formatDate, money } from '@/lib/api';

export default function Locations() {
  return <AppShell><LocationsApp /></AppShell>;
}

function LocationsApp() {
  const [places, setPlaces] = useState<any[]>([]);
  const [transfers, setTransfers] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<any>(null);
  const [moving, setMoving] = useState<any>(null);
  const [viewing, setViewing] = useState<any>(null);

  const load = async () => {
    try {
      const [placeRows, transferRows, itemRows] = await Promise.all([
        api.get('/api/inventory/locations'),
        api.get('/api/inventory/transfers'),
        api.get('/api/inventory/items')
      ]);
      setPlaces(placeRows);
      setTransfers(transferRows);
      setItems(itemRows);
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const save = async (place: any, changes: any) => {
    try {
      await api.put(`/api/inventory/locations/${place.id}`, { name: place.name, active: place.active, is_main: false, ...changes });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const active = places.filter((place) => place.active);

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Warehouses</h1>
        <div className="row-actions">
          {active.length > 1 && <button onClick={() => setMoving({})}>Move stock</button>}
          <button className="primary" onClick={() => setEditing({ name: '' })}>New place</button>
        </div>
      </div>
      <InventoryNav />

      <p className="muted">
        Shops, stores, vans or shelves: anywhere you keep stock. Bills bring stock into the main warehouse and invoices take it from
        the main warehouse first, then the other places. Moving stock between places doesn't change its value or the books.
      </p>
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="card table-wrap">
        <table>
          <thead><tr><th>Place</th><th className="num">Items</th><th className="num">Units</th><th className="num">Value at cost</th><th /></tr></thead>
          <tbody>
            {places.map((place) => (
              <tr key={place.id}>
                <td>
                  {place.name} {place.is_main && <span className="badge paid">main</span>} {!place.active && <span className="badge">archived</span>}
                </td>
                <td className="num">{place.items}</td>
                <td className="num">{place.quantity}</td>
                <td className="num">{money(place.value)}</td>
                <td>
                  <div className="row-actions">
                    <button onClick={() => setViewing(place)}>Stock</button>
                    <button onClick={() => setEditing(place)}>Rename</button>
                    {place.active && !place.is_main && <button onClick={() => save(place, { is_main: true })}>Make main</button>}
                    {!place.is_main && (place.active
                      ? <button onClick={() => save(place, { active: false })}>Archive</button>
                      : <button onClick={() => save(place, { active: true })}>Restore</button>)}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Recent moves</h2>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>#</th><th>Date</th><th>From</th><th>To</th><th>Items</th><th>Note</th></tr></thead>
          <tbody>
            {transfers.length === 0 && <tr><td colSpan={6} className="empty">No stock moved yet</td></tr>}
            {transfers.map((row) => (
              <tr key={row.id}>
                <td>{row.number}</td>
                <td>{formatDate(row.created_at)}</td>
                <td>{row.from?.name}</td>
                <td>{row.to?.name}</td>
                <td className="wrap">{row.lines.map((line: any) => `${line.quantity} × ${line.name}`).join(', ')}</td>
                <td className="wrap">{row.note || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && <PlaceForm place={editing} onClose={() => setEditing(null)} onSaved={load} />}
      {moving && (
        <TransferForm places={places} items={items} from={moving.from} onClose={() => setMoving(null)}
          onSaved={async (result: any) => { setNotice(`Move ${result.number} saved.`); await load(); }} />
      )}
      {viewing && (
        <PlaceStock place={viewing} onClose={() => setViewing(null)}
          onMove={active.length > 1 ?() => { setMoving({ from: viewing.id }); setViewing(null); } : undefined} />
      )}
    </div>
  );
}

function PlaceForm({ place, onClose, onSaved }: { place: any; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(place.name);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      if (place.id) await api.put(`/api/inventory/locations/${place.id}`, { name, active: place.active, is_main: false });
      else await api.post('/api/inventory/locations', { name });
      await onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title={place.id ? `Rename ${place.name}` : 'New place'}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Name<input required maxLength={80} placeholder="e.g. High Street shop" value={name} onChange={(e) => setName(e.target.value)} /></label>
        </div>
        <p className="muted">Only owners and admins can add or change places.</p>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function TransferForm({ places, items, from, onClose, onSaved }: {
  places: any[]; items: any[]; from?: string; onClose: () => void; onSaved: (result: any) => void;
}) {
  const active = places.filter((place) => place.active);
  const [source, setSource] = useState(from || places.find((place) => place.is_main)?.id || '');
  const [target, setTarget] = useState(active.find((place) => place.id !== (from || places.find((row) => row.is_main)?.id))?.id || '');
  const [lines, setLines] = useState<any[]>([{ item_id: '', quantity: '' }]);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const heldAt = (itemId: string) =>
    items.find((item) => item.id === itemId)?.levels?.find((level: any) => level.location_id === source)?.quantity || 0;
  const available = items.filter((item) => (item.levels || []).some((level: any) => level.location_id === source && level.quantity > 0));
  const setLine = (index: number, field: string, value: string) =>
    setLines(lines.map((line, i) => (i === index ? { ...line, [field]: value } : line)));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const chosen = lines.filter((line) => line.item_id);
      const result = await api.post('/api/inventory/transfers', { from_location: source, to_location: target, lines: chosen, note });
      await onSaved(result);
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title="Move stock">
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>From
            <select required value={source} onChange={(e) => { setSource(e.target.value); setLines([{ item_id: '', quantity: '' }]); }}>
              {places.map((place) => <option key={place.id} value={place.id}>{place.name}</option>)}
            </select>
          </label>
          <label>To
            <select required value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Choose…</option>
              {active.filter((place) => place.id !== source).map((place) => <option key={place.id} value={place.id}>{place.name}</option>)}
            </select>
          </label>
        </div>
        <div className="lines">
          {lines.map((line, index) => (
            <div key={index} className="row-actions" style={{ justifyContent: 'flex-start' }}>
              <select aria-label="Item" value={line.item_id} onChange={(e) => setLine(index, 'item_id', e.target.value)}>
                <option value="">Choose an item…</option>
                {available.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.sku}) · {heldAt(item.id)} here</option>)}
              </select>
              <input aria-label="Quantity" type="number" min="1" step="1" max={line.item_id ? heldAt(line.item_id) : undefined}
                placeholder="Qty" value={line.quantity} onChange={(e) => setLine(index, 'quantity', e.target.value)} style={{ width: 90 }} />
              {lines.length > 1 && <button type="button" aria-label="Remove line" onClick={() => setLines(lines.filter((_, i) => i !== index))}>×</button>}
            </div>
          ))}
          <div><button type="button" className="link" onClick={() => setLines([...lines, { item_id: '', quantity: '' }])}>+ Add another item</button></div>
        </div>
        {available.length === 0 && <p className="muted">Nothing is held here yet.</p>}
        <label>Note<input maxLength={500} placeholder="Optional" value={note} onChange={(e) => setNote(e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary">Move</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function PlaceStock({ place, onClose, onMove }: { place: any; onClose: () => void; onMove?: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/api/inventory/locations/${place.id}/stock`).then(setRows).catch((err) => setError(err.message));
  }, []);

  return (
    <Modal title={`Stock at ${place.name}`}>
      {error && <p className="error">{error}</p>}
      {rows && rows.length === 0 && <p className="empty">Nothing here</p>}
      {rows && rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>SKU</th><th>Item</th><th className="num">Here</th><th className="num">Everywhere</th><th className="num">Value here</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.item.id}>
                  <td>{row.item.sku}</td>
                  <td className="wrap">{row.item.name}</td>
                  <td className="num">{row.quantity} <span className="muted">{row.item.unit}</span></td>
                  <td className="num">{row.item.quantity}</td>
                  <td className="num">{money(row.item.quantity ? (Number(row.item.stock_value) * row.quantity) / row.item.quantity : 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="form-actions">
        {onMove && rows && rows.length > 0 && <button className="primary" onClick={onMove}>Move stock from here</button>}
        <button onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
