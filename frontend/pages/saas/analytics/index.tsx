import Link from 'next/link';
import { useEffect, useState } from 'react';
import AnalyticsNav, { Delta, PERIODS, Ring, periodDates, yearBefore } from '@/components/AnalyticsNav';
import AppShell from '@/components/AppShell';
import EmptyState from '@/components/EmptyState';
import Icon from '@/components/Icon';
import Skeleton, { SkeletonStats } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api, money } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { compactMoney } from '@/lib/format';
import a from '@/styles/analytics.module.css';

const monthName = (value: string) =>
  new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });


export default function Analytics() {
  return <AppShell><Dashboard /></AppShell>;
}

function Dashboard() {
  const [period, setPeriod] = useState('month');
  const [range, setRange] = useState<[string, string]>(() => periodDates('month'));
  const [compareTo, setCompareTo] = useState<'before' | 'last_year'>('before');
  const [data, setData] = useState<any>(null);
  const [goals, setGoals] = useState<any>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const [from, to] = period === 'custom' ? range : periodDates(period);

  useEffect(() => {
    if (!from || !to || from > to) {
      setError('Choose a start date before the end date');
      return;
    }
    let current = true;
    setLoading(true);
    // The dashboard always compares with the stretch just before; for last year its
    // comparison numbers are swapped for the same dates a year earlier.
    Promise.all([
      api.get(`/api/analytics/dashboard?from=${from}&to=${to}`),
      compareTo === 'last_year' ? api.get(`/api/analytics/compare?from=${yearBefore(from)}&to=${yearBefore(to)}`) : null
    ])
      .then(([result, earlier]) => {
        if (!current) return;
        setData(earlier ? {
          ...result,
          previous: earlier.totals,
          marketing: result.marketing && { ...result.marketing, previous: earlier.marketing }
        } : result);
        setError('');
      })
      .catch((err) => current && setError(err.message))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [from, to, compareTo]);

  // This month's goals, if any are set
  useEffect(() => {
    api.get('/api/analytics/goals').then(setGoals).catch(() => setGoals(null));
  }, []);

  const choosePeriod = (value: string) => {
    if (value === 'custom') setRange(periodDates(period));
    setPeriod(value);
  };

  const compare = compareTo === 'last_year'
    ? 'the same dates last year'
    : PERIODS.find(({ id }) => id === period)?.compare;
  const cash = (value: number | string) => money(value, data?.currency);
  const shortCash = (value: number) => compactMoney(value, data?.currency);
  const shortCount = (value: number) => Math.round(value).toLocaleString();

  const download = () => { saveCsv(); toast.success('CSV downloaded', { detail: 'Twelve months of numbers, one row a month.' }); };
  const saveCsv = () => downloadCsv(`business-trend-${data.trend[data.trend.length - 1].month.slice(0, 7)}.csv`, [
    ['Month', 'Invoiced', 'Cash in', 'Cash out', 'Profit', 'New leads', 'Deals won', 'Bookings', 'Chats', ...(data.sees_payroll ? ['Payroll cost'] : [])],
    ...data.trend.map((row: any) => [
      row.month.slice(0, 7), Number(row.revenue), Number(row.cash_in), Number(row.cash_out), Number(row.profit),
      Number(row.new_leads), Number(row.won_value), Number(row.bookings || 0), Number(row.chats || 0),
      ...(data.sees_payroll ? [Number(row.payroll)] : [])
    ])
  ]);

  const marketing = data?.marketing;
  const plural = (count: number, one: string, many: string) => `${count} ${Number(count) === 1 ? one : many}`;
  const replyTime = (minutes: number | null) => {
    if (minutes === null || minutes === undefined) return 'No staff replies yet';
    const value = Number(minutes);
    if (value < 1) return 'Under a minute';
    if (value < 60) return `${Math.round(value)} min`;
    return `${Math.floor(value / 60)} h ${Math.round(value % 60)} min`;
  };

  return (
    <div className="stack">
      <AnalyticsNav />
      <div className="page-head">
        <div>
          <h1>Business dashboard</h1>
          <p className="muted">How the whole business is doing, from sales to stock and staff.</p>
        </div>
        <div className="report-filters">
          <label>Period
            <select value={period} onChange={(e) => choosePeriod(e.target.value)}>
              {PERIODS.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
          {period === 'custom' && (
            <>
              <label>From<input type="date" value={range[0]} max={range[1]} onChange={(e) => setRange([e.target.value, range[1]])} /></label>
              <label>To<input type="date" value={range[1]} min={range[0]} onChange={(e) => setRange([range[0], e.target.value])} /></label>
            </>
          )}
          <label>Compare with
            <select value={compareTo} onChange={(e) => setCompareTo(e.target.value as 'before' | 'last_year')}>
              <option value="before">The period before</option>
              <option value="last_year">The same dates last year</option>
            </select>
          </label>
        </div>
      </div>

      {goals?.goals?.length > 0 && (
        <Link href="/saas/analytics/goals" className={a.goalStrip}>
          <span className={a.goalStripHead}>This month&apos;s goals<Icon name="chevron-right" size={14} /></span>
          <span className={a.goalItems}>
            {goals.goals.map((goal: any) => {
              const metric = goals.metrics.find((item: any) => item.key === goal.metric);
              const behind = Number(goal.actual) < Number(goal.expected);
              return (
                <span key={goal.metric} className={a.goalItem}>
                  <Ring percent={Number(goal.percent)} size={44} stroke={5} behind={behind} />
                  <span><strong>{metric?.label || goal.metric}</strong><br /><span className="muted small">{Number(goal.percent) >= 100 ? 'Reached' : behind ? 'Behind pace' : 'On track'}</span></span>
                </span>
              );
            })}
          </span>
        </Link>
      )}

      {error && <p className="error">{error}</p>}
      {loading && !data && !error && (
        <div className="stack" aria-busy="true" aria-label="Loading the dashboard">
          <SkeletonStats count={5} />
          <SkeletonStats count={3} />
          <div className="chart-grid">{[0, 1].map((n) => <div key={n} className="card"><Skeleton width="30%" height={14} /><Skeleton height={180} radius={8} style={{ marginTop: 12 }} /></div>)}</div>
        </div>
      )}

      {data && (
        <>
          <div className={a.section}><h2>Money</h2></div>
          <div className={a.tiles}>
            <Stat label="Invoiced (before tax)" value={cash(data.current.revenue)} now={data.current.revenue} before={data.previous.revenue} compare={compare} href="/saas/accounting" />
            <Stat label="Profit" value={cash(data.current.profit)} now={data.current.profit} before={data.previous.profit} compare={compare} href="/saas/accounting/reports"
              note={`${cash(data.current.income)} earned, ${cash(data.current.expenses)} spent`} />
            <Stat label="Cash in" value={cash(data.current.cash_in)} now={data.current.cash_in} before={data.previous.cash_in} compare={compare} href="/saas/accounting/banking" />
            <Stat label="Cash out" value={cash(data.current.cash_out)} now={data.current.cash_out} before={data.previous.cash_out} compare={compare} href="/saas/accounting/banking" upIsGood={false} />
            <Stat label="Overdue from customers" value={cash(data.receivables.overdue)} href="/saas/accounting"
              note={`${data.receivables.overdue_count} ${data.receivables.overdue_count === 1 ? 'invoice' : 'invoices'} late · ${cash(data.receivables.outstanding)} still to collect`} />
          </div>

          <div className={a.section}><h2>Sales</h2></div>
          <div className={a.tiles}>
            <Stat label="New leads" value={data.current.new_leads} now={data.current.new_leads} before={data.previous.new_leads} compare={compare} href="/saas/crm/leads" />
            <Stat label="Deals won" value={cash(data.current.won_value)} now={data.current.won_value} before={data.previous.won_value} compare={compare} href="/saas/crm/pipeline"
              note={`${data.current.won_deals} ${data.current.won_deals === 1 ? 'deal' : 'deals'}`} />
            <Stat label="Open pipeline" value={cash(data.pipeline.value)} href="/saas/crm/pipeline"
              note={`${data.pipeline.open_deals} open ${data.pipeline.open_deals === 1 ? 'deal' : 'deals'} · ${cash(data.pipeline.weighted)} likely`} />
          </div>

          {marketing && (
            <>
              <div className={a.section}><h2>Customers and marketing</h2></div>
              <div className={a.tiles}>
                <Stat label="Bookings made" value={marketing.current.bookings} now={marketing.current.bookings} before={marketing.previous.bookings} compare={compare} href="/saas/scheduler"
                  note={`${cash(marketing.current.booking_value)} at service prices · ${plural(marketing.current.cancellations, 'cancellation', 'cancellations')}`} />
                <Stat label="Booked for the next 7 days" value={marketing.upcoming.bookings} href="/saas/scheduler"
                  note={`${cash(marketing.upcoming.value)} at service prices`} />
                <Stat label="Chats started" value={marketing.current.chats} now={marketing.current.chats} before={marketing.previous.chats} compare={compare} href="/saas/chat"
                  note={`${marketing.current.chats_wanted_person} asked for a person · ${plural(marketing.current.chat_leads, 'lead', 'leads')} from chat`} />
                <Stat label="First staff reply" value={replyTime(marketing.current.first_reply_minutes)} href="/saas/chat"
                  note="Average time from the visitor's first message" />
                <Stat label="Social posts posted" value={marketing.current.posts} now={marketing.current.posts} before={marketing.previous.posts} compare={compare} href="/saas/social" />
              </div>
            </>
          )}

          <div className={a.section}><h2>Stock and staff</h2></div>
          <div className={a.tiles}>
            <Stat label="Stock value" value={cash(data.stock.value)} href="/saas/inventory" note={`${data.stock.items} ${data.stock.items === 1 ? 'item' : 'items'}`} />
            <Stat label="Low or out of stock" value={data.stock.low} href="/saas/inventory" note={data.stock.low ? 'Time to reorder' : 'All stocked up'} />
            <Stat label="People employed" value={data.people.headcount} now={data.people.headcount} before={data.people.previous}
              compare={compareTo === 'last_year' ? 'the end of the period before' : compare} href="/saas/hr"
              note={`${data.people.joined} joined, ${data.people.left} left`} />
            {data.sees_payroll && (
              <Stat label="Payroll cost" value={cash(data.current.payroll)} now={data.current.payroll} before={data.previous.payroll} compare={compare} href="/saas/hr/payroll" upIsGood={false}
                note="Pay and employer costs" />
            )}
          </div>

          <div className={a.section}><h2>Last 12 months</h2></div>
          <div className="chart-grid">
            <div className={`card ${a.chartCard}`}>
              <BarChart title="Invoiced" rows={data.trend} series={[{ key: 'revenue', label: 'Invoiced', tone: 1 }]} format={cash} short={shortCash} />
            </div>
            <div className={`card ${a.chartCard}`}>
              <BarChart title="Profit" rows={data.trend} series={[{ key: 'profit', label: 'Profit', tone: 1 }]} format={cash} short={shortCash} />
            </div>
            <div className={`card ${a.chartCard}`}>
              <BarChart title="Cash in and out" rows={data.trend}
                series={[{ key: 'cash_in', label: 'Cash in', tone: 1 }, { key: 'cash_out', label: 'Cash out', tone: 2 }]} format={cash} short={shortCash} />
            </div>
            <div className={`card ${a.chartCard}`}>
              <BarChart title="New leads" rows={data.trend} series={[{ key: 'new_leads', label: 'New leads', tone: 1 }]} format={(value) => String(value)} short={shortCount} />
            </div>
          </div>

          <div className="card table-wrap">
            <div className="page-head">
              <h2>Month by month</h2>
              <button className="small" onClick={download}><Icon name="import" size={14} />Download CSV</button>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Month</th><th className="num">Invoiced</th><th className="num">Cash in</th><th className="num">Cash out</th>
                  <th className="num">Profit</th><th className="num">New leads</th><th className="num">Deals won</th>
                  <th className="num">Bookings</th><th className="num">Chats</th>
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
                    <td className="num">{row.bookings ?? 0}</td>
                    <td className="num">{row.chats ?? 0}</td>
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
                  {data.top_customers.length === 0 && <tr><td colSpan={3} style={{ padding: 0 }}><EmptyState compact icon="invoice" title="No invoices in this period" line="Customers you invoice will rank here." /></td></tr>}
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
                  {data.top_products.length === 0 && <tr><td colSpan={4} style={{ padding: 0 }}><EmptyState compact icon="inventory" title="No stock sold in this period" line="Products you sell will rank here by profit." /></td></tr>}
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
            them aren't counted. Bookings count bookings made in the period that are still on, valued at each service's
            price. {!data.sees_payroll && 'Payroll totals are shown to owners and admins only.'}
          </p>
        </>
      )}
    </div>
  );
}


function Stat({ label, value, note, now, before, compare, href, upIsGood = true }: {
  label: string;
  value: string | number;
  note?: string;
  now?: number | string;
  before?: number | string;
  compare?: string;
  href: string;
  upIsGood?: boolean;
}) {
  return (
    <Link href={href} className={a.tile}>
      <span className={a.tileLabel}>{label}<Icon name="chevron-right" size={14} /></span>
      <span className={a.tileValue}>{value}</span>
      {before !== undefined && (
        <span className={a.tileFoot}><Delta now={now ?? 0} before={before} upIsGood={upIsGood} />vs {compare}</span>
      )}
      {note && <span className={a.tileNote}>{note}</span>}
    </Link>
  );
}

type Series = { key: string; label: string; tone: 1 | 2 };

// Plain SVG bars on one axis, with light gridlines. Negative values hang below the zero line.
function BarChart({ title, rows, series, format, short }: {
  title: string;
  rows: any[];
  series: Series[];
  format: (value: number) => string;
  short?: (value: number) => string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const width = 600;
  const height = 210;
  const left = 46;
  const top = 10;
  const bottom = 24;
  const values = rows.flatMap((row) => series.map(({ key }) => Number(row[key]) || 0));
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const plot = height - top - bottom;
  const y = (value: number) => top + ((max - value) / span) * plot;
  const slot = (width - left) / rows.length;
  const gap = 3;
  const barWidth = Math.min(26, (slot * 0.62 - gap * (series.length - 1)) / series.length);
  const shown = active === null ? null : rows[active];
  const label = short || format;
  const lines = [0, 0.5, 1].map((share) => min + span * share).filter((value, n, all) => all.indexOf(value) === n);
  const total = rows.reduce((sum, row) => sum + (Number(row[series[0].key]) || 0), 0);

  return (
    <figure className={a.chart}>
      <figcaption className={a.chartHead}>
        <strong>{title}</strong>
        <span className={a.readout}>
          {shown
            ? <><b>{monthName(shown.month)}</b> {series.map(({ key, label: name }) => `${series.length > 1 ? `${name} ` : ''}${format(Number(shown[key]))}`).join(', ')}</>
            : series.length === 1 ? <>12 months: <b>{format(total)}</b></> : 'Point at a month to see its numbers'}
        </span>
      </figcaption>
      {series.length > 1 && (
        <div className={a.legend}>
          {series.map(({ key, label: name, tone }) => <span key={key}><i className={tone === 2 ? a.tone2 : a.tone1} />{name}</span>)}
        </div>
      )}
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title} for the last 12 months`} onMouseLeave={() => setActive(null)}>
        {lines.map((value) => (
          <g key={value}>
            <line x1={left} x2={width} y1={y(value)} y2={y(value)} className={value === 0 ? a.zero : a.grid} />
            <text x={left - 8} y={y(value) + 4} textAnchor="end" className={a.tick}>{label(value)}</text>
          </g>
        ))}
        {min < 0 && max > 0 && <line x1={left} x2={width} y1={y(0)} y2={y(0)} className={a.zero} />}
        {rows.map((row, index) => {
          const groupWidth = barWidth * series.length + gap * (series.length - 1);
          const x0 = left + index * slot;
          const start = x0 + (slot - groupWidth) / 2;
          return (
            <g key={row.month} className={active === index ? a.on : ''}>
              <rect className={a.column} x={x0 + 2} y={top - 4} width={slot - 4} height={plot + 8} rx={6} />
              {series.map(({ key, tone }, n) => {
                const value = Number(row[key]) || 0;
                const barTop = Math.min(y(value), y(0));
                const barHeight = Math.max(Math.abs(y(value) - y(0)), value ? 2 : 0);
                return <rect key={key} className={`${a.bar} ${tone === 2 ? a.tone2 : a.tone1} ${value < 0 ? a.negative : ''}`}
                  x={start + n * (barWidth + gap)} y={barTop} width={barWidth} height={barHeight} rx={Math.min(4, barWidth / 2)} />;
              })}
              {(index % 2 === rows.length % 2 || rows.length <= 6) && (
                <text x={x0 + slot / 2} y={height - 6} textAnchor="middle" className={a.tick}>{monthName(row.month)}</text>
              )}
              <rect className={a.hit} x={x0} y={0} width={slot} height={height}
                onMouseEnter={() => setActive(index)} onClick={() => setActive(index)}>
                <title>{`${monthName(row.month)}: ${series.map(({ key, label: name }) => `${name} ${format(Number(row[key]))}`).join(', ')}`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
