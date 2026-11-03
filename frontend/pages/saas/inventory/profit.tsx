import Link from 'next/link';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { api, money } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { RANGES, rangeDates } from '@/lib/ranges';

const margin = (profit: number, revenue: number) => (revenue ? `${Math.round((profit / revenue) * 100)}%` : '—');

export default function Profit() {
  return <AppShell><ProfitApp /></AppShell>;
}

function ProfitApp() {
  const [range, setRange] = useState('month');
  const [[from, to], setDates] = useState(rangeDates('month'));
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!from || !to) return;
    api.get(`/api/inventory/profit?from=${from}&to=${to}`)
      .then((report) => {
        setData(report);
        setError('');
      })
      .catch((err) => setError(err.message));
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
          <Link href="/saas/inventory">← Inventory</Link>
          <h1>Profit by product</h1>
        </div>
        {data && data.items.length > 0 && <button onClick={download}>Download CSV</button>}
      </div>

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

      <p className="muted">
        Stock items on invoices dated in this period, in your main currency before tax. Cost is each item's average cost when the
        invoice was sent. Credit notes aren't split by item, so they aren't taken off here.
      </p>

      {error && <p className="error">{error}</p>}

      {data && (
        <>
          <div className="stats">
            <div className="card"><div className="stat-label">Sales</div><div className="stat-value">{money(data.revenue)}</div></div>
            <div className="card"><div className="stat-label">Cost of stock sold</div><div className="stat-value">{money(data.cost)}</div></div>
            <div className="card"><div className="stat-label">Gross profit</div><div className="stat-value">{money(data.profit)}</div><div className="muted">{margin(Number(data.profit), Number(data.revenue))} margin</div></div>
            <div className="card"><div className="stat-label">Stock value now</div><div className="stat-value">{money(data.stock_value)}</div></div>
          </div>

          <div className="card table-wrap">
            <table>
              <thead><tr><th>SKU</th><th>Item</th><th className="num">Sold</th><th className="num">Sales</th><th className="num">Cost</th><th className="num">Profit</th><th className="num">Margin</th><th className="num">On hand</th></tr></thead>
              <tbody>
                {data.items.length === 0 && <tr><td colSpan={8} className="empty">No stock sold in these dates</td></tr>}
                {data.items.map((row: any) => (
                  <tr key={row.item_id}>
                    <td>{row.sku}</td>
                    <td className="wrap">{row.name}</td>
                    <td className="num">{Number(row.sold)}</td>
                    <td className="num">{money(row.revenue)}</td>
                    <td className="num">{money(row.cost)}{Number(row.revenue) > 0 && !Number(row.cost) && <span className="badge low">no cost</span>}</td>
                    <td className="num">{money(row.profit)}</td>
                    <td className="num">{margin(Number(row.profit), Number(row.revenue))}</td>
                    <td className="num">{row.on_hand}</td>
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
