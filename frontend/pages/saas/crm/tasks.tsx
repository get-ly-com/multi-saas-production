import Link from 'next/link';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { FinishForm, PLANNED_KINDS, PlanForm, dueState, dueText, kindName } from '@/components/ActivityForms';
import CrmNav from '@/components/CrmNav';
import { useTeam } from '@/components/CrmForms';
import { api, today } from '@/lib/api';

export default function Activities() {
  return <AppShell><ActivitiesApp /></AppShell>;
}

const TABS = [
  { id: 'overdue', name: 'Overdue' },
  { id: 'today', name: 'Today' },
  { id: 'later', name: 'Coming up' },
  { id: 'calendar', name: 'Calendar' }
];

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const isoDate = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

// Six weeks starting on the Monday on or before the 1st
const monthGrid = (month: string) => {
  const first = new Date(`${month}-01T00:00:00`);
  const start = new Date(first);
  start.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, i) => {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    return isoDate(day);
  });
};

const shiftMonth = (month: string, by: number) => {
  const date = new Date(`${month}-01T00:00:00`);
  date.setMonth(date.getMonth() + by);
  return isoDate(date).slice(0, 7);
};

function LinkedTo({ item }: { item: any }) {
  if (item.deal) return <Link href={`/saas/crm/deal/${item.deal.id}`}>{item.deal.title}</Link>;
  if (item.lead) return <Link href={`/saas/crm/lead/${item.lead.id}`}>{item.lead.name}</Link>;
  if (item.contact) return <Link href={`/saas/crm/contact/${item.contact.id}`}>{item.contact.name}</Link>;
  if (item.company) return <Link href={`/saas/crm/company/${item.company.id}`}>{item.company.name}</Link>;
  return <>—</>;
}

function ActivitiesApp() {
  const members = useTeam();
  const [me, setMe] = useState('');
  const [tab, setTab] = useState('overdue');
  const [who, setWho] = useState('me');
  const [kind, setKind] = useState('');
  const [items, setItems] = useState<any[]>([]);
  const [month, setMonth] = useState(today().slice(0, 7));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [finishing, setFinishing] = useState<any>(null);
  const [planning, setPlanning] = useState(false);

  useEffect(() => {
    api.get('/api/me').then((data) => setMe(data.user.id)).catch(() => setMe(''));
  }, []);

  const owner = who === 'me' ? me : who === 'all' ? '' : who;

  const load = async () => {
    if (who === 'me' && !me) return;
    try {
      const query = new URLSearchParams();
      if (owner) query.set('owner', owner);
      if (tab === 'calendar') {
        const days = monthGrid(month);
        query.set('from', days[0]);
        query.set('to', days[days.length - 1]);
        query.set('done', '1');
      }
      setItems(await api.get(`/api/crm/activities/schedule?${query}`));
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [tab === 'calendar', month, owner, me]);

  const shown = items.filter((item) => !kind || item.kind === kind);
  const counts = Object.fromEntries(['overdue', 'today', 'later'].map((state) => [state, shown.filter((item) => !item.done_at && dueState(item) === state).length]));
  const ownerName = (id: string) => members.find(({ user_id }) => user_id === id)?.email || '—';

  return (
    <div className="stack">
      <CrmNav />
      <div className="page-head">
        <h1>Activities</h1>
        <button className="primary" onClick={() => setPlanning(true)}>Plan an activity</button>
      </div>
      <p className="muted">Calls, meetings, emails and to-dos you have planned. Mark one done to note how it went and plan the next step.</p>

      <div className="report-filters">
        <label>For
          <select value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="me">Me</option>
            <option value="all">Everyone</option>
            {members.filter((member) => member.user_id !== me).map((member) => <option key={member.user_id} value={member.user_id}>{member.email}</option>)}
          </select>
        </label>
        <label>Type
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All types</option>
            {PLANNED_KINDS.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
      </div>

      <div className="tabs">
        {TABS.map(({ id, name }) => (
          <button type="button" key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {name}{tab !== 'calendar' && id !== 'calendar' && counts[id] ? ` (${counts[id]})` : ''}
          </button>
        ))}
      </div>

      {error && <p className="error">{error}</p>}

      {tab === 'calendar' ? (
        <div className="card">
          <div className="page-head">
            <button onClick={() => setMonth(shiftMonth(month, -1))}>‹ Previous</button>
            <h2>{new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
            <div className="row-actions">
              <button onClick={() => setMonth(today().slice(0, 7))}>This month</button>
              <button onClick={() => setMonth(shiftMonth(month, 1))}>Next ›</button>
            </div>
          </div>
          <div className="calendar">
            {WEEKDAYS.map((day) => <div key={day} className="calendar-head">{day}</div>)}
            {monthGrid(month).map((day) => {
              const dayItems = shown.filter((item) => item.due_on === day);
              return (
                <div key={day} className={`calendar-day ${day.slice(0, 7) !== month ? 'other-month' : ''} ${day === today() ? 'is-today' : ''}`}>
                  <div className="calendar-date">{Number(day.slice(8))}</div>
                  {dayItems.slice(0, 4).map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      className={`calendar-item ${dueState(item)}`}
                      title={`${kindName(item.kind)}: ${item.subject}`}
                      onClick={() => !item.done_at && setFinishing(item)}
                    >
                      {item.due_time ? `${item.due_time.slice(0, 5)} ` : ''}{item.subject}
                    </button>
                  ))}
                  {dayItems.length > 4 && <div className="muted">+{dayItems.length - 4} more</div>}
                </div>
              );
            })}
          </div>
          <p className="muted">Click a planned item to mark it done. Done items are greyed out.</p>
        </div>
      ) : (
        <div className="card table-wrap">
          {loading ? <p className="empty">Loading…</p> : (
            <table>
              <thead><tr><th>Type</th><th>What</th><th>Linked to</th><th>For</th><th>When</th><th /></tr></thead>
              <tbody>
                {shown.filter((item) => dueState(item) === tab).length === 0 && (
                  <tr><td colSpan={6} className="empty">{tab === 'overdue' ? 'Nothing overdue' : tab === 'today' ? 'Nothing due today' : 'Nothing planned'}</td></tr>
                )}
                {shown.filter((item) => dueState(item) === tab).map((item) => (
                  <tr key={item.id}>
                    <td><span className={`badge ${tab === 'overdue' ? 'lost' : tab === 'today' ? 'sent' : ''}`}>{kindName(item.kind)}</span></td>
                    <td className="wrap">{item.subject}{item.automation_id && <span className="muted"> · automated</span>}{item.body && <div className="muted">{item.body}</div>}</td>
                    <td className="wrap"><LinkedTo item={item} /></td>
                    <td>{ownerName(item.owner_id)}</td>
                    <td><span className={tab === 'overdue' ? 'late' : ''}>{dueText(item)}</span></td>
                    <td><div className="row-actions"><button onClick={() => setFinishing(item)}>Done</button></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {finishing && <FinishForm activity={finishing} onClose={() => setFinishing(null)} onSaved={load} />}
      {planning && <PlanForm onClose={() => setPlanning(false)} onSaved={load} />}
    </div>
  );
}
