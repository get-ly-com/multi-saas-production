import { FormEvent, useEffect, useState } from 'react';
import AnalyticsNav, { Ring, day, monthName } from '@/components/AnalyticsNav';
import AppShell from '@/components/AppShell';
import { celebrate } from '@/components/Celebrate';
import EmptyState from '@/components/EmptyState';
import Icon from '@/components/Icon';
import Modal from '@/components/Modal';
import Skeleton from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { store } from '@/lib/ui';
import a from '@/styles/analytics.module.css';
import { api, money } from '@/lib/api';

export default function Goals() {
  return <AppShell><GoalsApp /></AppShell>;
}

type Metric = { key: string; label: string; money: boolean };

const firstOfMonth = (offset = 0) => {
  const now = new Date();
  return day(new Date(now.getFullYear(), now.getMonth() + offset, 1));
};

function GoalsApp() {
  const [month, setMonth] = useState(firstOfMonth());
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<{ metric: string; target: string } | null>(null);

  const load = async (chosen = month) => {
    try {
      setData(await api.get(`/api/analytics/goals?month=${chosen}`));
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load(month);
  }, [month]);

  // A goal reached this month is a real win: one burst, once per goal
  useEffect(() => {
    if (!data || month !== firstOfMonth()) return;
    const reached = (data.goals || []).filter((row: any) => Number(row.percent) >= 100).map((row: any) => row.metric);
    const key = `getly:goals-cheered:${month}`;
    const seen = store.get<string[]>(key, []);
    const fresh = reached.filter((metric: string) => !seen.includes(metric));
    if (!fresh.length) return;
    store.set(key, [...seen, ...fresh]);
    setTimeout(() => celebrate(), 300);
    toast.success(fresh.length === 1 ? 'Goal reached' : `${fresh.length} goals reached`, { detail: 'Nice work this month.' });
  }, [data]);

  if (!data) return <div className="stack"><AnalyticsNav />{error ? <p className="error">{error}</p> : (
    <div className={a.goals} aria-busy="true">{[0, 1, 2, 3].map((n) => <div key={n} className={a.goalCard}><Skeleton width={84} height={84} radius={999} /><div style={{ display: 'grid', gap: 8 }}><Skeleton width="60%" /><Skeleton width="80%" height={20} /></div></div>)}</div>
  )}</div>;

  const metrics: Metric[] = data.metrics;
  const metricOf = (key: string) => metrics.find((item) => item.key === key);
  const show = (key: string, value: number | string) =>
    (metricOf(key)?.money ? money(value, data.currency) : Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 }));
  const isThisMonth = month === firstOfMonth();
  const shift = (by: number) => {
    const [y, m] = month.split('-').map(Number);
    setMonth(day(new Date(y, m - 1 + by, 1)));
  };

  const save = async (metric: string, target: string, months: number) => {
    setNotice('');
    try {
      const result = await api.post('/api/analytics/goals', { metric, month, target: target === '' ? null : Number(target), months });
      setEditing(null);
      toast.success(result.cleared !== undefined ? 'Goal cleared' : 'Goal saved', result.cleared !== undefined ? undefined : { detail: `Set for ${result.saved} ${result.saved === 1 ? 'month' : 'months'}.` });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  // Past months in the last year, one row per month
  const history: Record<string, any[]> = {};
  for (const row of data.history) (history[row.month] ||= []).push(row);

  return (
    <div className="stack">
      <AnalyticsNav />
      <div className="page-head">
        <div>
          <h1>Goals</h1>
          <p className="muted">Monthly targets for the numbers that matter, and how close you are.</p>
        </div>
        <div className="row-actions">
          <button className="icon-button" onClick={() => shift(-1)} aria-label="Month before"><Icon name="chevron-left" size={18} /></button>
          <strong className="month-label">{new Date(`${month}T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</strong>
          <button className="icon-button" onClick={() => shift(1)} aria-label="Month after"><Icon name="chevron-right" size={18} /></button>
          {!isThisMonth && <button className="small" onClick={() => setMonth(firstOfMonth())}>This month</button>}
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      {data.goals.length === 0 && data.can_edit && (
        <div className="card">
          <EmptyState icon="lead" title="No goals for this month yet"
            line="Pick one number that matters, like invoiced or new leads, and set a target. We'll show how close you are each day." />
        </div>
      )}

      <div className={a.goals}>
        {metrics.map((metric) => {
          const goal = data.goals.find((row: any) => row.metric === metric.key);
          const percent = goal ? Number(goal.percent) : 0;
          const ahead = goal && Number(goal.actual) >= Number(goal.expected);
          const behind = Boolean(goal) && !ahead && Number(data.share_of_month) > 0 && Number(data.share_of_month) < 1;
          return (
            <div key={metric.key} className={`${a.goalCard} ${percent >= 100 ? a.isDone : ''}`}>
              <Ring percent={goal ? percent : 0} size={84} stroke={8} behind={behind} label={goal ? `${Math.round(percent)}% of the ${metric.label.toLowerCase()} goal` : 'No goal set'} />
              <div className={a.goalText}>
                <strong>{metric.label}</strong>
              {goal ? (
                <>
                  <span className={a.goalValue}>{show(metric.key, goal.actual)}</span>
                  <span>of {show(metric.key, goal.target)}</span>
                  <span className={percent >= 100 ? 'badge done' : behind ? 'badge due' : Number(data.share_of_month) >= 1 ? 'badge lost' : 'badge new'} style={{ justifySelf: 'start' }}>
                    {percent >= 100 ? 'Goal reached'
                      : Number(data.share_of_month) >= 1 ? `Missed by ${show(metric.key, Number(goal.target) - Number(goal.actual))}`
                        : Number(data.share_of_month) <= 0 ? 'Month not started'
                          : ahead ? 'On track' : `Behind: ${show(metric.key, goal.expected)} expected by today`}
                  </span>
                </>
              ) : (
                <span>No goal for this month</span>
              )}
              {data.can_edit && (
                <div className="row-actions" style={{ justifyContent: 'flex-start', marginTop: 6 }}>
                  <button className={goal ? 'small ghost' : 'small'} onClick={() => setEditing({ metric: metric.key, target: goal ? String(Number(goal.target)) : '' })}>
                    {goal ? 'Change' : 'Set a goal'}
                  </button>
                </div>
              )}
              </div>
            </div>
          );
        })}
      </div>
      {!data.can_edit && <p className="muted">Owners and admins set goals. Everyone in the company can see them.</p>}

      <div className="card table-wrap">
        <h2>The last 12 months</h2>
        <table>
          <thead><tr><th>Month</th><th>Goal</th><th className="num">Target</th><th className="num">Actual</th><th className="num">Reached</th></tr></thead>
          <tbody>
            {data.history.length === 0 && <tr><td colSpan={5} className="empty">No goals were set for earlier months</td></tr>}
            {Object.entries(history).reverse().flatMap(([when, rows]) => rows.map((row: any, n: number) => (
              <tr key={`${when}-${row.metric}`}>
                <td>{n === 0 ? monthName(when) : ''}</td>
                <td>{metricOf(row.metric)?.label || row.metric}</td>
                <td className="num">{show(row.metric, row.target)}</td>
                <td className="num">{show(row.metric, row.actual)}</td>
                <td className="num"><span className={`badge ${Number(row.percent) >= 100 ? 'won' : 'lost'}`}>{Math.round(Number(row.percent))}%</span></td>
              </tr>
            )))}
          </tbody>
        </table>
        {data.upcoming.length > 0 && (
          <p className="muted">Also set for later months: {data.upcoming.map((row: any) => `${monthName(row.month)} ${metricOf(row.metric)?.label.toLowerCase()} ${show(row.metric, row.target)}`).join(' · ')}</p>
        )}
        <p className="muted">
          Invoiced counts sent invoices by date, before tax. Cash in is money into bank and cash accounts. Deals won counts
          deals closed as won. Bookings count bookings made that are still on. Amounts are in {data.currency}.
        </p>
      </div>

      {editing && (
        <GoalForm metric={metricOf(editing.metric)!} month={month} target={editing.target} currency={data.currency}
          onSave={(target, months) => save(editing.metric, target, months)} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function GoalForm({ metric, month, target, currency, onSave, onClose }: {
  metric: Metric; month: string; target: string; currency: string;
  onSave: (target: string, months: number) => void; onClose: () => void;
}) {
  const [value, setValue] = useState(target);
  const [months, setMonths] = useState(1);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave(value, months);
  };
  return (
    <Modal title={`Goal: ${metric.label}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>{metric.money ? `Target (${currency})` : 'Target'}
            <input type="number" min={0} step={metric.money ? '0.01' : '1'} value={value} placeholder="Leave empty to clear" onChange={(e) => setValue(e.target.value)} />
          </label>
          <label>For
            <select value={months} onChange={(e) => setMonths(Number(e.target.value))}>
              <option value={1}>{monthName(month)} only</option>
              <option value={3}>{monthName(month)} and the next 2 months</option>
              <option value={6}>{monthName(month)} and the next 5 months</option>
              <option value={12}>{monthName(month)} and the next 11 months</option>
            </select>
          </label>
        </div>
        <p className="muted">An empty or zero target clears the goal for those months.</p>
        <div className="form-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}
