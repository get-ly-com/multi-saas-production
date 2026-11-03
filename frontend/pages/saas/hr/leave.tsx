import Link from 'next/link';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { LEAVE_STATUSES, LeaveForm, fullName, leaveDates } from '@/components/HrForms';
import HrNav from '@/components/HrNav';
import { api, today } from '@/lib/api';

export default function Leave() {
  return <AppShell><LeaveApp /></AppShell>;
}

const addDays = (date: string, days: number) => {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
};

function LeaveApp() {
  const [requests, setRequests] = useState<any[]>([]);
  const [out, setOut] = useState<any[]>([]);
  const [people, setPeople] = useState<any[]>([]);
  const [me, setMe] = useState<any>(null);
  const [manager, setManager] = useState(false);
  const [filter, setFilter] = useState('pending');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const from = today();
      const [rows, away, staff, mine, summary] = await Promise.all([
        api.get(`/api/hr/leave${filter ? `?status=${filter}` : ''}`),
        api.get(`/api/hr/leave/out?from=${from}&to=${addDays(from, 30)}`),
        api.get('/api/hr/employees'),
        api.get('/api/hr/me'),
        api.get('/api/hr/overview')
      ]);
      setRequests(rows);
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

  const act = async (path: string, body: unknown = {}) => {
    try {
      await api.post(path, body);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const decide = (row: any, status: string) => {
    const note = status === 'rejected' ? window.prompt('Reason for saying no (optional)') : '';
    if (note === null) return;
    act(`/api/hr/leave/${row.id}/decide`, { status, note });
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

  return (
    <div className="stack">
      <HrNav />
      <div className="page-head">
        <h1>Leave</h1>
        {askable.length > 0 && <button className="primary" onClick={() => setAsking(true)}>Request leave</button>}
      </div>

      {error && <p className="error">{error}</p>}

      <div className="card table-wrap">
        <h2>Who's out in the next 30 days</h2>
        <table>
          <thead><tr><th>Person</th><th>Dates</th><th>Type</th><th className="num">Days</th></tr></thead>
          <tbody>
            {out.length === 0 && <tr><td colSpan={4} className="empty">Everyone's in</td></tr>}
            {out.map((row) => (
              <tr key={row.id}>
                <td><Link href={`/saas/hr/employee/${row.employee_id}`}>{row.name}</Link></td>
                <td>{leaveDates(row)}</td>
                <td>{row.leave_type}</td>
                <td className="num">{Number(row.days)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card table-wrap">
        <div className="page-head">
          <h2>Requests</h2>
          <select aria-label="Show requests" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All</option>
            {LEAVE_STATUSES.map((status) => <option key={status} value={status}>{status[0].toUpperCase() + status.slice(1)}</option>)}
          </select>
        </div>
        <table>
          <thead><tr><th>Person</th><th>Dates</th><th>Type</th><th className="num">Days</th><th>Reason</th><th>Status</th><th /></tr></thead>
          <tbody>
            {requests.length === 0 && <tr><td colSpan={7} className="empty">No {filter} requests you can see</td></tr>}
            {requests.map((row) => (
              <tr key={row.id}>
                <td><Link href={`/saas/hr/employee/${row.employee_id}`}>{fullName(row.employee)}</Link></td>
                <td>{leaveDates(row)}</td>
                <td>{row.leave_type?.name}{row.leave_type && !row.leave_type.paid ? ' (unpaid)' : ''}</td>
                <td className="num">{Number(row.days)}</td>
                <td className="wrap">{row.reason || '—'}{row.decision_note ? ` · ${row.decision_note}` : ''}</td>
                <td><span className={`badge ${row.status === 'approved' ? 'paid' : row.status === 'pending' ? 'open' : 'void'}`}>{row.status}</span></td>
                <td>
                  <div className="row-actions">
                    {row.status === 'pending' && canDecide(row) && (
                      <>
                        <button className="primary" onClick={() => decide(row, 'approved')}>Approve</button>
                        <button onClick={() => decide(row, 'rejected')}>Say no</button>
                      </>
                    )}
                    {['pending', 'approved'].includes(row.status) && canCancel(row) && (
                      <button className="danger" onClick={() => window.confirm('Cancel this leave?') && act(`/api/hr/leave/${row.id}/cancel`)}>Cancel</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">You see your own requests, your team's if you manage people, and everyone's if you're an owner or admin. Others see only that someone is away.</p>
      </div>

      {asking && <LeaveForm people={askable} employeeId={manager ? undefined : mineId} onClose={() => setAsking(false)} onSaved={load} />}
    </div>
  );
}
