import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import AppShell from '@/components/AppShell';
import CrmNav from '@/components/CrmNav';
import { useTeam } from '@/components/CrmForms';
import { StatTile } from '@/components/CrmRecord';
import EmptyState from '@/components/EmptyState';
import { SkeletonStats, SkeletonTable } from '@/components/Skeleton';
import TargetsForm from '@/components/TargetsForm';
import { toast } from '@/components/Toast';
import styles from '@/styles/crm.module.css';
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
      toast.success('Forecast updated', { detail: `${deal.title}: ${category ? categoryName(category) : 'from the stage'}` });
      await load();
    } catch (err: any) {
      toast.error('Could not update the forecast', { detail: err.message });
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

      {!data && !error && <><SkeletonStats count={5} /><SkeletonTable rows={4} columns={6} /></>}

      {data && (
        <>
          <div className="stats">
            <StatTile label="Target" icon="target" value={target === null ? '—' : money(target)} note={target === null ? 'No target set' : `${monthName(from)} to ${monthName(to)}`} />
            <StatTile label="Won" icon="paid" tone="good" value={money(totals.won)} note={`${totals.won_deals} ${Number(totals.won_deals) === 1 ? 'deal' : 'deals'}`} />
            <StatTile label="Won and commit" icon="check" value={money(likely)} note={target === null ? 'Likely result' : likely >= target ? `${money(likely - target)} over target` : `${money(target - likely)} short of target`} />
            <StatTile label="Best case" icon="star" value={money(best)} note="Won, commit and best case" />
            <StatTile label="Weighted open" icon="deal" value={money(totals.weighted)} note="Open value × stage chance" />
          </div>

          <ForecastBar won={Number(totals.won)} commit={Number(totals.commit)} bestCase={Number(totals.best_case)} target={target} />

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
                {data.people.length === 0 && (
                  <tr><td colSpan={9}><EmptyState compact icon="target" title="Nothing in this period yet" line="Deals with an expected close in these months, and any targets, show up here."
                    action={{ label: 'Set targets', onClick: () => setTargets(true) }} /></td></tr>
                )}
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
                {deals.length === 0 && <tr><td colSpan={6} className="empty">{data.deals.length ? 'No deals match these filters' : 'No deals in this period'}</td></tr>}
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
                {data.slipped.length === 0 && <tr><td colSpan={6} className="empty">Nothing slipped. Every date held.</td></tr>}
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

      {targets && <TargetsForm month={from} members={members} onClose={() => setTargets(false)} onSaved={async () => { toast.success('Targets saved'); await load(); }} />}
    </div>
  );
}

// Won, commit and best case stacked on one bar, with the target marked
function ForecastBar({ won, commit, bestCase, target }: { won: number; commit: number; bestCase: number; target: number | null }) {
  const scale = Math.max(won + commit + bestCase, target || 0, 1);
  const pct = (value: number) => (Math.max(0, value) / scale) * 100;
  const parts = [
    { key: 'won', label: 'Won', value: won, className: styles.segWon },
    { key: 'commit', label: 'Commit', value: commit, className: styles.segCommit },
    { key: 'best', label: 'Best case', value: bestCase, className: styles.segBest }
  ];
  let x = 0;
  const reached = target ? Math.round(((won + commit) / target) * 100) : null;
  return (
    <section className="card" aria-labelledby="forecast-bar-title">
      <div className={styles.cardHead}>
        <div>
          <h2 id="forecast-bar-title">{reached === null ? 'Where the period stands' : `${reached}% of target won or committed`}</h2>
          <p className="muted">{target === null ? 'Set a target to see how close you are.' : `Target ${money(target)}`}</p>
        </div>
      </div>
      <div className={styles.progress}>
        <svg className={styles.progressSvg} role="img" aria-label={`Won ${money(won)}, commit ${money(commit)}, best case ${money(bestCase)}${target !== null ? `, target ${money(target)}` : ''}`}>
          <rect className={styles.segTrack} x="0" y="2" width="100%" height="14" rx="4" />
          {parts.map((part) => {
            const width = pct(part.value);
            const start = x;
            x += width;
            if (width <= 0) return null;
            return (
              <rect key={part.key} className={part.className} x={`${start}%`} y="2" width={`${width}%`} height="14" rx="4">
                <title>{`${part.label}: ${money(part.value)}`}</title>
              </rect>
            );
          })}
          {target !== null && target > 0 && <line className={styles.targetMark} x1={`${pct(target)}%`} x2={`${pct(target)}%`} y1="0" y2="18" />}
        </svg>
        <ul className={styles.legend}>
          {parts.map((part) => <li key={part.key}><span className={`${styles.swatch} ${part.className}`} />{part.label} {money(part.value)}</li>)}
          {target !== null && <li><span className={`${styles.swatch} ${styles.target}`} />Target {money(target)}</li>}
        </ul>
      </div>
    </section>
  );
}
