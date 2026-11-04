import { useEffect, useRef, useState } from 'react';
import AppShell from '@/components/AppShell';
import { SkeletonTable } from '@/components/Skeleton';
import EmptyState from '@/components/EmptyState';
import { BookingDetails } from '@/components/SchedulerForms';
import SchedulerNav, { LOCATIONS, dayLabel } from '@/components/SchedulerNav';
import { api } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

export default function FollowUp() {
  return <AppShell><FollowUpList /></AppShell>;
}

// We don't send emails or texts, so this is the list to work through by hand:
// who to remind before their booking, and who still needs marking as attended or no-show.
function FollowUpList() {
  const [data, setData] = useState<any>(null);
  const [lists, setLists] = useState<any>(null);
  const [staff, setStaff] = useState('');
  const [open, setOpen] = useState<any>(null);
  const [error, setError] = useState('');
  const latest = useRef(0);

  useEffect(() => {
    Promise.all([api.get('/api/scheduler/overview'), api.get('/api/scheduler/services')])
      .then(([overview, services]) => setData({ ...overview, services }))
      .catch((err) => setError(err.message));
  }, []);

  const load = async () => {
    const mine = ++latest.current;
    try {
      const result = await api.get(`/api/scheduler/follow-up${staff ? `?staff=${staff}` : ''}`);
      if (mine !== latest.current) return;
      setLists(result);
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, [staff]);

  const { busy, run: once } = useSubmit();
  // One action at a time, so a double click cannot repeat it
  const act = (work: () => Promise<any>) => once(async () => {
    try {
      await work();
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  });

  if (!data || !lists) return <div className="stack"><SchedulerNav />{error ? <p className="error">{error}</p> : <SkeletonTable rows={4} columns={5} />}</div>;
  const edit = data.can_edit;

  return (
    <div className="stack">
      <SchedulerNav />
      <div className="page-head">
        <h1>Follow-up</h1>
        <select aria-label="Whose bookings" value={staff} onChange={(e) => setStaff(e.target.value)} style={{ width: 'auto' }}>
          <option value="">Everyone</option>
          {data.staff.filter((row: any) => row.set_up).map((row: any) => (
            <option key={row.user_id} value={row.user_id}>{row.user_id === data.me ? `${row.display_name} (me)` : row.display_name}</option>
          ))}
        </select>
      </div>
      {error && <p className="error">{error}</p>}

      <div className="card">
        <h2>Remind before the booking (next 2 days)</h2>
        <p className="muted">We don't send reminders, so call or message these people yourself and tick them off.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Customer</th><th>How to reach them</th><th>Service</th><th>With</th><th>Reminded</th></tr></thead>
            <tbody>
              {lists.to_remind.length === 0 && <tr><td colSpan={6}><EmptyState compact tone="done" icon="bell" title="Nobody to remind" line="No bookings in the next 2 days need a reminder." /></td></tr>}
              {lists.to_remind.map((row: any) => (
                <tr key={row.id}>
                  <td>{dayLabel(row.local_date)} {row.start_time}</td>
                  <td><a href="#" onClick={(e) => { e.preventDefault(); setOpen(row); }}>{row.customer_name}</a></td>
                  <td className="wrap">
                    {row.customer_phone && <div><a href={`tel:${row.customer_phone}`}>{row.customer_phone}</a></div>}
                    {row.customer_email && <div><a href={`mailto:${row.customer_email}`}>{row.customer_email}</a></div>}
                    {!row.customer_phone && !row.customer_email && <span className="muted">No phone or email</span>}
                  </td>
                  <td>{row.service_name}<div className="muted">{LOCATIONS[row.location_type]}</div></td>
                  <td>{row.staff_name}</td>
                  <td>
                    <label className="check" style={{ marginTop: 0 }}>
                      <input type="checkbox" disabled={!edit} checked={!!row.reminded_at}
                        onChange={(e) => act(() => api.post(`/api/scheduler/bookings/${row.id}/reminded`, { done: e.target.checked }))} />
                      {row.reminded_at ? ' Done' : ' Not yet'}
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>Did they come? (last 30 days)</h2>
        <p className="muted">Mark each past booking. No-shows go on the CRM contact's timeline and into Reports.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Customer</th><th>Service</th><th>With</th><th /></tr></thead>
            <tbody>
              {lists.to_mark.length === 0 && <tr><td colSpan={5}><EmptyState compact tone="done" icon="paid" title="Everything is marked" line="Every past booking says who came. Nice and tidy." /></td></tr>}
              {lists.to_mark.map((row: any) => (
                <tr key={row.id}>
                  <td>{dayLabel(row.local_date)} {row.start_time}</td>
                  <td><a href="#" onClick={(e) => { e.preventDefault(); setOpen(row); }}>{row.customer_name}</a></td>
                  <td>{row.service_name}</td>
                  <td>{row.staff_name}</td>
                  <td>
                    {edit && (
                      <div className="row-actions">
                        <button onClick={() => act(() => api.post(`/api/scheduler/bookings/${row.id}/attendance`, { value: 'attended' }))}>Attended</button>
                        <button className="danger" onClick={() => act(() => api.post(`/api/scheduler/bookings/${row.id}/attendance`, { value: 'no_show' }))}>No-show</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted">Times are in {lists.time_zone}.</p>
      </div>

      {open && <BookingDetails booking={open} data={data} onClose={() => setOpen(null)} onSaved={load} />}
    </div>
  );
}
