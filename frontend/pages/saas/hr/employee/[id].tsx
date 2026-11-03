import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { EMPLOYMENT_TYPES, EmployeeForm, LeaveForm, employeeForm, fullName, leaveDates } from '@/components/HrForms';
import HrNav from '@/components/HrNav';
import { api, formatDate, money } from '@/lib/api';

export default function EmployeePage() {
  return <AppShell><EmployeeApp /></AppShell>;
}

function EmployeeApp() {
  const router = useRouter();
  const id = router.query.id as string | undefined;
  const [person, setPerson] = useState<any>(null);
  const [people, setPeople] = useState<any[]>([]);
  const [manager, setManager] = useState(false);
  const [isMe, setIsMe] = useState(false);
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    if (!id) return;
    try {
      const [row, rows, summary, mine] = await Promise.all([
        api.get(`/api/hr/employees/${id}`), api.get('/api/hr/employees'), api.get('/api/hr/overview'), api.get('/api/hr/me')
      ]);
      setPerson(row);
      setPeople(rows);
      setManager(summary.is_manager);
      setIsMe(mine.employee?.id === row.id);
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, [id]);

  const remove = async () => {
    if (!window.confirm(`Delete ${fullName(person)} and their leave history? This can't be undone.`)) return;
    try {
      await api.delete(`/api/hr/employees/${person.id}`);
      router.push('/saas/hr');
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (!person) return <div className="stack"><HrNav />{error ? <p className="error">{error}</p> : <p className="empty">Loading…</p>}</div>;

  const pay = person.pay;
  const reports = people.filter((row) => row.manager_id === person.id);

  return (
    <div className="stack">
      <HrNav />
      <div className="page-head">
        <div>
          <h1>{fullName(person)}</h1>
          <p className="muted">#{person.employee_number}{person.job_title ? ` · ${person.job_title}` : ''}{person.department ? ` · ${person.department.name}` : ''}</p>
        </div>
        <div className="row-actions">
          {(manager || isMe) && <button onClick={() => setAsking(true)}>Request leave</button>}
          {manager && <button onClick={() => setEditing(true)}>Edit</button>}
          {manager && <button className="danger" onClick={remove}>Delete</button>}
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="stats">
        <div className="card">
          <div className="stat-label">Contact</div>
          <div>{person.email || 'No email'}</div>
          <div>{person.phone || 'No phone'}</div>
        </div>
        <div className="card">
          <div className="stat-label">Employment</div>
          <div>{EMPLOYMENT_TYPES[person.employment_type]}</div>
          <div>Started {formatDate(person.start_date)}</div>
          {person.end_date && <div>Leaves {formatDate(person.end_date)}</div>}
        </div>
        <div className="card">
          <div className="stat-label">Reports to</div>
          <div>{person.manager ? <Link href={`/saas/hr/employee/${person.manager.id}`}>{fullName(person.manager)}</Link> : 'No one'}</div>
          {reports.length > 0 && <div className="muted">{reports.length} {reports.length === 1 ? 'person reports' : 'people report'} to them</div>}
        </div>
        {pay && (
          <div className="card">
            <div className="stat-label">Pay (owners and admins only)</div>
            <div>{pay.pay_type === 'salary' ? `${money(pay.amount)} a year` : `${money(pay.amount)} an hour, ${pay.hours_per_week} hours a week`}</div>
            {pay.notes && <div className="muted" style={{ whiteSpace: 'pre-wrap' }}>{pay.notes}</div>}
          </div>
        )}
      </div>

      {person.balances && (
        <div className="card">
          <h2>Leave this year</h2>
          <div className="stats">
            {person.balances.map((row: any) => (
              <div key={row.leave_type_id}>
                <div className="stat-label">{row.name}</div>
                <div className="stat-value">{row.limited ? `${row.left} left` : `${row.taken} taken`}</div>
                {row.limited && <div className="muted">{row.taken} taken of {row.allowance}{Number(row.pending) > 0 ? `, ${row.pending} waiting` : ''}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {person.balances && (
        <div className="card table-wrap">
          <h2>Leave requests</h2>
          <table>
            <thead><tr><th>Dates</th><th>Type</th><th className="num">Days</th><th>Status</th><th>Reason</th></tr></thead>
            <tbody>
              {person.leave.length === 0 && <tr><td colSpan={5} className="empty">No leave yet</td></tr>}
              {person.leave.map((row: any) => (
                <tr key={row.id}>
                  <td>{leaveDates(row)}</td>
                  <td>{row.leave_type?.name}</td>
                  <td className="num">{Number(row.days)}</td>
                  <td><span className={`badge ${row.status === 'approved' ? 'paid' : row.status === 'pending' ? 'open' : 'void'}`}>{row.status}</span></td>
                  <td className="wrap">{row.reason || '—'}{row.decision_note ? ` · ${row.decision_note}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {manager && person.payslips.length > 0 && (
        <div className="card table-wrap">
          <h2>Payslips</h2>
          <table>
            <thead><tr><th>Month</th><th>Paid on</th><th>Status</th><th className="num">Gross</th><th className="num">Take-home</th></tr></thead>
            <tbody>
              {person.payslips.filter((slip: any) => slip.run).map((slip: any) => (
                <tr key={slip.id}>
                  <td><Link href={`/saas/hr/payslip/${slip.id}`}>{slip.run.period_start.slice(0, 7)}</Link></td>
                  <td>{formatDate(slip.run.pay_date)}</td>
                  <td><span className={`badge ${slip.run.status}`}>{slip.run.status}</span></td>
                  <td className="num">{money(slip.gross)}</td>
                  <td className="num">{money(slip.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && <EmployeeForm initial={employeeForm(person)} people={people} onClose={() => setEditing(false)} onSaved={load} />}
      {asking && <LeaveForm people={[person]} employeeId={person.id} onClose={() => setAsking(false)} onSaved={load} />}
    </div>
  );
}
