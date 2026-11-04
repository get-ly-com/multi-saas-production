import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import EmptyState from '@/components/EmptyState';
import InventoryNav from '@/components/InventoryNav';
import { SkeletonStats, SkeletonTable } from '@/components/Skeleton';
import { api, money } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import styles from '@/styles/inventory.module.css';
import { RANGES, rangeDates } from '@/lib/ranges';

const margin = (profit: number, revenue: number) => (revenue ? `${Math.round((profit / revenue) * 100)}%` : '—');

// Margin as a small bar: green healthy, amber thin (under 20%), red a loss
function MarginBar({ profit, revenue }: { profit: number; revenue: number }) {
  if (!revenue) return <span className="muted">—</span>;
  const percent = Math.round((profit / revenue) * 100);
  const tone = percent < 0 ? styles.loss : percent < 20 ? styles.thin : '';
  return (
    <span className={styles.marginBar}>
      <span className={styles.marginTrack} aria-hidden="true"><span className={tone} style={{ width: `${Math.min(100, Math.abs(percent))}%` }} /></span>
      {percent}%
    </span>
  );
}

export default function Profit() {
  return <AppShell><ProfitApp /></AppShell>;
}

function ProfitApp() {
  const [range, setRange] = useState('month');
  const [[from, to], setDates] = useState(rangeDates('month'));
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!from || !to) return;
    setLoading(true);
    api.get(`/api/inventory/profit?from=${from}&to=${to}`)
      .then((report) => {
        setData(report);
        setError('');
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [from, to]);

  const chooseRange = (id: string) => {
    setRange(id);
    if (id !== 'custom') setDates(rangeDates(id));
  };

  const download = () => downloadCsv(`product-profit-${from}-to-${to}.csv`, [
    ['SKU', 'Item', 'Sold', 'Sales', 'Cost', 'Profit', 'Margin', 'On hand', 'Stock value'],
    ...data.items.map((row: any) => [
      row.sku, row.name, Number(row.sold), Number(row.revenue), Number(row.cost), Number(row.profit),
      margin(Number(row.profit), Number(row.revenue)), row.on_hand, Number(row.stock_value)
    ])
  ]);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Profit by product</h1>
          <p className="muted">Which products earn the most, after what they cost you.</p>
        </div>
        {data && data.items.length > 0 && <button onClick={download}>Download CSV</button>}
      </div>
      <InventoryNav />

      <div className="report-filters">
        <label>Dates
          <select value={range} onChange={(e) => chooseRange(e.target.value)}>
            {RANGES.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        {range === 'custom' && (
          <>
            <label>From<input type="date" value={from} onChange={(e) => setDates([e.target.value, to])} /></label>
            <label>To<input type="date" value={to} onChange={(e) => setDates([from, e.target.value])} /></label>
          </>
        )}
      </div>

      <p className="muted small">
        Stock items on invoices dated in this period, in your main currency before tax. Cost is each item's average cost when the
        invoice was sent. Credit notes aren't split by item, so they aren't taken off here.
      </p>

      {error && <p className="error">{error}</p>}

      {!data && loading && <><SkeletonStats count={4} /><SkeletonTable rows={6} columns={6} /></>}
      {data && (
        <>
          <div className="stats" style={{ opacity: loading ? 0.6 : 1, transition: 'opacity var(--dur-2)' }}>
            <div className="card"><div className="stat-label">Sales</div><div className="stat-value">{money(data.revenue)}</div></div>
            <div className="card"><div className="stat-label">Cost of stock sold</div><div className="stat-value">{money(data.cost)}</div></div>
            <div className="card"><div className="stat-label">Gross profit</div><div className="stat-value">{money(data.profit)}</div><div className="muted">{margin(Number(data.profit), Number(data.revenue))} margin</div></div>
            <div className="card"><div className="stat-label">Stock value now</div><div className="stat-value">{money(data.stock_value)}</div></div>
          </div>

          {data.items.length === 0 ? (
            <div className="card"><EmptyState compact icon="deal" title="No stock sold in these dates" line="Try a longer date range. Sales show up here once invoices with stock items are sent." /></div>
          ) : (
          <div className="card table-wrap">
            <table>
              <thead><tr><th>Item</th><th>SKU</th><th className="num">Sold</th><th className="num">Sales</th><th className="num">Cost</th><th className="num">Profit</th><th className="num">Margin</th><th className="num">On hand</th></tr></thead>
              <tbody>
                {data.items.map((row: any) => (
                  <tr key={row.item_id}>
                    <td className="wrap"><span className={styles.itemName}>{row.name}</span></td>
                    <td><span className={styles.sku}>{row.sku}</span></td>
                    <td className="num">{Number(row.sold)}</td>
                    <td className="num">{money(row.revenue)}</td>
                    <td className="num">{money(row.cost)}{Number(row.revenue) > 0 && !Number(row.cost) && <> <span className="badge low">no cost</span></>}</td>
                    <td className={`num ${Number(row.profit) < 0 ? 'late' : ''}`}><strong>{money(row.profit)}</strong></td>
                    <td className="num"><MarginBar profit={Number(row.profit)} revenue={Number(row.revenue)} /></td>
                    <td className="num">{row.on_hand}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3}><strong>Total</strong></td>
                  <td className="num"><strong>{money(data.revenue)}</strong></td>
                  <td className="num"><strong>{money(data.cost)}</strong></td>
                  <td className="num"><strong>{money(data.profit)}</strong></td>
                  <td className="num"><strong>{margin(Number(data.profit), Number(data.revenue))}</strong></td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          )}
        </>
      )}
    </div>
  );
}
