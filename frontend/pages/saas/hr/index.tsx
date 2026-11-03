import Link from 'next/link';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { EMPLOYMENT_TYPES, EmployeeForm, LeaveForm, blankEmployee, fullName } from '@/components/HrForms';
import HrNav from '@/components/HrNav';
import { api, formatDate, money, today } from '@/lib/api';

export default function People() {
  return <AppShell><PeopleApp /></AppShell>;
}

const status = (person: any) => {
  const now = today();
  if (person.start_date > now) return { label: 'starting', style: 'open' };
  if (person.end_date && person.end_date < now) return { label: 'left', style: 'void' };
  return { label: 'active', style: 'paid' };
};

const UPCOMING: Record<string, string> = {
  starts: 'Starts', last_day: 'Last day', probation_ends: 'Probation ends', step_due: 'Checklist step due'
};

const payText = (pay: any) => {
  if (!pay || !Number(pay.amount)) return '—';
  return pay.pay_type === 'salary' ? `${money(pay.amount)} a year` : `${money(pay.amount)} an hour`;
};

function PeopleApp() {
  const [overview, setOverview] = useState<any>(null);
  const [me, setMe] = useState<any>(null);
  const [people, setPeople] = useState<any[]>([]);
  const [upcoming, setUpcoming] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [showLeft, setShowLeft] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<any>(null);
  const [asking, setAsking] = useState(false);

  const load = async () => {
    try {
      const [summary, mine, rows] = await Promise.all([api.get('/api/hr/overview'), api.get('/api/hr/me'), api.get('/api/hr/employees')]);
      setOverview(summary);
      setMe(mine);
      setPeople(rows);
      setError('');
      api.get('/api/hr/upcoming?days=45').then(setUpcoming).catch(() => setUpcoming([]));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const manager = overview?.is_manager;
  const payroll = overview?.is_payroll;
  const query = search.trim().toLowerCase();
  const visible = people
    .filter((person) => showLeft || status(person).label !== 'left')
    .filter((person) => `${fullName(person)} ${person.job_title || ''} ${person.department?.name || ''} ${person.email || ''}`.toLowerCase().includes(query));

  return (
    <div className="stack">
      <HrNav />
      <div className="page-head">
        <h1>People</h1>
        <div className="row-actions">
          {me?.employee && <button onClick={() => setAsking(true)}>Request leave</button>}
          {manager && <button className="primary" onClick={() => setEditing(blankEmployee)}>New employee</button>}
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {overview && (
        <div className="stats">
          <div className="card"><div className="stat-label">People</div><div className="stat-value">{overview.headcount}</div>
            {overview.starting_soon > 0 && <div className="muted">{overview.starting_soon} starting soon</div>}</div>
          <div className="card"><div className="stat-label">Out today</div><div className="stat-value">{overview.out_today}</div></div>
          <div className="card"><div className="stat-label">Leave to decide</div><div className="stat-value">{overview.to_decide}</div>
            {overview.to_decide > 0 && <Link href="/saas/hr/leave">Review</Link>}</div>
          {payroll && <div className="card"><div className="stat-label">Monthly pay before tax</div><div className="stat-value">{money(overview.monthly_pay)}</div></div>}
        </div>
      )}

      {me?.employee && (
        <div className="card">
          <h2>My leave</h2>
          <div className="stats">
            {me.balances.map((row: any) => (
              <div key={row.leave_type_id}>
                <div className="stat-label">{row.name}</div>
                <div className="stat-value">{row.limited ? `${row.left} left` : `${row.taken} taken`}</div>
                {row.limited && <div className="muted">of {row.allowance} days{Number(row.carried_over) > 0 ? ` + ${row.carried_over} carried over` : ''}{Number(row.pending) > 0 ? `, ${row.pending} waiting` : ''}</div>}
              </div>
            ))}
          </div>
          {me.payslips.length > 0 && (
            <p>My payslips: {me.payslips.slice(0, 6).map((slip: any, index: number) => (
              <span key={slip.id}>{index > 0 && ' · '}<Link href={`/saas/hr/payslip/${slip.id}`}>{slip.period_start.slice(0, 7)}</Link></span>
            ))}</p>
          )}
        </div>
      )}
      {upcoming.length > 0 && (
        <div className="card table-wrap">
          <h2>Coming up</h2>
          <table>
            <tbody>
              {upcoming.slice(0, 12).map((row: any, index: number) => (
                <tr key={`${row.employee_id}-${row.kind}-${index}`}>
                  <td className={row.on_date < today() ? 'late' : ''}>{formatDate(row.on_date)}</td>
                  <td className="wrap"><Link href={`/saas/hr/employee/${row.employee_id}`}>{row.name}</Link></td>
                  <td>{UPCOMING[row.kind] || row.kind}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {upcoming.length > 12 && <p className="muted">And {upcoming.length - 12} more.</p>}
        </div>
      )}
      {me && !me.employee && !manager && (
        <p className="muted">Your sign-in isn't linked to an employee yet. Ask an owner or admin to link it so you can ask for leave.</p>
      )}

      <div className="row-actions" style={{ justifyContent: 'flex-start' }}>
        <input aria-label="Search people" placeholder="Search by name, job or department" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="check"><input type="checkbox" checked={showLeft} onChange={(e) => setShowLeft(e.target.checked)} /> Show people who left</label>
      </div>

      <div className="card table-wrap">
        {loading ? <p className="empty">Loading…</p> : (
          <table>
            <thead>
              <tr><th>#</th><th>Name</th><th>Job</th><th>Department</th><th>Manager</th><th>Type</th><th>Started</th><th>Status</th>{payroll && <th className="num">Pay</th>}</tr>
            </thead>
            <tbody>
              {visible.length === 0 && <tr><td colSpan={9} className="empty">{people.length ? 'No matches' : manager ? 'No one yet. Add your first employee.' : 'No one yet'}</td></tr>}
              {visible.map((person) => {
                const state = status(person);
                return (
                  <tr key={person.id}>
                    <td>{person.employee_number}</td>
                    <td className="wrap"><Link href={`/saas/hr/employee/${person.id}`}>{fullName(person)}</Link></td>
                    <td className="wrap">{person.job_title || '—'}</td>
                    <td>{person.department?.name || '—'}</td>
                    <td>{fullName(person.manager) || '—'}</td>
                    <td>{EMPLOYMENT_TYPES[person.employment_type]}</td>
                    <td>{formatDate(person.start_date)}</td>
                    <td><span className={`badge ${state.style}`}>{state.label}</span></td>
                    {payroll && <td className="num">{person.employment_type === 'contractor' ? '—' : payText(person.pay)}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {editing && <EmployeeForm initial={editing} people={people} onClose={() => setEditing(null)} onSaved={load} />}
      {asking && me?.employee && <LeaveForm people={[me.employee]} employeeId={me.employee.id} onClose={() => setAsking(false)} onSaved={load} />}
    </div>
  );
}
