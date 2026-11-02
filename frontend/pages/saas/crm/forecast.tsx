import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import AppShell from '@/components/AppShell';
import CrmNav from '@/components/CrmNav';
import { useTeam } from '@/components/CrmForms';
import TargetsForm from '@/components/TargetsForm';
import { api, formatDate, money } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { CATEGORIES, addMonths, automaticCategory, categoryName, monthName, monthOf } from '@/lib/forecast';

const PERIODS = [
  { id: 'month', name: 'This month' },
  { id: 'next_month', name: 'Next month' },
  { id: 'quarter', name: 'This quarter' },
  { id: 'next_quarter', name: 'Next quarter' },
  { id: 'year', name: 'This year' },
  { id: 'custom', name: 'Choose months' }
];

const periodMonths = (period: string): [string, string] => {
  const now = monthOf(new Date());
  const quarterStart = addMonths(now, -((Number(now.slice(5)) - 1) % 3));
  if (period === 'next_month') return [addMonths(now, 1), addMonths(now, 1)];
  if (period === 'quarter') return [quarterStart, addMonths(quarterStart, 2)];
  if (period === 'next_quarter') return [addMonths(quarterStart, 3), addMonths(quarterStart, 5)];
  if (period === 'year') return [`${now.slice(0, 4)}-01`, `${now.slice(0, 4)}-12`];
  return [now, now];
};

const percent = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—');

export default function Forecast() {
  return <AppShell><ForecastApp /></AppShell>;
}

function ForecastApp() {
  const members = useTeam();
  const [period, setPeriod] = useState('quarter');
  const [range, setRange] = useState(periodMonths('quarter'));
  const [pipeline, setPipeline] = useState('');
  const [pipelines, setPipelines] = useState<any[]>([]);
  const [data, setData] = useState<any>(null);
  const [filters, setFilters] = useState({ owner: '', category: '' });
  const [targets, setTargets] = useState(false);
  const [error, setError] = useState('');

  const [from, to] = range;

  const load = async () => {
    if (!from || !to) return;
    try {
      setData(await api.get(`/api/crm/forecast?from=${from}&to=${to}${pipeline ? `&pipeline=${pipeline}` : ''}`));
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    api.get('/api/crm/pipelines').then(setPipelines).catch(() => setPipelines([]));
  }, []);

  useEffect(() => {
    load();
  }, [from, to, pipeline]);

  const choosePeriod = (id: string) => {
    setPeriod(id);
    if (id !== 'custom') setRange(periodMonths(id));
  };

  const person = (id: string | null) =>
    id ? members.find(({ user_id }) => user_id === id)?.email || 'Former member' : 'Unassigned';

  const setCategory = async (deal: any, category: string) => {
    try {
      await api.put(`/api/crm/deals/${deal.id}`, { forecast_category: category });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const deals = useMemo(() => (data?.deals || []).filter((deal: any) => {
    if (filters.owner && (deal.owner_id || 'none') !== filters.owner) return false;
    if (filters.category && deal.category !== filters.category) return false;
    return true;
  }), [data, filters]);

  const download = () => downloadCsv(`forecast-${from}-to-${to}.csv`, [
    ['Deal', 'Owner', 'Pipeline', 'Stage', 'Chance %', 'Forecast', 'Chosen or from stage', 'Expected close', 'Closed', 'Value'],
    ...deals.map((deal: any) => [
      deal.title, person(deal.owner_id), deal.pipeline_name, deal.stage_name, deal.probability, categoryName(deal.category),
      deal.kind === 'open' ? (deal.automatic ? 'From stage' : 'Chosen') : '', deal.expected_close, deal.closed_at?.slice(0, 10), deal.value
    ])
  ]);

  const totals = data?.totals;
  const target = totals?.target === null || totals?.target === undefined ? null : Number(totals.target);
  const likely = totals ? Number(totals.won) + Number(totals.commit) : 0;
  const best = totals ? likely + Number(totals.best_case) : 0;

  return (
    <div className="stack">
      <CrmNav />
      <div className="page-head">
        <h1>Forecast</h1>
        <div className="row-actions">
          <button onClick={download} disabled={!deals.length}>Download CSV</button>
          <button className="primary" onClick={() => setTargets(true)}>Set targets</button>
        </div>
      </div>

      <div className="report-filters">
        <label>Period
          <select value={period} onChange={(e) => choosePeriod(e.target.value)}>
            {PERIODS.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        {period === 'custom' && (
          <>
            <label>From<input type="month" value={from} onChange={(e) => setRange([e.target.value, to])} /></label>
            <label>To<input type="month" value={to} onChange={(e) => setRange([from, e.target.value])} /></label>
          </>
        )}
        <label>Pipeline
          <select value={pipeline} onChange={(e) => setPipeline(e.target.value)}>
            <option value="">All pipelines</option>
            {pipelines.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
      </div>

      <p className="muted">
        Won counts deals closed in the period. Open deals count in the month of their expected close.
        Commit is what the deal owner says will close. Otherwise the stage's chance decides: 90% or more is Commit, 50% or more is Best case, and the rest is Pipeline.
        Dates follow UTC.
      </p>

      {error && <p className="error">{error}</p>}

      {data && (
        <>
          <div className="stats">
            <div className="card"><div className="stat-label">Target</div><div className="stat-value">{target === null ? '—' : money(target)}</div><div className="muted">{target === null ? 'No target set' : `${monthName(from)} to ${monthName(to)}`}</div></div>
            <div className="card"><div className="stat-label">Won</div><div className="stat-value">{money(totals.won)}</div><div className="muted">{totals.won_deals} {Number(totals.won_deals) === 1 ? 'deal' : 'deals'}</div></div>
            <div className="card"><div className="stat-label">Won and commit</div><div className="stat-value">{money(likely)}</div><div className="muted">{target === null ? 'Likely result' : likely >= target ? `${money(likely - target)} over target` : `${money(target - likely)} short of target`}</div></div>
            <div className="card"><div className="stat-label">Best case</div><div className="stat-value">{money(best)}</div><div className="muted">Won, commit and best case</div></div>
            <div className="card"><div className="stat-label">Weighted open</div><div className="stat-value">{money(totals.weighted)}</div><div className="muted">Open value × stage chance</div></div>
          </div>

          {(Number(data.late.deals) > 0 || Number(data.undated.deals) > 0) && (
            <div className="card">
              {Number(data.late.deals) > 0 && <p>{data.late.deals} open {Number(data.late.deals) === 1 ? 'deal is' : 'deals are'} past an expected close before this period ({money(data.late.value)}), so not counted here. Give {Number(data.late.deals) === 1 ? 'it' : 'them'} a new date.</p>}
              {Number(data.undated.deals) > 0 && <p>{data.undated.deals} open {Number(data.undated.deals) === 1 ? 'deal has' : 'deals have'} no expected close ({money(data.undated.value)}), so {Number(data.undated.deals) === 1 ? "it isn't" : "they aren't"} in any month.</p>}
            </div>
          )}

          <div className="card table-wrap">
            <h2>By person</h2>
            <table>
              <thead><tr><th>Person</th><th className="num">Target</th><th className="num">Won</th><th className="num">Commit</th><th className="num">Best case</th><th className="num">Pipeline</th><th className="num">Weighted</th><th className="num">Won and commit</th><th className="num">Of target</th></tr></thead>
              <tbody>
                {data.people.length === 0 && <tr><td colSpan={9} className="empty">No deals or targets in this period</td></tr>}
                {data.people.map((row: any) => {
                  const sure = Number(row.won) + Number(row.commit);
                  return (
                    <tr key={row.user_id || 'none'}>
                      <td className="wrap">{person(row.user_id)}</td>
                      <td className="num">{row.target === null ? '—' : money(row.target)}</td>
                      <td className="num">{money(row.won)}</td>
                      <td className="num">{money(row.commit)}</td>
                      <td className="num">{money(row.best_case)}</td>
                      <td className="num">{money(row.pipeline)}</td>
                      <td className="num">{money(row.weighted)}</td>
                      <td className="num">{money(sure)}</td>
                      <td className="num">{row.target === null ? '—' : percent(sure, Number(row.target))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="card table-wrap">
            <h2>By month</h2>
            <table>
              <thead><tr><th>Month</th><th className="num">Target</th><th className="num">Won</th><th className="num">Commit</th><th className="num">Best case</th><th className="num">Pipeline</th><th className="num">Won and commit, of target</th></tr></thead>
              <tbody>
                {data.months.map((row: any) => (
                  <tr key={row.month}>
                    <td>{monthName(row.month)}</td>
                    <td className="num">{row.target === null ? '—' : money(row.target)}</td>
                    <td className="num">{money(row.won)}</td>
                    <td className="num">{money(row.commit)}</td>
                    <td className="num">{money(row.best_case)}</td>
                    <td className="num">{money(row.pipeline)}</td>
                    <td className="num">{row.target === null ? '—' : percent(Number(row.won) + Number(row.commit), Number(row.target))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card table-wrap">
            <h2>Deals</h2>
            <div className="report-filters">
              <label>Person
                <select value={filters.owner} onChange={(e) => setFilters({ ...filters, owner: e.target.value })}>
                  <option value="">Everyone</option>
                  {Array.from(new Set<string>(data.deals.map((deal: any) => deal.owner_id || 'none'))).map((id) => (
                    <option key={id} value={id}>{person(id === 'none' ? null : id)}</option>
                  ))}
                </select>
              </label>
              <label>Forecast
                <select value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}>
                  <option value="">Any</option>
                  <option value="won">Won</option>
                  {CATEGORIES.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
                </select>
              </label>
            </div>
            <table>
              <thead><tr><th>Deal</th><th>Owner</th><th>Stage</th><th>Close</th><th>Forecast</th><th className="num">Value</th></tr></thead>
              <tbody>
                {deals.length === 0 && <tr><td colSpan={6} className="empty">No deals</td></tr>}
                {deals.map((deal: any) => (
                  <tr key={deal.id}>
                    <td className="wrap"><Link href={`/saas/crm/deal/${deal.id}`}>{deal.title}</Link></td>
                    <td className="wrap">{person(deal.owner_id)}</td>
                    <td>{deal.stage_name} <span className="muted">{deal.probability}%</span></td>
                    <td>{formatDate(deal.kind === 'won' ? deal.closed_at : deal.expected_close)}</td>
                    <td>
                      {deal.kind === 'won' ? <span className="badge won">Won</span> : (
                        <select aria-label={`Forecast for ${deal.title}`} value={deal.automatic ? '' : deal.category} onChange={(e) => setCategory(deal, e.target.value)}>
                          <option value="">{categoryName(automaticCategory(deal.probability))} (from the stage)</option>
                          {CATEGORIES.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
                        </select>
                      )}
                    </td>
                    <td className="num">{money(deal.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {Number(data.deal_count) > data.deals.length && <p className="muted">Showing the first {data.deals.length} of {data.deal_count} deals.</p>}
          </div>

          <div className="card table-wrap">
            <h2>Slipped out</h2>
            <p className="muted">Open deals whose expected close moved out of this period in the last 30 days.</p>
            <table>
              <thead><tr><th>Deal</th><th>Owner</th><th>Was due</th><th>Now due</th><th>Moved</th><th className="num">Value</th></tr></thead>
              <tbody>
                {data.slipped.length === 0 && <tr><td colSpan={6} className="empty">Nothing slipped</td></tr>}
                {data.slipped.map((deal: any) => (
                  <tr key={deal.id}>
                    <td className="wrap"><Link href={`/saas/crm/deal/${deal.id}`}>{deal.title}</Link></td>
                    <td className="wrap">{person(deal.owner_id)}</td>
                    <td>{formatDate(deal.from_close)}</td>
                    <td>{deal.to_close ? formatDate(deal.to_close) : 'No date'}</td>
                    <td>{formatDate(deal.changed_at)}</td>
                    <td className="num">{money(deal.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {targets && <TargetsForm month={from} members={members} onClose={() => setTargets(false)} onSaved={load} />}
    </div>
  );
}
