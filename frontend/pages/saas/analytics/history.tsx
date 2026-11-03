import { useEffect, useState } from 'react';
import AnalyticsNav, { Sparkline } from '@/components/AnalyticsNav';
import AppShell from '@/components/AppShell';
import { api, formatDate, money, today } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';

export default function History() {
  return <AppShell><HistoryApp /></AppShell>;
}

// Numbers that only exist "as of today", so a copy is kept each day
const NUMBERS = [
  { key: 'outstanding', label: 'Still to collect from customers', money: true },
  { key: 'overdue', label: 'Overdue from customers', money: true },
  { key: 'pipeline', label: 'Open pipeline', money: true },
  { key: 'pipeline_weighted', label: 'Pipeline, weighted by chance', money: true },
  { key: 'open_deals', label: 'Open deals', money: false },
  { key: 'open_leads', label: 'Open leads', money: false },
  { key: 'stock_value', label: 'Stock value', money: true },
  { key: 'low_stock', label: 'Items low or out of stock', money: false },
  { key: 'headcount', label: 'People employed', money: false },
  { key: 'open_chats', label: 'Open chats', money: false }
];

const RANGES = [30, 90, 180, 365];

function HistoryApp() {
  const [days, setDays] = useState(90);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/api/analytics/history?days=${days}`)
      .then((result) => {
        setData(result);
        setError('');
      })
      .catch((err) => setError(err.message));
  }, [days]);

  if (!data) return <div className="stack"><AnalyticsNav />{error ? <p className="error">{error}</p> : <p className="empty">Loading…</p>}</div>;

  // Stored days plus today's live numbers at the end
  const points = [...data.days, { day: today(), numbers: data.today }];
  const show = (item: typeof NUMBERS[number], value: number) =>
    (item.money ? money(value, data.currency) : Number(value).toLocaleString());

  const download = () => downloadCsv(`daily-numbers-${today()}.csv`, [
    ['Day', ...NUMBERS.map((item) => item.label)],
    ...points.map((point: any) => [point.day, ...NUMBERS.map((item) => Number(point.numbers[item.key] ?? 0))])
  ]);

  return (
    <div className="stack">
      <AnalyticsNav />
      <div className="page-head">
        <div>
          <h1>History</h1>
          <p className="muted">
            Some numbers, like money owed or the open pipeline, only exist as of today. A copy is saved every night so you can
            see how they moved. History starts on the day this was turned on.
          </p>
        </div>
        <div className="report-filters">
          <label>Show
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {RANGES.map((value) => <option key={value} value={value}>Last {value} days</option>)}
            </select>
          </label>
          <button onClick={download}>Download CSV</button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}

      <div className="chart-grid">
        {NUMBERS.map((item) => {
          const series = points.map((point: any) => ({ day: point.day, value: Number(point.numbers[item.key] ?? 0) }));
          const first = series[0]?.value ?? 0;
          const now = series[series.length - 1]?.value ?? 0;
          const moved = now - first;
          return (
            <div key={item.key} className="card">
              <div className="stat-label">{item.label}</div>
              <div className="stat-value">{show(item, now)}</div>
              {series.length > 1 && (
                <div className="muted">
                  {moved === 0 ? 'No change' : `${moved > 0 ? 'Up' : 'Down'} ${show(item, Math.abs(moved))}`} since {formatDate(series[0].day)}
                </div>
              )}
              <Sparkline points={series} label={`${item.label} over the last ${days} days`} />
            </div>
          );
        })}
      </div>
      <p className="muted">{data.days.length} saved {data.days.length === 1 ? 'day' : 'days'} in this range, plus today. Amounts are in {data.currency}.</p>
    </div>
  );
}
