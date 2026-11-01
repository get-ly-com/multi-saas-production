import Link from 'next/link';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import CrmNav from '@/components/CrmNav';
import { DealForm } from '@/components/CrmForms';
import { scoreBadge, scoreLabel } from '@/components/LeadForms';
import { api, formatDate, money, today } from '@/lib/api';

const monthName = (month: string) =>
  new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

export default function Crm() {
  return <AppShell><TodayApp /></AppShell>;
}

function TodayApp() {
  const [data, setData] = useState<any>(null);
  const [leads, setLeads] = useState<any>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);

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
  }, []);

  const finish = async (task: any) => {
    try {
      await api.put(`/api/crm/activities/${task.id}/done`, { done: true });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const decided = data ? Number(data.won_90) + Number(data.lost_90) : 0;

  return (
    <div className="stack">
      <CrmNav />
      <div className="page-head">
        <h1>Today</h1>
        <button className="primary" onClick={() => setAdding(true)}>New deal</button>
      </div>

      {error && <p className="error">{error}</p>}

      {!data ? !error && <p className="empty">Loading…</p> : (
        <>
          <div className="stats">
            <div className="card"><div className="stat-label">Open pipeline</div><div className="stat-value">{money(data.open_value)}</div><div className="muted">{data.open_count} {Number(data.open_count) === 1 ? 'deal' : 'deals'}</div></div>
            <div className="card"><div className="stat-label">Weighted forecast</div><div className="stat-value">{money(data.weighted_value)}</div><div className="muted">Value × stage chance</div></div>
            <div className="card"><div className="stat-label">Won this month</div><div className="stat-value">{money(data.won_this_month)}</div></div>
            <div className="card"><div className="stat-label">Win rate, 90 days</div><div className="stat-value">{decided ? `${Math.round((Number(data.won_90) / decided) * 100)}%` : '—'}</div><div className="muted">{data.won_90} won, {data.lost_90} lost</div></div>
          </div>

          <div className="card table-wrap">
            <h2>Your tasks</h2>
            <table>
              <tbody>
                {data.my_tasks.length === 0 && <tr><td className="empty">Nothing due today</td></tr>}
                {data.my_tasks.map((task: any) => (
                  <tr key={task.id}>
                    <td className="wrap">
                      {task.subject}
                      {task.deal_id && <> · <Link href={`/saas/crm/deal/${task.deal_id}`}>{task.deal_title}</Link></>}
                      {!task.deal_id && task.lead_id && <> · <Link href={`/saas/crm/lead/${task.lead_id}`}>{task.lead_name}</Link></>}
                      {!task.deal_id && !task.lead_id && task.contact_id && <> · <Link href={`/saas/crm/contact/${task.contact_id}`}>{task.contact_name}</Link></>}
                    </td>
                    <td>{task.due_on && <span className={`badge ${task.due_on < today() ? 'lost' : ''}`}>{task.due_on < today() ? `overdue ${formatDate(task.due_on)}` : 'today'}</span>}</td>
                    <td><div className="row-actions"><button onClick={() => finish(task)}>Done</button></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {leads && Number(leads.open) > 0 && (
            <div className="card table-wrap">
              <h2>Leads to work</h2>
              <p className="muted">
                <Link href="/saas/crm/leads">{leads.open} open</Link>, {leads.new} new{Number(leads.unassigned) > 0 && `, ${leads.unassigned} unassigned`}
              </p>
              <table>
                <tbody>
                  {leads.top.map((lead: any) => (
                    <tr key={lead.id}>
                      <td className="wrap"><Link href={`/saas/crm/lead/${lead.id}`}>{lead.name}</Link></td>
                      <td className="wrap">{lead.company_name || '—'}</td>
                      <td className="num">{lead.score} <span className={`badge ${scoreBadge(lead.score)}`}>{scoreLabel(lead.score)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {(data.stale_deals.length > 0 || Number(data.late_deals) > 0 || Number(data.undated_deals) > 0) && (
            <div className="card table-wrap">
              <h2>Needs attention</h2>
              {Number(data.late_deals) > 0 && <p>Open deals past their expected close: {data.late_deals}.</p>}
              {Number(data.undated_deals) > 0 && <p>Open deals with no expected close: {data.undated_deals}. They aren't in the forecast below.</p>}
              {data.stale_deals.length > 0 && (
                <table>
                  <thead><tr><th>Quiet for 14 days or more</th><th>Stage</th><th>Last touched</th><th className="num">Value</th></tr></thead>
                  <tbody>
                    {data.stale_deals.map((deal: any) => (
                      <tr key={deal.id}>
                        <td className="wrap"><Link href={`/saas/crm/deal/${deal.id}`}>{deal.title}</Link></td>
                        <td>{deal.stage_name}</td>
                        <td>{formatDate(deal.last_touch)}</td>
                        <td className="num">{money(deal.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          <div className="card table-wrap">
            <h2>Forecast, next three months</h2>
            <table>
              <thead><tr><th>Month</th><th className="num">Deals</th><th className="num">Value</th><th className="num">Weighted</th></tr></thead>
              <tbody>
                {data.forecast.length === 0 && <tr><td colSpan={4} className="empty">No deals expected to close yet</td></tr>}
                {data.forecast.map((row: any) => (
                  <tr key={row.month}>
                    <td>{monthName(row.month)}</td>
                    <td className="num">{row.deals}</td>
                    <td className="num">{money(row.value)}</td>
                    <td className="num">{money(row.weighted)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card table-wrap">
            <h2>Pipeline by stage</h2>
            <table>
              <thead><tr><th>Stage</th><th className="num">Deals</th><th className="num">Value</th></tr></thead>
              <tbody>
                {data.stages.map((stage: any) => (
                  <tr key={stage.name}>
                    <td>{stage.name}</td>
                    <td className="num">{stage.deals}</td>
                    <td className="num">{money(stage.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {adding && <DealForm onClose={() => setAdding(false)} onSaved={load} />}
    </div>
  );
}
