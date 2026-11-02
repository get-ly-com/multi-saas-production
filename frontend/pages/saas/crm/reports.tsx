import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import CrmNav from '@/components/CrmNav';
import { useTeam } from '@/components/CrmForms';
import { api, money, today } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { monthName } from '@/lib/forecast';

const RANGES = [
  { id: '30', name: 'Last 30 days' },
  { id: 'month', name: 'This month' },
  { id: 'last_month', name: 'Last month' },
  { id: 'quarter', name: 'This quarter' },
  { id: 'last_quarter', name: 'Last quarter' },
  { id: 'year', name: 'This year' },
  { id: 'custom', name: 'Choose dates' }
];

const day = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

const rangeDates = (range: string): [string, string] => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const quarter = month - (month % 3);
  if (range === 'month') return [day(new Date(year, month, 1)), today()];
  if (range === 'last_month') return [day(new Date(year, month - 1, 1)), day(new Date(year, month, 0))];
  if (range === 'quarter') return [day(new Date(year, quarter, 1)), today()];
  if (range === 'last_quarter') return [day(new Date(year, quarter - 3, 1)), day(new Date(year, quarter, 0))];
  if (range === 'year') return [day(new Date(year, 0, 1)), today()];
  return [day(new Date(year, month, now.getDate() - 29)), today()];
};

const percent = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—');
const sum = (rows: any[], field: string) => rows.reduce((total, row) => total + Number(row[field] || 0), 0);

export default function Reports() {
  return <AppShell><ReportsApp /></AppShell>;
}

function ReportsApp() {
  const members = useTeam();
  const [range, setRange] = useState('30');
  const [[from, to], setDates] = useState(rangeDates('30'));
  const [pipeline, setPipeline] = useState('');
  const [pipelines, setPipelines] = useState<any[]>([]);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/crm/pipelines').then(setPipelines).catch(() => setPipelines([]));
  }, []);

  useEffect(() => {
    if (!from || !to) return;
    api.get(`/api/crm/reports/team?from=${from}&to=${to}${pipeline ? `&pipeline=${pipeline}` : ''}`)
      .then((report) => {
        setData(report);
        setError('');
      })
      .catch((err) => setError(err.message));
  }, [from, to, pipeline]);

  const chooseRange = (id: string) => {
    setRange(id);
    if (id !== 'custom') setDates(rangeDates(id));
  };

  const person = (id: string | null) =>
    id ? members.find(({ user_id }) => user_id === id)?.email || 'Former member' : 'Unassigned';

  // Everyone on the team shows, even with nothing in the period
  const people = data ? [
    ...data.people,
    ...members
      .filter(({ user_id, role }) => role !== 'viewer' && !data.people.some((row: any) => row.user_id === user_id))
      .map(({ user_id }) => ({ user_id }))
  ] : [];

  const funnelPipeline = pipelines.find(({ id }) => id === data?.pipeline_id)?.name;
  const file = (name: string) => `${name}-${from}-to-${to}.csv`;

  const results = (row: any) => [
    Number(row.deals_created || 0), Number(row.won || 0), Number(row.won_value || 0), Number(row.lost || 0),
    percent(Number(row.won || 0), Number(row.won || 0) + Number(row.lost || 0)),
    row.won ? Math.round((Number(row.won_value) / Number(row.won)) * 100) / 100 : null, row.days_to_win ?? null, Number(row.open_value || 0)
  ];
  const activity = (row: any) => [
    Number(row.calls || 0), Number(row.meetings || 0), Number(row.emails || 0), Number(row.notes || 0),
    Number(row.tasks_done || 0), Number(row.tasks_overdue || 0), Number(row.leads_new || 0), Number(row.leads_converted || 0)
  ];

  return (
    <div className="stack">
      <CrmNav />
      <div className="page-head"><h1>Reports</h1></div>

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
        <label>Pipeline
          <select value={pipeline} onChange={(e) => setPipeline(e.target.value)}>
            <option value="">All pipelines</option>
            {pipelines.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
      </div>
      <p className="muted">Up to a year at a time. Dates follow UTC. Open pipeline and overdue tasks are as of now.</p>

      {error && <p className="error">{error}</p>}

      {data && (
        <>
          <div className="card table-wrap">
            <div className="page-head">
              <h2>Results by person</h2>
              <button onClick={() => downloadCsv(file('team-results'), [
                ['Person', 'Deals added', 'Won', 'Won value', 'Lost', 'Win rate', 'Average won deal', 'Days to win', 'Open pipeline'],
                ...people.map((row) => [person(row.user_id), ...results(row)])
              ])}>Download CSV</button>
            </div>
            <table>
              <thead><tr><th>Person</th><th className="num">Deals added</th><th className="num">Won</th><th className="num">Won value</th><th className="num">Lost</th><th className="num">Win rate</th><th className="num">Average won deal</th><th className="num">Days to win</th><th className="num">Open pipeline</th></tr></thead>
              <tbody>
                {people.length === 0 && <tr><td colSpan={9} className="empty">Nothing in these dates</td></tr>}
                {people.map((row) => {
                  const [added, won, wonValue, lost, rate, average, days, open] = results(row);
                  return (
                    <tr key={row.user_id || 'none'}>
                      <td className="wrap">{person(row.user_id)}</td>
                      <td className="num">{added}</td>
                      <td className="num">{won}</td>
                      <td className="num">{money(wonValue)}</td>
                      <td className="num">{lost}</td>
                      <td className="num">{rate}</td>
                      <td className="num">{average === null ? '—' : money(average)}</td>
                      <td className="num">{days ?? '—'}</td>
                      <td className="num">{money(open)}</td>
                    </tr>
                  );
                })}
              </tbody>
              {people.length > 1 && (
                <tfoot>
                  <tr>
                    <th>Team</th>
                    <th className="num">{sum(people, 'deals_created')}</th>
                    <th className="num">{sum(people, 'won')}</th>
                    <th className="num">{money(sum(people, 'won_value'))}</th>
                    <th className="num">{sum(people, 'lost')}</th>
                    <th className="num">{percent(sum(people, 'won'), sum(people, 'won') + sum(people, 'lost'))}</th>
                    <th className="num">{sum(people, 'won') ? money(sum(people, 'won_value') / sum(people, 'won')) : '—'}</th>
                    <th />
                    <th className="num">{money(sum(people, 'open_value'))}</th>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          <div className="card table-wrap">
            <div className="page-head">
              <h2>Activity by person</h2>
              <button onClick={() => downloadCsv(file('team-activity'), [
                ['Person', 'Calls', 'Meetings', 'Emails', 'Notes', 'Tasks done', 'Tasks overdue', 'New leads', 'Leads converted'],
                ...people.map((row) => [person(row.user_id), ...activity(row)])
              ])}>Download CSV</button>
            </div>
            <p className="muted">Calls, meetings, emails and notes count by who logged them. Tasks count by who they're for. Automated tasks aren't counted as logged work.</p>
            <table>
              <thead><tr><th>Person</th><th className="num">Calls</th><th className="num">Meetings</th><th className="num">Emails</th><th className="num">Notes</th><th className="num">Tasks done</th><th className="num">Overdue now</th><th className="num">New leads</th><th className="num">Converted</th></tr></thead>
              <tbody>
                {people.map((row) => (
                  <tr key={row.user_id || 'none'}>
                    <td className="wrap">{person(row.user_id)}</td>
                    {activity(row).map((value, index) => <td key={index} className={`num ${index === 5 && value > 0 ? 'late' : ''}`}>{value}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card table-wrap">
            <div className="page-head">
              <h2>Stage conversion{funnelPipeline ? `, ${funnelPipeline}` : ''}</h2>
              <button disabled={!data.funnel.length} onClick={() => downloadCsv(file('stage-conversion'), [
                ['Stage', 'Deals reaching it', 'Of deals added', 'From the stage before', 'Average days in stage'],
                ...data.funnel.map((row: any, index: number) => [
                  row.name, row.deals, percent(Number(row.deals), Number(data.funnel_total)),
                  index ? percent(Number(row.deals), Number(data.funnel[index - 1].deals)) : '', row.avg_days
                ])
              ])}>Download CSV</button>
            </div>
            <p className="muted">Deals added in these dates and how far they got. A won deal counts as passing every stage. Days in stage are for deals that left it in these dates.</p>
            <table>
              <thead><tr><th>Stage</th><th className="num">Deals reaching it</th><th className="num">Of deals added</th><th className="num">From the stage before</th><th className="num">Average days in stage</th></tr></thead>
              <tbody>
                {data.funnel.length === 0 && <tr><td colSpan={5} className="empty">No pipeline to show</td></tr>}
                {data.funnel.map((row: any, index: number) => (
                  <tr key={row.name + row.position}>
                    <td>{row.name}</td>
                    <td className="num">{row.deals}</td>
                    <td className="num">{percent(Number(row.deals), Number(data.funnel_total))}</td>
                    <td className="num">{index ? percent(Number(row.deals), Number(data.funnel[index - 1].deals)) : '—'}</td>
                    <td className="num">{row.kind === 'won' || row.avg_days === null ? '—' : row.avg_days}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card table-wrap">
            <div className="page-head">
              <h2>Where deals come from</h2>
              <button disabled={!data.sources.length} onClick={() => downloadCsv(file('sources'), [
                ['Source', 'Leads', 'Leads converted', 'Conversion', 'Deals added', 'Won', 'Won value'],
                ...data.sources.map((row: any) => [row.source, row.leads, row.converted, percent(Number(row.converted), Number(row.leads)), row.deals, row.won, row.won_value])
              ])}>Download CSV</button>
            </div>
            <table>
              <thead><tr><th>Source</th><th className="num">Leads</th><th className="num">Converted</th><th className="num">Conversion</th><th className="num">Deals added</th><th className="num">Won</th><th className="num">Won value</th></tr></thead>
              <tbody>
                {data.sources.length === 0 && <tr><td colSpan={7} className="empty">No leads or deals added in these dates</td></tr>}
                {data.sources.map((row: any) => (
                  <tr key={row.source}>
                    <td className="wrap">{row.source}</td>
                    <td className="num">{row.leads}</td>
                    <td className="num">{row.converted}</td>
                    <td className="num">{percent(Number(row.converted), Number(row.leads))}</td>
                    <td className="num">{row.deals}</td>
                    <td className="num">{row.won}</td>
                    <td className="num">{money(row.won_value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card table-wrap">
            <h2>Why deals were lost</h2>
            <table>
              <thead><tr><th>Reason</th><th className="num">Deals</th><th className="num">Value</th></tr></thead>
              <tbody>
                {data.lost_reasons.length === 0 && <tr><td colSpan={3} className="empty">No deals lost in these dates</td></tr>}
                {data.lost_reasons.map((row: any) => (
                  <tr key={row.reason}>
                    <td className="wrap">{row.reason}</td>
                    <td className="num">{row.deals}</td>
                    <td className="num">{money(row.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card table-wrap">
            <h2>By month</h2>
            <table>
              <thead><tr><th>Month</th><th className="num">Deals added</th><th className="num">Won</th><th className="num">Won value</th><th className="num">Lost</th><th className="num">Win rate</th></tr></thead>
              <tbody>
                {data.months.map((row: any) => (
                  <tr key={row.month}>
                    <td>{monthName(row.month)}</td>
                    <td className="num">{row.deals_created}</td>
                    <td className="num">{row.won}</td>
                    <td className="num">{money(row.won_value)}</td>
                    <td className="num">{row.lost}</td>
                    <td className="num">{percent(Number(row.won), Number(row.won) + Number(row.lost))}</td>
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
