import Link from 'next/link';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { api, money } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';

// Whole calendar periods, so each one is compared with the same stretch just before it
const PERIODS = [
  { id: 'month', name: 'This month', compare: 'last month' },
  { id: 'last_month', name: 'Last month', compare: 'the month before' },
  { id: 'quarter', name: 'This quarter', compare: 'last quarter' },
  { id: 'year', name: 'This year', compare: 'last year' },
  { id: '12', name: 'Last 12 months', compare: 'the 12 months before' }
];

const day = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

const periodDates = (period: string): [string, string] => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const quarter = month - (month % 3);
  if (period === 'last_month') return [day(new Date(year, month - 1, 1)), day(new Date(year, month, 0))];
  if (period === 'quarter') return [day(new Date(year, quarter, 1)), day(new Date(year, quarter + 3, 0))];
  if (period === 'year') return [day(new Date(year, 0, 1)), day(new Date(year, 11, 31))];
  if (period === '12') return [day(new Date(year, month - 11, 1)), day(new Date(year, month + 1, 0))];
  return [day(new Date(year, month, 1)), day(new Date(year, month + 1, 0))];
};

const monthName = (value: string) =>
  new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });

const change = (now: number, before: number) => {
  if (!before) return now ? 'new this period' : 'no change';
  const percent = Math.round(((now - before) / Math.abs(before)) * 100);
  if (percent === 0) return 'no change';
  return `${percent > 0 ? '↑' : '↓'} ${Math.abs(percent)}%`;
};

export default function Analytics() {
  return <AppShell><Dashboard /></AppShell>;
}

function Dashboard() {
  const [period, setPeriod] = useState('month');
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const [from, to] = periodDates(period);
    setLoading(true);
    api.get(`/api/analytics/dashboard?from=${from}&to=${to}`)
      .then((result) => {
        setData(result);
        setError('');
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [period]);

  const compare = PERIODS.find(({ id }) => id === period)?.compare;
  const cash = (value: number | string) => money(value, data?.currency);

  const download = () => downloadCsv(`business-trend-${data.trend[data.trend.length - 1].month.slice(0, 7)}.csv`, [
    ['Month', 'Invoiced', 'Cash in', 'Cash out', 'Profit', 'New leads', 'Deals won', ...(data.sees_payroll ? ['Payroll cost'] : [])],
    ...data.trend.map((row: any) => [
      row.month.slice(0, 7), Number(row.revenue), Number(row.cash_in), Number(row.cash_out), Number(row.profit),
      Number(row.new_leads), Number(row.won_value), ...(data.sees_payroll ? [Number(row.payroll)] : [])
    ])
  ]);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Business dashboard</h1>
          <p className="muted">How the whole business is doing, from sales to stock and staff.</p>
        </div>
        <div className="report-filters">
          <label>Period
            <select value={period} onChange={(e) => setPeriod(e.target.value)}>
              {PERIODS.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {loading && !data && <p className="empty">Loading…</p>}

      {data && (
        <>
          <h2>Money</h2>
          <div className="stats">
            <Stat label="Invoiced (before tax)" value={cash(data.current.revenue)} now={data.current.revenue} before={data.previous.revenue} compare={compare} href="/saas/accounting" />
            <Stat label="Profit" value={cash(data.current.profit)} now={data.current.profit} before={data.previous.profit} compare={compare} href="/saas/accounting/reports"
              note={`${cash(data.current.income)} earned, ${cash(data.current.expenses)} spent`} />
            <Stat label="Cash in" value={cash(data.current.cash_in)} now={data.current.cash_in} before={data.previous.cash_in} compare={compare} href="/saas/accounting/banking" />
            <Stat label="Cash out" value={cash(data.current.cash_out)} now={data.current.cash_out} before={data.previous.cash_out} compare={compare} href="/saas/accounting/banking" />
            <Stat label="Overdue from customers" value={cash(data.receivables.overdue)} href="/saas/accounting"
              note={`${data.receivables.overdue_count} ${data.receivables.overdue_count === 1 ? 'invoice' : 'invoices'} late · ${cash(data.receivables.outstanding)} still to collect`} />
          </div>

          <h2>Sales</h2>
          <div className="stats">
            <Stat label="New leads" value={data.current.new_leads} now={data.current.new_leads} before={data.previous.new_leads} compare={compare} href="/saas/crm/leads" />
            <Stat label="Deals won" value={cash(data.current.won_value)} now={data.current.won_value} before={data.previous.won_value} compare={compare} href="/saas/crm/pipeline"
              note={`${data.current.won_deals} ${data.current.won_deals === 1 ? 'deal' : 'deals'}`} />
            <Stat label="Open pipeline" value={cash(data.pipeline.value)} href="/saas/crm/pipeline"
              note={`${data.pipeline.open_deals} open ${data.pipeline.open_deals === 1 ? 'deal' : 'deals'} · ${cash(data.pipeline.weighted)} likely`} />
          </div>

          <h2>Stock and staff</h2>
          <div className="stats">
            <Stat label="Stock value" value={cash(data.stock.value)} href="/saas/inventory" note={`${data.stock.items} ${data.stock.items === 1 ? 'item' : 'items'}`} />
            <Stat label="Low or out of stock" value={data.stock.low} href="/saas/inventory" note={data.stock.low ? 'Time to reorder' : 'All stocked up'} />
            <Stat label="People employed" value={data.people.headcount} now={data.people.headcount} before={data.people.previous} compare={compare} href="/saas/hr"
              note={`${data.people.joined} joined, ${data.people.left} left`} />
            {data.sees_payroll && (
              <Stat label="Payroll cost" value={cash(data.current.payroll)} now={data.current.payroll} before={data.previous.payroll} compare={compare} href="/saas/hr/payroll"
                note="Pay and employer costs" />
            )}
          </div>

          <h2>Last 12 months</h2>
          <div className="chart-grid">
            <div className="card">
              <BarChart title="Invoiced" rows={data.trend} series={[{ key: 'revenue', label: 'Invoiced', tone: 1 }]} format={cash} />
            </div>
            <div className="card">
              <BarChart title="Profit" rows={data.trend} series={[{ key: 'profit', label: 'Profit', tone: 1 }]} format={cash} />
            </div>
            <div className="card">
              <BarChart title="Cash in and out" rows={data.trend}
                series={[{ key: 'cash_in', label: 'Cash in', tone: 1 }, { key: 'cash_out', label: 'Cash out', tone: 2 }]} format={cash} />
            </div>
            <div className="card">
              <BarChart title="New leads" rows={data.trend} series={[{ key: 'new_leads', label: 'New leads', tone: 1 }]} format={(value) => String(value)} />
            </div>
          </div>

          <div className="card table-wrap">
            <div className="page-head">
              <h2>Month by month</h2>
              <button onClick={download}>Download CSV</button>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Month</th><th className="num">Invoiced</th><th className="num">Cash in</th><th className="num">Cash out</th>
                  <th className="num">Profit</th><th className="num">New leads</th><th className="num">Deals won</th>
                  {data.sees_payroll && <th className="num">Payroll cost</th>}
                </tr>
              </thead>
              <tbody>
                {data.trend.map((row: any) => (
                  <tr key={row.month}>
                    <td>{monthName(row.month)}</td>
                    <td className="num">{cash(row.revenue)}</td>
                    <td className="num">{cash(row.cash_in)}</td>
                    <td className="num">{cash(row.cash_out)}</td>
                    <td className="num">{cash(row.profit)}</td>
                    <td className="num">{row.new_leads}</td>
                    <td className="num">{cash(row.won_value)}</td>
                    {data.sees_payroll && <td className="num">{cash(row.payroll)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="chart-grid">
            <div className="card table-wrap">
              <div className="page-head"><h2>Top customers</h2><Link href="/saas/accounting/customers">All customers</Link></div>
              <table>
                <thead><tr><th>Customer</th><th className="num">Invoices</th><th className="num">Invoiced</th></tr></thead>
                <tbody>
                  {data.top_customers.length === 0 && <tr><td colSpan={3} className="empty">No invoices in this period</td></tr>}
                  {data.top_customers.map((row: any) => (
                    <tr key={`${row.customer_id}-${row.name}`}>
                      <td className="wrap">{row.name}</td>
                      <td className="num">{row.invoices}</td>
                      <td className="num">{cash(row.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card table-wrap">
              <div className="page-head"><h2>Top products by profit</h2><Link href="/saas/inventory/profit">Profit by product</Link></div>
              <table>
                <thead><tr><th>Item</th><th className="num">Sold</th><th className="num">Sales</th><th className="num">Profit</th></tr></thead>
                <tbody>
                  {data.top_products.length === 0 && <tr><td colSpan={4} className="empty">No stock sold in this period</td></tr>}
                  {data.top_products.map((row: any) => (
                    <tr key={row.item_id}>
                      <td className="wrap">{row.name}</td>
                      <td className="num">{Number(row.sold)}</td>
                      <td className="num">{cash(row.revenue)}</td>
                      <td className="num">{cash(row.profit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <p className="muted">
            Amounts are in {data.currency}. Invoiced counts sent invoices by their date, before tax. Profit is income minus
            expenses in your books. Cash in and out are money moving through your bank and cash accounts; transfers between
            them aren't counted. {!data.sees_payroll && 'Payroll totals are shown to owners and admins only.'}
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, note, now, before, compare, href }: {
  label: string;
  value: string | number;
  note?: string;
  now?: number | string;
  before?: number | string;
  compare?: string;
  href: string;
}) {
  return (
    <Link href={href} className="card stat-link">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {before !== undefined && <div className="muted">{change(Number(now), Number(before))} vs {compare}</div>}
      {note && <div className="muted">{note}</div>}
    </Link>
  );
}

type Series = { key: string; label: string; tone: 1 | 2 };

// Plain SVG bars on one axis. Negative values hang below the zero line.
function BarChart({ title, rows, series, format }: {
  title: string;
  rows: any[];
  series: Series[];
  format: (value: number) => string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const width = 600;
  const height = 200;
  const top = 8;
  const bottom = 22;
  const values = rows.flatMap((row) => series.map(({ key }) => Number(row[key]) || 0));
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const plot = height - top - bottom;
  const y = (value: number) => top + ((max - value) / span) * plot;
  const slot = width / rows.length;
  const gap = 2;
  const barWidth = Math.min(28, (slot * 0.7 - gap * (series.length - 1)) / series.length);
  const shown = active === null ? null : rows[active];

  return (
    <figure className="bar-chart">
      <figcaption>
        <strong>{title}</strong>
        <span className="muted">
          {shown
            ? `${monthName(shown.month)}: ${series.map(({ key, label }) => `${series.length > 1 ? `${label} ` : ''}${format(Number(shown[key]))}`).join(', ')}`
            : 'Point at a month to see its numbers'}
        </span>
      </figcaption>
      {series.length > 1 && (
        <div className="chart-legend">
          {series.map(({ key, label, tone }) => <span key={key}><i className={`swatch tone-${tone}`} />{label}</span>)}
        </div>
      )}
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title} for the last 12 months`} onMouseLeave={() => setActive(null)}>
        <line x1={0} x2={width} y1={y(0)} y2={y(0)} className="axis" />
        {rows.map((row, index) => {
          const groupWidth = barWidth * series.length + gap * (series.length - 1);
          const start = index * slot + (slot - groupWidth) / 2;
          return (
            <g key={row.month} className={active === index ? 'active' : ''}>
              {series.map(({ key, tone }, n) => {
                const value = Number(row[key]) || 0;
                const barTop = Math.min(y(value), y(0));
                const barHeight = Math.max(Math.abs(y(value) - y(0)), value ? 1 : 0);
                return <rect key={key} className={`bar tone-${tone}`} x={start + n * (barWidth + gap)} y={barTop} width={barWidth} height={barHeight} rx={2} />;
              })}
              {(index % 2 === rows.length % 2 || rows.length <= 6) && (
                <text x={index * slot + slot / 2} y={height - 6} textAnchor="middle" className="tick">{monthName(row.month)}</text>
              )}
              <rect className="hit" x={index * slot} y={0} width={slot} height={height}
                onMouseEnter={() => setActive(index)} onClick={() => setActive(index)}>
                <title>{`${monthName(row.month)}: ${series.map(({ key, label }) => `${label} ${format(Number(row[key]))}`).join(', ')}`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
