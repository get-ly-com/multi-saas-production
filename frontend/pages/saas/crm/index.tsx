import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import AppShell, { useAccount } from '@/components/AppShell';
import { celebrate } from '@/components/Celebrate';
import CrmNav from '@/components/CrmNav';
import { DealForm } from '@/components/CrmForms';
import { ActivityChecklist, Bars, ChecklistSkeleton, RecordDrawer, StatTile, openInDrawer } from '@/components/CrmRecord';
import EmptyState from '@/components/EmptyState';
import { scoreBadge, scoreLabel } from '@/components/LeadForms';
import Skeleton, { SkeletonStats } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api, formatDate, money, today } from '@/lib/api';
import { plural } from '@/lib/format';
import { store } from '@/lib/ui';
import styles from '@/styles/crm.module.css';

const monthName = (month: string) =>
  new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

const cheeredKey = (tenant: string, day: string) => `getly:crm-caught-up:${tenant}:${day}`;

export default function Crm() {
  return <AppShell><TodayApp /></AppShell>;
}

function TodayApp() {
  const account = useAccount();
  const tenant = account?.tenantId || '';
  const [data, setData] = useState<any>(null);
  const [leads, setLeads] = useState<any>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [lead, setLead] = useState<any>(null);
  const [cleared, setCleared] = useState(false);
  const [dateLine, setDateLine] = useState('');
  const box = useRef<HTMLElement>(null);

  const load = async () => {
    try {
      const [overview, summary] = await Promise.all([api.get('/api/crm/overview'), api.get('/api/crm/leads/summary')]);
      setData(overview);
      setLeads(summary);
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
    setDateLine(new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }));
  }, []);

  // Ticking off the last one is a real win: a burst of confetti, once a day
  const allDone = (from: Element | null) => {
    setCleared(true);
    const key = cheeredKey(tenant, today());
    if (store.get(key, false)) return;
    store.set(key, true);
    setTimeout(() => celebrate({ from: box.current?.querySelector('.empty-art') || from }), 260);
  };

  const decided = data ? Number(data.won_90) + Number(data.lost_90) : 0;
  const tasks: any[] = data?.my_tasks || [];
  const overdue = tasks.filter((task) => task.due_on && task.due_on < today()).length;
  const stageMax = data ? Math.max(0, ...data.stages.map((stage: any) => Number(stage.value || 0))) : 0;

  return (
    <div className="stack">
      <CrmNav />
      <div className="page-head">
        <div>
          <h1>Today</h1>
          <p className="muted">{dateLine || ' '}</p>
        </div>
        <button className="primary" onClick={() => setAdding(true)}>New deal</button>
      </div>

      {error && <p className="error">{error}</p>}

      {!data ? !error && (
        <>
          <SkeletonStats count={4} />
          <section className="card todo"><Skeleton width={160} height={16} style={{ marginBottom: 14 }} /><ChecklistSkeleton rows={3} /></section>
        </>
      ) : (
        <>
          <div className="stats">
            <StatTile label="Open pipeline" icon="deal" href="/saas/crm/pipeline" value={money(data.open_value)} note={plural(Number(data.open_count), 'deal')} />
            <StatTile label="Weighted forecast" icon="target" href="/saas/crm/forecast" value={money(data.weighted_value)} note="Value × stage chance" />
            <StatTile label="Won this month" icon="paid" tone="good" value={money(data.won_this_month)} note={Number(data.won_this_month) > 0 ? 'Nice going' : 'Your next win goes here'} />
            <StatTile label="Win rate, 90 days" icon="star" href="/saas/crm/reports" value={decided ? `${Math.round((Number(data.won_90) / decided) * 100)}%` : '—'} note={`${data.won_90} won, ${data.lost_90} lost`} />
          </div>

          <section className="card todo" ref={box} aria-labelledby="mine-title">
            <div className="section-head">
              <div>
                <h2 id="mine-title">Your activities</h2>
                <p className="muted">Due today and overdue. Tick one off when it&apos;s done.</p>
              </div>
              <div className="row-actions">
                {tasks.length > 0 && !cleared && <span className="count-pill" title={overdue ? `${overdue} overdue` : undefined}>{tasks.length}</span>}
                <Link href="/saas/crm/tasks" className="button ghost small always">All activities</Link>
              </div>
            </div>
            <ActivityChecklist
              items={tasks}
              onChanged={load}
              onCleared={allDone}
              empty={(
                <EmptyState
                  tone="done"
                  icon="inbox"
                  compact
                  title="All caught up"
                  line={cleared ? 'Every call and to-do for today is done. Time is yours again.' : 'Nothing due today. A good moment to plan the next step on a deal.'}
                  action={{ label: 'Open the pipeline', href: '/saas/crm/pipeline' }}
                />
              )}
            />
          </section>

          {leads && Number(leads.open) > 0 && (
            <section className="card table-wrap" aria-labelledby="leads-title">
              <div className={styles.cardHead}>
                <div>
                  <h2 id="leads-title">Leads to work</h2>
                  <p className="muted">
                    {leads.open} open, {leads.new} new{Number(leads.unassigned) > 0 && `, ${leads.unassigned} unassigned`}. Hottest first.
                  </p>
                </div>
                <Link href="/saas/crm/leads" className="button ghost small always">All leads</Link>
              </div>
              <table>
                <tbody>
                  {leads.top.map((row: any) => (
                    <tr key={row.id}>
                      <td className="wrap"><Link href={`/saas/crm/lead/${row.id}`} className={styles.rowOpen} onClick={openInDrawer(() => setLead(row))}>{row.name}</Link></td>
                      <td className="wrap">{row.company_name || '—'}</td>
                      <td className="num">{row.score} <span className={`badge ${scoreBadge(row.score)}`}>{scoreLabel(row.score)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {(data.stale_deals.length > 0 || Number(data.late_deals) > 0 || Number(data.undated_deals) > 0) && (
            <section className="card table-wrap" aria-labelledby="attention-title">
              <div className={styles.cardHead}>
                <div>
                  <h2 id="attention-title">Needs attention</h2>
                  {Number(data.late_deals) > 0 && <p className="muted">{plural(Number(data.late_deals), 'open deal')} past the expected close.</p>}
                  {Number(data.undated_deals) > 0 && <p className="muted">{plural(Number(data.undated_deals), 'open deal')} with no expected close, so not in the forecast below.</p>}
                </div>
              </div>
              {data.stale_deals.length > 0 && (
                <table>
                  <thead><tr><th>Going quiet</th><th>Stage</th><th>Last touched</th><th className="num">Value</th></tr></thead>
                  <tbody>
                    {data.stale_deals.map((deal: any) => (
                      <tr key={deal.id} className="stale">
                        <td className="wrap"><Link href={`/saas/crm/deal/${deal.id}`}>{deal.title}</Link></td>
                        <td>{deal.stage_name}</td>
                        <td>{formatDate(deal.last_touch)}</td>
                        <td className="num">{money(deal.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}

          <section className="card" aria-labelledby="forecast-title">
            <div className={styles.cardHead}>
              <div>
                <h2 id="forecast-title">Forecast, next three months</h2>
                <p className="muted">Weighted value of deals expected to close.</p>
              </div>
              <Link href="/saas/crm/forecast" className="button ghost small always">Full forecast</Link>
            </div>
            {data.forecast.length === 0 ? (
              <EmptyState compact icon="calendar" title="No closes expected yet" line="Give open deals an expected close date and they show up here." />
            ) : (
              <Bars
                max={Math.max(...data.forecast.map((row: any) => Number(row.value || 0)))}
                rows={data.forecast.map((row: any) => ({
                  key: row.month,
                  label: monthName(row.month),
                  value: Number(row.weighted || 0),
                  text: money(row.weighted),
                  extra: `of ${money(row.value)} · ${plural(Number(row.deals), 'deal')}`,
                  title: `${monthName(row.month)}: ${money(row.weighted)} weighted of ${money(row.value)} across ${plural(Number(row.deals), 'deal')}`
                }))}
              />
            )}
          </section>

          <section className="card" aria-labelledby="stages-title">
            <div className={styles.cardHead}>
              <div>
                <h2 id="stages-title">Pipeline by stage</h2>
                <p className="muted">Open value sitting in each stage.</p>
              </div>
            </div>
            {data.stages.length === 0 ? (
              <EmptyState compact icon="deal" title="No stages yet" action={{ label: 'Set up a pipeline', href: '/saas/crm/settings' }} />
            ) : (
              <Bars
                max={stageMax}
                rows={data.stages.map((stage: any) => ({
                  key: stage.name,
                  label: stage.name,
                  value: Number(stage.value || 0),
                  text: money(stage.value),
                  extra: plural(Number(stage.deals), 'deal'),
                  title: `${stage.name}: ${money(stage.value)} across ${plural(Number(stage.deals), 'deal')}`
                }))}
              />
            )}
          </section>
        </>
      )}

      {adding && <DealForm onClose={() => setAdding(false)} onSaved={async () => { toast.success('Deal added'); await load(); }} />}
      <RecordDrawer kind="lead" record={lead} onClose={() => setLead(null)} onChanged={load} />
    </div>
  );
}
