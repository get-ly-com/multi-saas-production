import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import InventoryNav from '@/components/InventoryNav';
import { api, money, today } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';

export default function Valuation() {
  return <AppShell><ValuationApp /></AppShell>;
}

function ValuationApp() {
  const [date, setDate] = useState(today());
  const [place, setPlace] = useState('');
  const [places, setPlaces] = useState<any[]>([]);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/inventory/locations').then(setPlaces).catch(() => setPlaces([]));
  }, []);

  useEffect(() => {
    if (!date) return;
    api.get(`/api/inventory/valuation?date=${date}${place ? `&location=${place}` : ''}`)
      .then((report) => {
        setData(report);
        setError('');
      })
      .catch((err) => setError(err.message));
  }, [date, place]);

  const placeName = places.find((row) => row.id === place)?.name;
  const difference = data && data.ledger !== null ? Number(data.value) - Number(data.ledger) : 0;

  const download = () => downloadCsv(`stock-value-${date}${placeName ? `-${placeName}` : ''}.csv`, [
    ['SKU', 'Item', 'Category', 'Quantity', 'Unit', 'Cost each', 'Value'],
    ...data.items.map((row: any) => [row.sku, row.name, row.category, row.quantity, row.unit,
      row.unit_cost === null ? '' : Number(row.unit_cost), Number(row.value)])
  ]);

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Stock value</h1>
        {data && data.items.length > 0 && <button onClick={download}>Download CSV</button>}
      </div>
      <InventoryNav />

      <div className="report-filters">
        <label>At the end of<input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} /></label>
        {places.length > 1 && (
          <label>Place
            <select value={place} onChange={(e) => setPlace(e.target.value)}>
              <option value="">All places</option>
              {places.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </select>
          </label>
        )}
      </div>

      <p className="muted">
        What you held and what it was worth at cost, from every stock change up to that day.
        {placeName && ` For ${placeName}, value is its share of each item's value.`}
      </p>
      {error && <p className="error">{error}</p>}

      {data && (
        <>
          <div className="stats">
            <div className="card"><div className="stat-label">Stock value</div><div className="stat-value">{money(data.value)}</div></div>
            <div className="card"><div className="stat-label">Units</div><div className="stat-value">{Number(data.quantity)}</div></div>
            {data.ledger !== null && (
              <div className="card">
                <div className="stat-label">Inventory account on that day</div>
                <div className="stat-value">{money(data.ledger)}</div>
                <div className="muted">
                  {Math.round(difference * 100) === 0 ? 'Matches the stock value'
                    : `${money(Math.abs(difference))} apart: stock moves when an invoice or bill is posted, the books use its date`}
                </div>
              </div>
            )}
          </div>

          <div className="card table-wrap">
            <table>
              <thead><tr><th>SKU</th><th>Item</th><th>Category</th><th className="num">Quantity</th><th className="num">Cost each</th><th className="num">Value</th></tr></thead>
              <tbody>
                {data.items.length === 0 && <tr><td colSpan={6} className="empty">No stock on that day</td></tr>}
                {data.items.map((row: any) => (
                  <tr key={row.item_id}>
                    <td>{row.sku}</td>
                    <td className="wrap">{row.name}</td>
                    <td>{row.category || '—'}</td>
                    <td className="num">{row.quantity} <span className="muted">{row.unit}</span></td>
                    <td className="num">{row.unit_cost === null ? '—' : money(row.unit_cost)}</td>
                    <td className="num">{money(row.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
