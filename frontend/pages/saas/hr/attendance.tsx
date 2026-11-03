import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import HrNav from '@/components/HrNav';
import { TimeEntryForm, addDays, hoursText, timeOf, timeZone, weekStart } from '@/components/HrWork';
import { api, formatDate, today } from '@/lib/api';

export default function Attendance() {
  return <AppShell><AttendanceApp /></AppShell>;
}

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
  const [notice, setNotice] = useState('');
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

  const act = async (work: () => Promise<unknown>, done = '') => {
    setBusy(true);
    setNotice('');
    try {
      await work();
      await load();
      setNotice(done);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const clock = () => act(async () => {
    const result = await api.post('/api/hr/attendance/clock', { tz: timeZone() });
    setNotice(result.status === 'in' ? `Clocked in at ${timeOf(result.at)}.` : `Clocked out at ${timeOf(result.at)}. ${hoursText(result.hours_today)} today.`);
  });

  const savePin = (event: FormEvent) => {
    event.preventDefault();
    act(async () => {
      await api.post('/api/hr/attendance/pin', { employee_id: me.employee.id, pin });
      setPin('');
    }, 'Your kiosk PIN is saved.');
  };

  const approve = (row: any) => act(async () => {
    const result = await api.post('/api/hr/attendance/approve', { employee_id: row.employee_id, from, to });
    setNotice(`Approved ${result.approved} ${result.approved === 1 ? 'entry' : 'entries'}, ${hoursText(result.hours)} for ${row.name}.`);
  });

  const remove = (entry: any) => {
    if (!window.confirm('Delete this time entry?')) return;
    act(() => api.delete(`/api/hr/attendance/${entry.id}`));
  };

  const mine = me?.employee;
  const clockedIn = Boolean(me?.clocked_in_since);
  const isThisWeek = from === weekStart(today());

  return (
    <div className="stack">
      <HrNav />
      <div className="page-head">
        <h1>Attendance</h1>
        <div className="row-actions">
          <Link href="/saas/hr/kiosk">Open the clock-in kiosk</Link>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      {mine && (
        <div className="card">
          <h2>My time</h2>
          <div className="stats">
            <div>
              <div className="stat-label">{clockedIn ? 'Clocked in since' : 'Not clocked in'}</div>
              <div className="stat-value">{clockedIn ? timeOf(me.clocked_in_since) : '—'}</div>
            </div>
            <div><div className="stat-label">Today</div><div className="stat-value">{hoursText(me.hours_today)}</div></div>
            <div>
              <div className="stat-label">This week</div>
              <div className="stat-value">{hoursText(me.hours_this_week)}</div>
              {me.usual_hours && <div className="muted">of {Number(me.usual_hours)} usual hours</div>}
            </div>
          </div>
          <div className="form-actions">
            <button className="primary always" disabled={busy} onClick={clock}>{clockedIn ? 'Clock out' : 'Clock in'}</button>
          </div>
          <form className="row-actions" style={{ justifyContent: 'flex-start', marginTop: 12 }} onSubmit={savePin}>
            <input aria-label="Kiosk PIN" type="password" inputMode="numeric" autoComplete="new-password" pattern="[0-9]{4,8}" maxLength={8}
              placeholder={me.has_pin ? 'New kiosk PIN' : 'Choose a kiosk PIN'} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
            <button className="primary always" disabled={busy || pin.length < 4}>Save PIN</button>
          </form>
          <p className="muted">Your employee number is {mine.employee_number}. Use it with your PIN to clock in on a shared kiosk. {me.has_pin ? 'You have a PIN.' : 'You don’t have a PIN yet.'}</p>
        </div>
      )}
      {me && !mine && <p className="muted">Your sign-in isn&apos;t linked to an employee, so you can&apos;t clock in. Ask an owner or admin to link it.</p>}

      <div className="row-actions" style={{ justifyContent: 'flex-start' }}>
        <button className="always" onClick={() => setFrom(addDays(from, -7))}>Previous week</button>
        {!isThisWeek && <button className="always" onClick={() => setFrom(weekStart(today()))}>This week</button>}
        <button className="always" onClick={() => setFrom(addDays(from, 7))} disabled={isThisWeek}>Next week</button>
        <span className="muted">{formatDate(from)} to {formatDate(to)}</span>
      </div>

      <div className="card table-wrap">
        <h2>Hours</h2>
        {!summary ? <p className="empty">Loading…</p> : (
          <table>
            <thead><tr><th>#</th><th>Name</th><th className="num">Worked</th><th className="num">Approved</th><th className="num">Usual a week</th><th>Now</th><th>Kiosk PIN</th><th /></tr></thead>
            <tbody>
              {summary.length === 0 && <tr><td colSpan={8} className="empty">No one to show. You see your own time and the people who report to you.</td></tr>}
              {summary.map((row) => (
                <tr key={row.employee_id}>
                  <td>{row.employee_number}</td>
                  <td>{row.name}</td>
                  <td className="num">{hoursText(row.hours)}</td>
                  <td className="num">{hoursText(row.approved_hours)}{row.waiting > 0 && <div className="muted">{row.waiting} waiting</div>}</td>
                  <td className="num">{row.usual_hours ? Number(row.usual_hours) : '—'}</td>
                  <td>{row.clocked_in_since ? <span className="badge paid">in since {timeOf(row.clocked_in_since)}</span> : <span className="muted">out</span>}</td>
                  <td>{row.has_pin ? 'Set' : <span className="muted">None</span>}</td>
                  <td>
                    <div className="row-actions">
                      <button className="always" onClick={() => setOpen(open?.employee_id === row.employee_id ? null : row)}>{open?.employee_id === row.employee_id ? 'Hide' : 'Entries'}</button>
                      {row.can_decide && row.waiting > 0 && <button className="primary" disabled={busy} onClick={() => approve(row)}>Approve week</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">Each person sees their own time; managers also see the people who report to them. Approved hours can be put on hourly pay from a draft pay run.</p>
      </div>

      {open && (
        <div className="card table-wrap">
          <div className="page-head">
            <h2>{open.name}</h2>
            <button className="always" onClick={() => setEditing({})}>Add time</button>
          </div>
          <table>
            <thead><tr><th>Day</th><th>In</th><th>Out</th><th className="num">Break</th><th className="num">Hours</th><th>How</th><th>Status</th><th>Note</th><th /></tr></thead>
            <tbody>
              {entries === null && <tr><td colSpan={9} className="empty">Loading…</td></tr>}
              {entries?.length === 0 && <tr><td colSpan={9} className="empty">No time this week</td></tr>}
              {entries?.map((entry) => (
                <tr key={entry.id}>
                  <td>{formatDate(entry.work_date)}</td>
                  <td>{timeOf(entry.check_in)}</td>
                  <td>{timeOf(entry.check_out)}</td>
                  <td className="num">{entry.break_minutes ? `${entry.break_minutes} min` : '—'}</td>
                  <td className="num">{entry.hours === null ? '—' : hoursText(entry.hours)}</td>
                  <td>{entry.source === 'kiosk' ? 'Kiosk' : entry.source === 'self' ? 'Clocked' : 'Added'}</td>
                  <td>{!entry.check_out ? <span className="badge open">at work</span> : entry.approved_at ? <span className="badge paid">approved</span> : <span className="badge">waiting</span>}</td>
                  <td className="wrap">{entry.note || '—'}</td>
                  <td>
                    <div className="row-actions">
                      <button className="always" onClick={() => setEditing(entry)}>Change</button>
                      <button className="danger always" onClick={() => remove(entry)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && open && (
        <TimeEntryForm entry={editing.id ? editing : null} employeeId={open.employee_id} onClose={() => setEditing(null)} onSaved={load} />
      )}
    </div>
  );
}
