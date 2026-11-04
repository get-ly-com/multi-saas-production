import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import EmptyState from '@/components/EmptyState';
import InventoryNav from '@/components/InventoryNav';
import { SkeletonStats, SkeletonTable } from '@/components/Skeleton';
import { api, money, today } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { count } from '@/lib/format';
import styles from '@/styles/inventory.module.css';

export default function Valuation() {
  return <AppShell><ValuationApp /></AppShell>;
}

function ValuationApp() {
  const [date, setDate] = useState(today());
  const [place, setPlace] = useState('');
  const [places, setPlaces] = useState<any[]>([]);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/inventory/locations').then(setPlaces).catch(() => setPlaces([]));
  }, []);

  useEffect(() => {
    if (!date) return;
    setLoading(true);
    api.get(`/api/inventory/valuation?date=${date}${place ? `&location=${place}` : ''}`)
      .then((report) => {
        setData(report);
        setError('');
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [date, place]);

  const placeName = places.find((row) => row.id === place)?.name;
  const difference = data && data.ledger !== null ? Number(data.value) - Number(data.ledger) : 0;
  const biggest = data ? Math.max(1, ...data.items.map((row: any) => Number(row.value))) : 1;
  const uncosted = data ? data.items.filter((row: any) => row.unit_cost === null && Number(row.quantity) > 0).length : 0;

  const download = () => downloadCsv(`stock-value-${date}${placeName ? `-${placeName}` : ''}.csv`, [
    ['SKU', 'Item', 'Category', 'Quantity', 'Unit', 'Cost each', 'Value'],
    ...data.items.map((row: any) => [row.sku, row.name, row.category, row.quantity, row.unit,
      row.unit_cost === null ? '' : Number(row.unit_cost), Number(row.value)])
  ]);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Stock value</h1>
          <p className="muted">What you held on a day, and what it was worth at cost.</p>
        </div>
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

      <p className="muted small">
        Worked out from every stock change up to that day.
        {placeName && ` For ${placeName}, value is its share of each item's value.`}
      </p>
      {error && <p className="error">{error}</p>}

      {!data && loading && <><SkeletonStats count={3} /><SkeletonTable rows={6} columns={5} /></>}
      {data && (
        <>
          <div className="stats" style={{ opacity: loading ? 0.6 : 1, transition: 'opacity var(--dur-2)' }}>
            <div className="card"><div className="stat-label">Stock value</div><div className="stat-value">{money(data.value)}</div><div className="muted">{count(data.items.length)} items held</div></div>
            <div className="card"><div className="stat-label">Units</div><div className="stat-value">{count(Number(data.quantity))}</div>
              {uncosted > 0 && <div className="muted"><span className="badge low">{uncosted} without a cost</span></div>}</div>
            {data.ledger !== null && (
              <div className="card">
                <div className="stat-label">Inventory account on that day</div>
                <div className="stat-value">{money(data.ledger)}</div>
                <div className="muted">
                  {Math.round(difference * 100) === 0 ? <span className="badge matched">Matches the stock value</span>
                    : `${money(Math.abs(difference))} apart. Stock moves when an invoice or bill is posted, and the books use its date.`}
                </div>
              </div>
            )}
          </div>

          {data.items.length === 0 ? (
            <div className="card"><EmptyState compact icon="inventory" title="No stock on that day" line="Pick a later date, or add items and stock first." /></div>
          ) : (
            <div className="card table-wrap">
              <table>
                <thead><tr><th>Item</th><th>SKU</th><th>Category</th><th className="num">Quantity</th><th className="num">Cost each</th><th className="num">Value</th></tr></thead>
                <tbody>
                  {data.items.map((row: any) => (
                    <tr key={row.item_id}>
                      <td className="wrap"><span className={styles.itemName}>{row.name}</span></td>
                      <td><span className={styles.sku}>{row.sku}</span></td>
                      <td>{row.category ? <span className="chip">{row.category}</span> : <span className="muted">—</span>}</td>
                      <td className="num">{row.quantity} <span className="muted">{row.unit}</span></td>
                      <td className="num">{row.unit_cost === null ? <span className="badge low">no cost</span> : money(row.unit_cost)}</td>
                      <td className="num">
                        <span className={styles.share}>
                          <span className={styles.shareTrack} aria-hidden="true"><span style={{ width: `${Math.max(0, Math.round((Number(row.value) / biggest) * 100))}%` }} /></span>
                          {money(row.value)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><td colSpan={5}><strong>Total</strong></td><td className="num"><strong>{money(data.value)}</strong></td></tr>
                </tfoot>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
