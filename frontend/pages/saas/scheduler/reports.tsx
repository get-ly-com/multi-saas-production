import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { SkeletonStats, SkeletonTable } from '@/components/Skeleton';
import SchedulerNav, { addDays } from '@/components/SchedulerNav';
import { api } from '@/lib/api';

export default function Reports() {
  return <AppShell><BookingReports /></AppShell>;
}

const percent = (value: number | null) => (value === null || value === undefined ? '—' : `${value}%`);

function BookingReports() {
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [form, setForm] = useState({ from: '', to: '' });
  const [stats, setStats] = useState<any>(null);
  const [error, setError] = useState('');

  // Start with the last 30 days and the next 30, in the company's time zone
  useEffect(() => {
    api.get('/api/scheduler/overview').then((overview) => {
      const start = { from: addDays(overview.today, -30), to: addDays(overview.today, 30) };
      setForm(start);
      setRange(start);
    }).catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!range) return;
    api.get(`/api/scheduler/stats?${new URLSearchParams(range)}`)
      .then((result) => { setStats(result); setError(''); })
      .catch((err) => setError(err.message));
  }, [range]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setRange({ ...form });
  };

  const totals = stats?.totals;

  return (
    <div className="stack">
      <SchedulerNav />
      <div className="page-head"><div><h1>Booking reports</h1><p className="muted">How bookings turn out, by service and by person.</p></div></div>
      <form className="card sched-filters" onSubmit={submit}>
        <label>From<input type="date" required value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} /></label>
        <label>To<input type="date" required value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} /></label>
        <button className="primary">Show</button>
      </form>
      {error && <p className="error">{error}</p>}
      {!stats && !error && <><SkeletonStats count={4} /><SkeletonTable rows={4} columns={6} /></>}

      {totals && (
        <>
          <div className="stats">
            <div className="card"><div className="stat-label">Booked</div><div className="stat-value">{totals.booked}</div></div>
            <div className="card"><div className="stat-label">Cancelled</div><div className="stat-value">{totals.cancelled}</div>
              <div className="muted">{percent(stats.cancel_rate)} of all · {totals.cancelled_by_customer} by the customer</div></div>
            <div className="card"><div className="stat-label">Attended</div><div className="stat-value">{totals.attended}</div></div>
            <div className="card"><div className="stat-label">No-shows</div><div className="stat-value">{totals.no_show}</div>
              <div className="muted">{percent(stats.no_show_rate)} of marked bookings</div></div>
          </div>
          <div className="stats">
            <div className="card"><div className="stat-label">Still to mark</div><div className="stat-value">{totals.not_marked}</div></div>
            <div className="card"><div className="stat-label">Coming up</div><div className="stat-value">{totals.upcoming}</div></div>
            <div className="card"><div className="stat-label">Booked online</div><div className="stat-value">{totals.online}</div></div>
            <div className="card"><div className="stat-label">Moved by the customer</div><div className="stat-value">{totals.moved_by_customer}</div></div>
          </div>

          <div className="card table-wrap">
            <h2>By service</h2>
            <table>
              <thead><tr><th>Service</th><th className="num">Booked</th><th className="num">Sessions</th><th className="num">Cancelled</th><th className="num">Attended</th><th className="num">No-shows</th></tr></thead>
              <tbody>
                {stats.by_service.length === 0 && <tr><td colSpan={6} className="empty">No bookings in these dates</td></tr>}
                {stats.by_service.map((row: any) => (
                  <tr key={row.name}>
                    <td>{row.name}{row.capacity > 1 && <div className="muted">Group of up to {row.capacity}</div>}</td>
                    <td className="num">{row.booked}</td>
                    <td className="num">{row.capacity > 1 ? row.sessions : '—'}
                      {row.capacity > 1 && row.sessions > 0 && <div className="muted">{Math.round((100 * row.booked) / (row.sessions * row.capacity))}% full</div>}</td>
                    <td className="num">{row.cancelled}</td>
                    <td className="num">{row.attended}</td>
                    <td className="num">{row.no_show}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card table-wrap">
            <h2>By person</h2>
            <table>
              <thead><tr><th>Person</th><th className="num">Booked</th><th className="num">Cancelled</th><th className="num">Attended</th><th className="num">No-shows</th></tr></thead>
              <tbody>
                {stats.by_staff.length === 0 && <tr><td colSpan={5} className="empty">No bookings in these dates</td></tr>}
                {stats.by_staff.map((row: any) => (
                  <tr key={row.name}>
                    <td>{row.name}</td>
                    <td className="num">{row.booked}</td>
                    <td className="num">{row.cancelled}</td>
                    <td className="num">{row.attended}</td>
                    <td className="num">{row.no_show}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">Counted by the booking's start date in {stats.time_zone}. Mark attended and no-show on the Follow-up page.</p>
          </div>
        </>
      )}
    </div>
  );
}
