import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import EmptyState from '@/components/EmptyState';
import { PersonCell } from '@/components/HrForms';
import HrNav from '@/components/HrNav';
import { TimeEntryForm, addDays, hoursText, timeOf, timeZone, weekStart } from '@/components/HrWork';
import Icon from '@/components/Icon';
import Skeleton, { SkeletonTable } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api, formatDate, today } from '@/lib/api';
import styles from '@/styles/hr.module.css';

export default function Attendance() {
  return <AppShell><AttendanceApp /></AppShell>;
}

const shortDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

function AttendanceApp() {
  const [me, setMe] = useState<any>(null);
  const [from, setFrom] = useState(() => weekStart(today()));
  const [summary, setSummary] = useState<any[] | null>(null);
  const [open, setOpen] = useState<any>(null);
  const [entries, setEntries] = useState<any[] | null>(null);
  const [editing, setEditing] = useState<any>(null);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The last clock in or out, shown as a green confirmation by the button
  const [stamp, setStamp] = useState<{ text: string; key: number } | null>(null);
  const to = addDays(from, 6);

  const loadEntries = async (person = open) => {
    if (!person) return setEntries(null);
    setEntries(await api.get(`/api/hr/attendance?employee_id=${person.employee_id}&from=${from}&to=${to}`));
  };

  const load = async () => {
    try {
      const [mine, people] = await Promise.all([
        api.get(`/api/hr/attendance/me?tz=${encodeURIComponent(timeZone())}`),
        api.get(`/api/hr/attendance/summary?from=${from}&to=${to}`)
      ]);
      setMe(mine);
      setSummary(people);
      await loadEntries();
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, [from, open?.employee_id]);

  const act = async (work: () => Promise<unknown>, done?: { title: string; detail?: string }) => {
    setBusy(true);
    try {
      await work();
      await load();
      if (done) toast.success(done.title, { detail: done.detail });
    } catch (err: any) {
      toast.error('That did not go through', { detail: err.message });
    } finally {
      setBusy(false);
    }
  };

  const clock = () => act(async () => {
    const result = await api.post('/api/hr/attendance/clock', { tz: timeZone() });
    const at = timeOf(result.at);
    if (result.status === 'in') {
      setStamp({ text: `Clocked in at ${at}`, key: Date.now() });
      toast.success(`Clocked in at ${at}`, { detail: 'Have a good day.' });
    } else {
      setStamp({ text: `Clocked out at ${at}`, key: Date.now() });
      toast.success(`Clocked out at ${at}`, { detail: `${hoursText(result.hours_today)} today. Nice work.` });
    }
  });

  const savePin = (event: FormEvent) => {
    event.preventDefault();
    act(async () => {
      await api.post('/api/hr/attendance/pin', { employee_id: me.employee.id, pin });
      setPin('');
    }, { title: 'Kiosk PIN saved', detail: 'Use it with your employee number on the kiosk.' });
  };

  const approve = (row: any) => act(async () => {
    const result = await api.post('/api/hr/attendance/approve', { employee_id: row.employee_id, from, to });
    toast.success('Week approved', { detail: `${result.approved} ${result.approved === 1 ? 'entry' : 'entries'}, ${hoursText(result.hours)} for ${row.name}.` });
  });

  const remove = (entry: any) => {
    if (!window.confirm('Delete this time entry?')) return;
    act(() => api.delete(`/api/hr/attendance/${entry.id}`), { title: 'Time entry deleted' });
  };

  const mine = me?.employee;
  const clockedIn = Boolean(me?.clocked_in_since);
  const isThisWeek = from === weekStart(today());
  const usual = Number(me?.usual_hours || 0);
  const weekShare = usual ? Math.min(100, Math.round((Number(me?.hours_this_week || 0) / usual) * 100)) : 0;

  return (
    <div className="stack">
      <HrNav />
      <div className="page-head">
        <div>
          <h1>Attendance</h1>
          <p className="muted">Clock in, see the week, and approve hours for pay.</p>
        </div>
        <div className="row-actions">
          <Link href="/saas/hr/kiosk" className="button always"><Icon name="clock" size={15} /> Open the clock-in kiosk</Link>
        </div>
      </div>
      {error && <p className="error">{error}</p>}

      {!me && !error && (
        <div className="card" aria-hidden="true">
          <div className={styles.clock}>
            <Skeleton width={148} height={148} radius={999} />
            <div style={{ display: 'grid', gap: 10 }}><Skeleton width="40%" height={12} /><Skeleton width="60%" height={28} /></div>
          </div>
        </div>
      )}

      {mine && (
        <div className="card">
          <div className={styles.clock}>
            <button key={stamp?.key} className={`always ${styles.clockButton} ${clockedIn ? styles.isIn : ''} ${stamp ? styles.flash : ''}`}
              disabled={busy} onClick={clock}>
              <Icon name={clockedIn ? 'logout' : 'clock'} size={26} />
              {clockedIn ? 'Clock out' : 'Clock in'}
              <small>{clockedIn ? `In since ${timeOf(me.clocked_in_since)}` : 'Tap to start'}</small>
            </button>
            <div style={{ display: 'grid', gap: 16, minWidth: 0 }}>
              {stamp && <span className={styles.clockDone} key={stamp.key} role="status"><Icon name="paid" size={16} />{stamp.text}</span>}
              <div className={styles.clockStats}>
                <div className={styles.clockStat}>
                  <span className="stat-label">{clockedIn ? 'Clocked in since' : 'Right now'}</span>
                  <strong>{clockedIn ? timeOf(me.clocked_in_since) : 'Not in'}</strong>
                </div>
                <div className={styles.clockStat}><span className="stat-label">Today</span><strong>{hoursText(me.hours_today)}</strong></div>
                <div className={styles.clockStat}>
                  <span className="stat-label">This week</span>
                  <strong>{hoursText(me.hours_this_week)}</strong>
                  {usual > 0 && (
                    <>
                      <div className={styles.meter} aria-hidden="true"><span style={{ width: `${weekShare}%` }} data-tone={weekShare >= 100 ? 'good' : undefined} /></div>
                      <span className="muted small">of {usual} usual hours</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
          <form className={styles.pinRow} onSubmit={savePin}>
            <input aria-label="Kiosk PIN" type="password" inputMode="numeric" autoComplete="new-password" pattern="[0-9]{4,8}" maxLength={8}
              placeholder={me.has_pin ? 'New kiosk PIN' : 'Choose a kiosk PIN'} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
            <button className="primary always" disabled={busy || pin.length < 4}>Save PIN</button>
            <span className="muted small">Your employee number is <strong>{mine.employee_number}</strong>. Use it with your PIN on a shared kiosk. {me.has_pin ? 'You have a PIN.' : 'You don’t have a PIN yet.'}</span>
          </form>
        </div>
      )}
      {me && !mine && <p className="muted">Your sign-in isn&apos;t linked to an employee, so you can&apos;t clock in. Ask an owner or admin to link it.</p>}

      <div className={styles.weekNav}>
        <button className="icon-button always" aria-label="Previous week" onClick={() => setFrom(addDays(from, -7))}><Icon name="chevron-left" /></button>
        <span className={styles.weekLabel}>{shortDay(from)} to {shortDay(to)}</span>
        <button className="icon-button always" aria-label="Next week" onClick={() => setFrom(addDays(from, 7))} disabled={isThisWeek}><Icon name="chevron-right" /></button>
        {!isThisWeek && <button className="ghost small always" onClick={() => setFrom(weekStart(today()))}>This week</button>}
      </div>

      <div className="card table-wrap">
        <h2>Hours</h2>
        {!summary ? <SkeletonTable rows={4} columns={5} /> : summary.length === 0 ? (
          <EmptyState compact icon="clock" title="No one to show" line="You see your own time and the people who report to you." />
        ) : (
          <table>
            <thead><tr><th>Person</th><th className="num">Worked</th><th className="num">Approved</th><th>Now</th><th>Kiosk PIN</th><th /></tr></thead>
            <tbody>
              {summary.map((row) => {
                const usualHours = Number(row.usual_hours || 0);
                const share = usualHours ? Math.min(100, Math.round((Number(row.hours) / usualHours) * 100)) : 0;
                const approvedShare = usualHours ? Math.min(100, Math.round((Number(row.approved_hours) / usualHours) * 100)) : 0;
                return (
                  <tr key={row.employee_id}>
                    <td className="wrap"><PersonCell name={row.name} person={{ id: row.employee_id }} sub={`#${row.employee_number}`} size="small" /></td>
                    <td className="num">
                      <div className={styles.weekBar}>
                        {usualHours > 0 && (
                          <span className={styles.weekTrack} title={`${hoursText(row.hours)} of ${usualHours} usual hours`} aria-hidden="true">
                            <span style={{ width: `${share}%` }} />
                            <span className={styles.approved} style={{ width: `${approvedShare}%` }} />
                          </span>
                        )}
                        <span>{hoursText(row.hours)}</span>
                      </div>
                      {usualHours > 0 && <div className="muted small">of {usualHours}h usual</div>}
                    </td>
                    <td className="num">{hoursText(row.approved_hours)}{row.waiting > 0 && <div><span className="badge waiting">{row.waiting} waiting</span></div>}</td>
                    <td>{row.clocked_in_since ? <span className="badge active">In since {timeOf(row.clocked_in_since)}</span> : <span className="muted">Out</span>}</td>
                    <td>{row.has_pin ? <span className="chip"><Icon name="check" size={12} /> Set</span> : <span className="muted">None</span>}</td>
                    <td>
                      <div className="row-actions">
                        <button className="small always" onClick={() => setOpen(open?.employee_id === row.employee_id ? null : row)}>{open?.employee_id === row.employee_id ? 'Hide' : 'Entries'}</button>
                        {row.can_decide && row.waiting > 0 && <button className="primary small" disabled={busy} onClick={() => approve(row)}>Approve week</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="muted small">Each person sees their own time; managers also see the people who report to them. Approved hours can be put on hourly pay from a draft pay run.</p>
      </div>

      {open && (
        <div className="card table-wrap">
          <div className="page-head">
            <h2>{open.name}</h2>
            <button className="always" onClick={() => setEditing({})}><Icon name="plus" size={15} /> Add time</button>
          </div>
          {entries === null ? <SkeletonTable rows={3} columns={5} /> : entries.length === 0 ? (
            <EmptyState compact icon="clock" title="No time this week" line="Clock-ins and time you add show up here."
              action={{ label: 'Add time', onClick: () => setEditing({}) }} />
          ) : (
            <table>
              <thead><tr><th>Day</th><th>In</th><th>Out</th><th className="num">Break</th><th className="num">Hours</th><th>How</th><th>Status</th><th>Note</th><th /></tr></thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{formatDate(entry.work_date)}</td>
                    <td>{timeOf(entry.check_in)}</td>
                    <td>{timeOf(entry.check_out)}</td>
                    <td className="num">{entry.break_minutes ? `${entry.break_minutes} min` : '—'}</td>
                    <td className="num">{entry.hours === null ? '—' : hoursText(entry.hours)}</td>
                    <td><span className="chip">{entry.source === 'kiosk' ? 'Kiosk' : entry.source === 'self' ? 'Clocked' : 'Added'}</span></td>
                    <td>{!entry.check_out ? <span className="badge working">At work</span> : entry.approved_at ? <span className="badge approved">Approved</span> : <span className="badge waiting">Waiting</span>}</td>
                    <td className="wrap">{entry.note || '—'}</td>
                    <td>
                      <div className="row-actions">
                        <button className="small always" onClick={() => setEditing(entry)}>Change</button>
                        <button className="danger small always" onClick={() => remove(entry)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {editing && open && (
        <TimeEntryForm entry={editing.id ? editing : null} employeeId={open.employee_id} onClose={() => setEditing(null)}
          onSaved={async () => { await load(); toast.success(editing.id ? 'Time changed' : 'Time added', { detail: open.name }); }} />
      )}
    </div>
  );
}
