import Link from 'next/link';
import { CSSProperties, useEffect, useRef, useState } from 'react';
import AppShell from '@/components/AppShell';
import { celebrate } from '@/components/Celebrate';
import EmptyState from '@/components/EmptyState';
import { Avatar, LEAVE_STATUSES, LEAVE_WORDS, LeaveForm, PersonCell, fullName, leaveBadge, leaveDates, toneOf } from '@/components/HrForms';
import HrNav from '@/components/HrNav';
import Icon from '@/components/Icon';
import Skeleton, { SkeletonTable } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api, today } from '@/lib/api';
import { plural } from '@/lib/format';
import { store } from '@/lib/ui';
import useSubmit from '@/lib/useSubmit';
import styles from '@/styles/hr.module.css';

export default function Leave() {
  return <AppShell><LeaveApp /></AppShell>;
}

const DAYS = 31;

const addDays = (date: string, days: number) => {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
};

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

const shortDates = (row: any) => {
  const show = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return row.start_date === row.end_date ? `${show(row.start_date)}${row.half_day ? ', half day' : ''}` : `${show(row.start_date)} to ${show(row.end_date)}`;
};

const CELEBRATED = 'getly.hr.leave-cleared';

function LeaveApp() {
  const [requests, setRequests] = useState<any[] | null>(null);
  const [pending, setPending] = useState<any[]>([]);
  const [out, setOut] = useState<any[] | null>(null);
  const [people, setPeople] = useState<any[]>([]);
  const [me, setMe] = useState<any>(null);
  const [manager, setManager] = useState(false);
  const [filter, setFilter] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  // Cards that were just decided: they show the result for a moment, then slide away
  const [decided, setDecided] = useState<Record<string, 'approved' | 'rejected' | 'leaving'>>({});
  const latest = useRef(0);
  const cleared = useRef(false);

  const load = async () => {
    // Only the newest load is shown, so a quick change of filter can't be overwritten by an older answer
    const ticket = ++latest.current;
    try {
      const from = today();
      const [rows, waiting, away, staff, mine, summary] = await Promise.all([
        api.get(`/api/hr/leave${filter ? `?status=${filter}` : ''}`),
        filter === 'pending' ? null : api.get('/api/hr/leave?status=pending'),
        api.get(`/api/hr/leave/out?from=${from}&to=${addDays(from, 30)}`),
        api.get('/api/hr/employees'),
        api.get('/api/hr/me'),
        api.get('/api/hr/overview')
      ]);
      if (ticket !== latest.current) return;
      setRequests(rows);
      setPending(waiting ?? rows);
      setOut(away);
      setPeople(staff);
      setMe(mine);
      setManager(summary.is_manager);
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, [filter]);

  const { busy, run: once } = useSubmit();
  // One action at a time, so a double click cannot repeat it
  const act = (path: string, body: unknown = {}) => once(async () => {
    try {
      await api.post(path, body);
      await load();
      return true;
    } catch (err: any) {
      toast.error('That did not go through', { detail: err.message });
      return false;
    }
  });

  const decide = async (row: any, status: 'approved' | 'rejected') => {
    const note = status === 'rejected' ? window.prompt('Reason for saying no (optional)') : '';
    if (note === null) return;
    setDecided((current) => ({ ...current, [row.id]: status }));
    const name = fullName(row.employee);
    // The card shows its tick while the list reloads, then slides away
    const done = await once(async () => {
      try {
        await api.post(`/api/hr/leave/${row.id}/decide`, { status, note });
        return true;
      } catch (err: any) {
        toast.error('That did not go through', { detail: err.message });
        return false;
      }
    });
    if (!done) {
      setDecided((current) => { const next = { ...current }; delete next[row.id]; return next; });
      return;
    }
    toast.success(status === 'approved' ? 'Leave approved' : 'Leave declined', { detail: `${name}, ${shortDates(row)}. They will get a note.` });
    cleared.current = true;
    setTimeout(() => setDecided((current) => ({ ...current, [row.id]: 'leaving' })), 520);
    setTimeout(() => {
      load();
    }, 760);
  };

  const mineId = me?.employee?.id;
  // Owners and admins decide anyone's; a manager decides their own team's
  const canDecide = (row: any) => {
    const person = people.find((p) => p.id === row.employee_id);
    if (row.employee_id === mineId && !manager) return false;
    return manager || (mineId && person?.manager_id === mineId);
  };
  const canCancel = (row: any) => manager || (row.employee_id === mineId && (row.status === 'pending' || row.start_date > today()));
  const askable = manager ? people.filter((p) => !p.end_date || p.end_date >= today()) : me?.employee ? [me.employee] : [];
  const decides = manager || people.some((p) => mineId && p.manager_id === mineId);

  const cards = pending.filter((row) => row.status === 'pending' && canDecide(row));
  const stillOpen = cards.filter((row) => !decided[row.id]);
  const ready = requests !== null;
  const allDecided = ready && decides && cards.length === 0;

  // A real win: the last request was just decided. At most once a day.
  useEffect(() => {
    if (!allDecided || !cleared.current) return;
    const day = today();
    if (store.get(CELEBRATED, '') === day) return;
    store.set(CELEBRATED, day);
    celebrate();
  }, [allDecided]);

  const cardIds = new Set(cards.map((row) => row.id));
  const history = (requests || []).filter((row) => !cardIds.has(row.id));

  return (
    <div className="stack">
      <HrNav />
      <div className="page-head">
        <div>
          <h1>Leave</h1>
          <p className="muted">{ready ? (stillOpen.length ? `${plural(stillOpen.length, 'request')} for you to decide` : 'Time off, who is away, and what is waiting') : ' '}</p>
        </div>
        {askable.length > 0 && <button className="primary always" onClick={() => setAsking(true)}>Request leave</button>}
      </div>

      {error && <p className="error">{error}</p>}

      {!ready ? (
        <div className="stack" aria-hidden="true"><Skeleton height={76} radius={12} /><Skeleton height={76} radius={12} /></div>
      ) : cards.length > 0 ? (
        <section className="stack" aria-label="Requests to decide">
          <h2 style={{ margin: 0 }}>To decide <span className="count-pill">{stillOpen.length}</span></h2>
          <div className={styles.decideList}>
            {cards.map((row) => {
              const state = decided[row.id];
              const shownState = state === 'leaving' ? undefined : state;
              return (
                <article key={row.id}
                  className={`${styles.decideCard} ${shownState ? styles[shownState] : ''} ${state === 'leaving' ? styles.leaving : ''}`}>
                  <Avatar person={row.employee} />
                  <div className={styles.decideText}>
                    <div className={styles.decideTitle}>
                      <Link href={`/saas/hr/employee/${row.employee_id}`}>{fullName(row.employee)}</Link>
                    </div>
                    <div className={styles.decideMeta}>
                      <span>{shortDates(row)}</span>
                      <span className="chip">{plural(Number(row.days), 'day')}</span>
                      <span className="chip">{row.leave_type?.name}{row.leave_type && !row.leave_type.paid ? ', unpaid' : ''}</span>
                    </div>
                    {row.reason && <div className={styles.decideReason}>{row.reason}</div>}
                  </div>
                  <div className={styles.decideActions}>
                    {state ? (
                      <span className={styles.decided} role="status">
                        <Icon name={state === 'rejected' ? 'x' : 'paid'} size={18} />{state === 'rejected' ? 'Declined' : 'Approved'}
                      </span>
                    ) : (
                      <>
                        <button disabled={busy} onClick={() => decide(row, 'rejected')}>Decline</button>
                        <button className="primary" disabled={busy} onClick={() => decide(row, 'approved')}><Icon name="check" size={15} /> Approve</button>
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : allDecided && (
        <div className="card">
          <EmptyState tone="done" icon="leave" title="All leave decided" line="Every request has an answer. Time is yours again." compact />
        </div>
      )}

      <div className="card">
        <div className="page-head">
          <h2>Who&apos;s out in the next 30 days</h2>
          {out && out.length > 0 && <span className="muted small">{plural(new Set(out.map((row) => row.employee_id)).size, 'person', 'people')} away</span>}
        </div>
        {!out ? <Skeleton height={120} radius={8} /> : out.length === 0 ? (
          <EmptyState compact tone="done" icon="team" title="Everyone's in" line="No one has time off booked for the next 30 days." />
        ) : <OutStrip rows={out} />}
      </div>

      <div className="card table-wrap">
        <div className="page-head">
          <h2>{filter === 'pending' ? 'Waiting' : 'All requests'}</h2>
          <div className="tabs" role="tablist" aria-label="Show requests" style={{ borderBottom: 0 }}>
            {['', ...LEAVE_STATUSES].map((status) => (
              <button key={status || 'all'} type="button" role="tab" aria-selected={filter === status}
                className={`always ${filter === status ? 'active' : ''}`} onClick={() => setFilter(status)}>
                {status ? LEAVE_WORDS[status] : 'All'}
              </button>
            ))}
          </div>
        </div>
        {!ready ? <SkeletonTable rows={4} columns={5} /> : history.length === 0 ? (
          <EmptyState compact icon="leave" title={filter ? `Nothing ${LEAVE_WORDS[filter].toLowerCase()}` : 'No requests yet'}
            line={askable.length ? 'Ask for time off and it shows up here.' : 'Requests you can see show up here.'}
            action={askable.length ? { label: 'Request leave', onClick: () => setAsking(true) } : undefined} />
        ) : (
          <table>
            <thead><tr><th>Person</th><th>Dates</th><th>Type</th><th className="num">Days</th><th>Reason</th><th>Status</th><th /></tr></thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.id}>
                  <td className="wrap"><Link href={`/saas/hr/employee/${row.employee_id}`}><PersonCell person={row.employee} size="small" /></Link></td>
                  <td>{leaveDates(row)}</td>
                  <td>{row.leave_type?.name}{row.leave_type && !row.leave_type.paid ? ' (unpaid)' : ''}</td>
                  <td className="num">{Number(row.days)}</td>
                  <td className="wrap">{row.reason || '—'}{row.decision_note ? <div className="muted">{row.decision_note}</div> : null}</td>
                  <td><span className={`badge ${leaveBadge(row.status)}`}>{LEAVE_WORDS[row.status] || row.status}</span></td>
                  <td>
                    <div className="row-actions">
                      {['pending', 'approved'].includes(row.status) && canCancel(row) && (
                        <button className="danger small" disabled={busy} onClick={async () => {
                          if (window.confirm('Cancel this leave?') && await act(`/api/hr/leave/${row.id}/cancel`)) toast.success('Leave cancelled', { detail: `${fullName(row.employee)}, ${shortDates(row)}` });
                        }}>Cancel</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">You see your own requests, your team&apos;s if you manage people, and everyone&apos;s if you&apos;re an owner or admin. Others see only that someone is away.</p>
      </div>

      {asking && (
        <LeaveForm people={askable} employeeId={manager ? undefined : mineId} onClose={() => setAsking(false)}
          onSaved={async () => { await load(); toast.success('Leave requested', { detail: 'It is waiting for a decision.' }); }} />
      )}
    </div>
  );
}

// One row per person across the next 30 days, with a bar for each stretch of leave
function OutStrip({ rows }: { rows: any[] }) {
  const from = today();
  const days = Array.from({ length: DAYS }, (_, n) => addDays(from, n));
  const weekend = (iso: string) => [0, 6].includes(new Date(`${iso}T00:00:00Z`).getUTCDay());
  const byPerson = new Map<string, { name: string; id: string; rows: any[] }>();
  for (const row of rows) {
    const entry = byPerson.get(row.employee_id) || { name: row.name, id: row.employee_id, rows: [] };
    entry.rows.push(row);
    byPerson.set(row.employee_id, entry);
  }
  const grid = { '--days': DAYS } as CSSProperties;

  return (
    <div className={styles.outWrap}>
      <div className={styles.out} style={grid} role="table" aria-label="Who is out">
        <div role="columnheader" />
        <div className={styles.outDays} role="row">
          {days.map((iso, n) => {
            const date = new Date(`${iso}T00:00:00Z`);
            const label = n === 0 || date.getUTCDate() === 1 ? date.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }) : String(date.getUTCDate());
            return <div key={iso} role="columnheader" className={`${styles.outDay} ${weekend(iso) ? styles.weekend : ''} ${n === 0 ? styles.today : ''}`}>{n === 0 ? 'Today' : label}</div>;
          })}
        </div>
        {Array.from(byPerson.values()).map((person) => (
          <PersonRow key={person.id} person={person} days={days} from={from} weekend={weekend} />
        ))}
      </div>
    </div>
  );
}

function PersonRow({ person, days, from, weekend }: { person: { name: string; id: string; rows: any[] }; days: string[]; from: string; weekend: (iso: string) => boolean }) {
  return (
    <>
      <div className={styles.outName} role="rowheader">
        <Avatar name={person.name} person={{ id: person.id }} size="small" />
        <Link href={`/saas/hr/employee/${person.id}`}>{person.name}</Link>
      </div>
      <div className={styles.outRow} role="row">
        {days.map((iso, n) => <div key={iso} className={`${styles.outCell} ${weekend(iso) ? styles.weekend : ''} ${n === 0 ? styles.today : ''}`} style={{ gridColumn: n + 1, gridRow: 1 }} />)}
        {person.rows.map((row) => {
          const start = Math.max(0, daysBetween(from, row.start_date));
          const end = Math.min(DAYS - 1, daysBetween(from, row.end_date));
          if (end < 0 || start > DAYS - 1) return null;
          return (
            <div key={row.id} className={styles.outBar} data-tone={toneOf(row.leave_type) % 4 || undefined}
              style={{ gridColumn: `${start + 1} / ${end + 2}` }} title={`${person.name}: ${row.leave_type}, ${shortDates(row)}, ${Number(row.days)} days`}>
              {row.leave_type}
            </div>
          );
        })}
      </div>
    </>
  );
}
