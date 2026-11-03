import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import AppShell from '@/components/AppShell';
import { BookingDetails, NewBooking } from '@/components/SchedulerForms';
import SchedulerNav, { LOCATIONS, addDays, dayLabel, weekStart } from '@/components/SchedulerNav';
import { api } from '@/lib/api';

export default function Scheduler() {
  return <AppShell><Bookings /></AppShell>;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function Bookings() {
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [calendar, setCalendar] = useState<any>(null);
  const [view, setView] = useState<'week' | 'day'>('week');
  const [day, setDay] = useState('');
  const [staff, setStaff] = useState('');
  const [cancelled, setCancelled] = useState(false);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<any>(null);
  const [error, setError] = useState('');
  const latest = useRef(0);

  const loadSetup = async () => {
    try {
      const [overview, services] = await Promise.all([api.get('/api/scheduler/overview'), api.get('/api/scheduler/services')]);
      setData({ ...overview, services });
      const asked = typeof router.query.date === 'string' && DATE.test(router.query.date) ? router.query.date : '';
      setDay((current) => current || asked || overview.today);
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    if (router.isReady) loadSetup();
  }, [router.isReady]);

  // A link from an alert can point at another day while this page is open
  useEffect(() => {
    const asked = router.query.date;
    if (typeof asked === 'string' && DATE.test(asked)) setDay(asked);
  }, [router.query.date]);

  const from = view === 'week' && day ? weekStart(day) : day;
  const days = view === 'week' ? 7 : 1;

  const load = async () => {
    if (!from) return;
    const mine = ++latest.current;
    try {
      const params = new URLSearchParams({ from, days: String(days), cancelled: String(cancelled) });
      if (staff) params.set('staff', staff);
      const result = await api.get(`/api/scheduler/calendar?${params}`);
      if (mine !== latest.current) return;
      setCalendar(result);
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, [from, days, staff, cancelled]);

  if (!data || !calendar) return <div className="stack"><SchedulerNav />{error ? <p className="error">{error}</p> : <p>Loading…</p>}</div>;

  const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
  const itemsOn = (date: string) => [
    ...calendar.bookings.filter((row: any) => row.local_date === date).map((row: any) => ({ ...row, kind: 'booking' })),
    ...calendar.meetings.filter((row: any) => row.local_date === date).map((row: any) => ({ ...row, kind: 'meeting' }))
  ].sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
  const step = view === 'week' ? 7 : 1;
  const nothingSetUp = !data.services.length || !data.staff.some((row: any) => row.set_up);

  return (
    <div className="stack">
      <SchedulerNav />
      <div className="page-head">
        <h1>Bookings</h1>
        {data.can_edit && <button className="primary" onClick={() => setAdding(true)}>New booking</button>}
      </div>

      {error && <p className="error">{error}</p>}
      {nothingSetUp && (
        <p className="notice">
          To start taking bookings, {!data.services.length ? <Link href="/saas/scheduler/services">add a service</Link> : 'add a service'} and{' '}
          <Link href="/saas/scheduler/hours">set opening hours</Link>. Then share your booking link from <Link href="/saas/scheduler/settings">Settings</Link>.
        </p>
      )}

      <div className="stats">
        <div className="card"><div className="stat-label">Booked in the next 7 days</div><div className="stat-value">{data.next_7_days}</div></div>
        <div className="card"><div className="stat-label">Showing</div><div className="stat-value">{calendar.bookings.filter((row: any) => row.status === 'booked').length}</div></div>
        <div className="card"><div className="stat-label">Time zone</div><div className="stat-value" style={{ fontSize: 17 }}>{calendar.time_zone}</div></div>
      </div>

      <div className="card">
        <div className="sched-toolbar">
          <div className="row-actions">
            <button onClick={() => setDay(addDays(day, -step))} aria-label="Earlier">‹</button>
            <button onClick={() => setDay(calendar.today)}>Today</button>
            <button onClick={() => setDay(addDays(day, step))} aria-label="Later">›</button>
          </div>
          <strong>{view === 'week' ? `${dayLabel(from)} to ${dayLabel(addDays(from, 6))}` : dayLabel(day, true)}</strong>
          <div className="sched-filters">
            <select aria-label="View" value={view} onChange={(e) => setView(e.target.value as any)}>
              <option value="week">Week</option>
              <option value="day">Day</option>
            </select>
            <select aria-label="Whose bookings" value={staff} onChange={(e) => setStaff(e.target.value)}>
              <option value="">Everyone</option>
              {data.staff.filter((row: any) => row.set_up).map((row: any) => (
                <option key={row.user_id} value={row.user_id}>{row.user_id === data.me ? `${row.display_name} (me)` : row.display_name}</option>
              ))}
            </select>
            <label className="check" style={{ marginTop: 0 }}>
              <input type="checkbox" checked={cancelled} onChange={(e) => setCancelled(e.target.checked)} /> Show cancelled
            </label>
          </div>
        </div>

        {view === 'week' ? (
          <div className="sched-week">
            {dates.map((date) => (
              <div key={date} className={`sched-day ${date === calendar.today ? 'today' : ''}`}>
                <button className="link sched-day-head" onClick={() => { setDay(date); setView('day'); }}>{dayLabel(date)}</button>
                {itemsOn(date).length === 0 && <div className="muted sched-none">Free</div>}
                {itemsOn(date).map((item) => <Item key={`${item.kind}-${item.id}`} item={item} onOpen={setOpen} />)}
              </div>
            ))}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Time</th><th>Customer</th><th>Service</th><th>With</th><th>Where</th><th /></tr></thead>
              <tbody>
                {itemsOn(day).length === 0 && <tr><td colSpan={6} className="empty">Nothing booked on this day</td></tr>}
                {itemsOn(day).map((item) => item.kind === 'booking' ? (
                  <tr key={`b-${item.id}`} className={item.status === 'cancelled' ? 'muted' : ''}>
                    <td>{item.start_time}–{item.end_time}</td>
                    <td>{item.customer_name}{item.status === 'cancelled' && <span className="badge void"> cancelled</span>}
                      {item.attendance && <span className={`badge ${item.attendance === 'attended' ? 'paid' : 'failed'}`}> {item.attendance === 'attended' ? 'attended' : 'no-show'}</span>}
                      {item.session_key && <div className="muted">Group: {item.seats_taken} of {item.capacity} places</div>}</td>
                    <td>{item.service_name}</td>
                    <td>{item.staff_name}</td>
                    <td>{LOCATIONS[item.location_type]}</td>
                    <td><div className="row-actions">
                      {item.room_url && <a className="button" href={item.room_url} target="_blank" rel="noopener noreferrer">Join</a>}
                      <a className="button" href="#" onClick={(e) => { e.preventDefault(); setOpen(item); }}>Open</a>
                    </div></td>
                  </tr>
                ) : (
                  <tr key={`m-${item.id}`}>
                    <td>{item.start_time}</td>
                    <td colSpan={2}>Video meeting: {item.title}</td>
                    <td>{item.host_name}</td>
                    <td>Video call</td>
                    <td><a className="button" href={item.room_url} target="_blank" rel="noopener noreferrer">Join</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted">Times are in {calendar.time_zone}. Video meetings from <Link href="/saas/video">Meetings</Link> show here too.</p>
      </div>

      {adding && <NewBooking data={data} date={day < calendar.today ? calendar.today : day} onClose={() => setAdding(false)}
        onSaved={(booking) => { setDay(booking.local_date); load(); loadSetup(); }} />}
      {open && <BookingDetails booking={open} data={data} onClose={() => setOpen(null)} onSaved={() => { load(); loadSetup(); }} />}
    </div>
  );
}

function Item({ item, onOpen }: { item: any; onOpen: (item: any) => void }) {
  if (item.kind === 'meeting') {
    return (
      <a className="sched-item meeting" href={item.room_url} target="_blank" rel="noopener noreferrer">
        <strong>{item.start_time}</strong> {item.title}
        <small>Video meeting · {item.host_name}</small>
      </a>
    );
  }
  return (
    <a href="#" className={`sched-item ${item.status === 'cancelled' ? 'cancelled' : ''}`} onClick={(e) => { e.preventDefault(); onOpen(item); }}>
      <strong>{item.start_time}</strong> {item.customer_name}
      <small>{item.service_name} · {item.staff_name}{item.session_key ? ` · group ${item.seats_taken}/${item.capacity}` : ''}
        {item.attendance === 'no_show' ? ' · no-show' : ''}{item.status === 'cancelled' ? ' · cancelled' : ''}</small>
    </a>
  );
}
