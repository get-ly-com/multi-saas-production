import Link from 'next/link';
import { KeyboardEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import Drawer from '@/components/Drawer';
import EmptyState from '@/components/EmptyState';
import { Avatar, Balances, EMPLOYMENT_TYPES, EmployeeForm, LeaveForm, PersonCell, blankEmployee, fullName } from '@/components/HrForms';
import HrNav from '@/components/HrNav';
import Icon from '@/components/Icon';
import { SkeletonStats, SkeletonTable } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api, formatDate, money, today } from '@/lib/api';
import { plural } from '@/lib/format';
import styles from '@/styles/hr.module.css';

export default function People() {
  return <AppShell><PeopleApp /></AppShell>;
}

const status = (person: any) => {
  const now = today();
  if (person.start_date > now) return { label: 'Starting', key: 'starting', style: 'new' };
  if (person.end_date && person.end_date < now) return { label: 'Left', key: 'left', style: 'inactive' };
  return { label: 'Active', key: 'active', style: 'active' };
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
  const [department, setDepartment] = useState('');
  const [showLeft, setShowLeft] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<any>(null);
  const [asking, setAsking] = useState(false);
  const [open, setOpen] = useState<any>(null);

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
  const departments = Array.from(new Set(people.map((person) => person.department?.name).filter(Boolean))).sort() as string[];
  const current = people.filter((person) => status(person).key !== 'left');
  const visible = people
    .filter((person) => showLeft || status(person).key !== 'left')
    .filter((person) => !department || person.department?.name === department)
    .filter((person) => `${fullName(person)} ${person.job_title || ''} ${person.department?.name || ''} ${person.email || ''}`.toLowerCase().includes(query));

  const openRow = (event: KeyboardEvent<HTMLTableRowElement>, person: any) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(person);
    }
  };

  const saved = async () => {
    await load();
    toast.success(editing?.id ? 'Saved' : 'Employee added', { detail: editing?.id ? 'Their record is up to date.' : 'They are on the people list now.' });
  };

  return (
    <div className="stack">
      <HrNav />
      <div className="page-head">
        <div>
          <h1>People</h1>
          <p className="muted">
            {loading ? ' ' : `${plural(current.length, 'person', 'people')}${departments.length ? ` in ${plural(departments.length, 'department')}` : ''}`}
          </p>
        </div>
        <div className="row-actions">
          {me?.employee && <button className="always" onClick={() => setAsking(true)}>Request leave</button>}
          {manager && <button className="primary" onClick={() => setEditing(blankEmployee)}>New employee</button>}
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {!overview && loading ? <SkeletonStats count={4} /> : overview && (
        <div className="stats">
          <div className="card">
            <div className="stat-label">People</div><div className="stat-value">{overview.headcount}</div>
            {overview.starting_soon > 0 && <div className="muted">{overview.starting_soon} starting soon</div>}
          </div>
          <Link href="/saas/hr/leave" className="card stat-link">
            <div className="stat-label">Out today</div><div className="stat-value">{overview.out_today}</div>
            <div className="muted">{overview.out_today ? 'See who is away' : 'Everyone is in'}</div>
          </Link>
          <Link href="/saas/hr/leave" className="card stat-link">
            <div className="stat-label">Leave to decide</div><div className="stat-value">{overview.to_decide}</div>
            <div className="muted">{overview.to_decide > 0 ? 'Review requests' : 'All decided'}</div>
          </Link>
          {payroll && <div className="card"><div className="stat-label">Monthly pay before tax</div><div className="stat-value">{money(overview.monthly_pay)}</div></div>}
        </div>
      )}

      {me?.employee && (
        <div className="card">
          <div className="page-head">
            <h2>My leave</h2>
            {me.payslips.length > 0 && (
              <div className={styles.chips}>
                <span className="muted small">Payslips</span>
                {me.payslips.slice(0, 6).map((slip: any) => (
                  <Link key={slip.id} className="chip" href={`/saas/hr/payslip/${slip.id}`}>{slip.period_start.slice(0, 7)}</Link>
                ))}
              </div>
            )}
          </div>
          <Balances rows={me.balances} />
        </div>
      )}

      {upcoming.length > 0 && (
        <div className="card table-wrap">
          <h2>Coming up</h2>
          <table>
            <tbody>
              {upcoming.slice(0, 12).map((row: any, index: number) => (
                <tr key={`${row.employee_id}-${row.kind}-${index}`}>
                  <td className={row.on_date < today() ? 'late' : ''} style={{ width: 130 }}>{formatDate(row.on_date)}</td>
                  <td className="wrap"><Link href={`/saas/hr/employee/${row.employee_id}`}><PersonCell name={row.name} size="small" /></Link></td>
                  <td><span className="chip">{UPCOMING[row.kind] || row.kind}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {upcoming.length > 12 && <p className="muted">And {upcoming.length - 12} more.</p>}
        </div>
      )}
      {me && !me.employee && !manager && (
        <p className="muted">Your sign-in isn&apos;t linked to an employee yet. Ask an owner or admin to link it so you can ask for leave.</p>
      )}

      <div className="report-filters">
        <label>Search
          <input type="search" aria-label="Search people" placeholder="Name, job or department" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        {departments.length > 1 && (
          <label>Department
            <select value={department} onChange={(e) => setDepartment(e.target.value)}>
              <option value="">All departments</option>
              {departments.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
        )}
        <label className="check"><input type="checkbox" checked={showLeft} onChange={(e) => setShowLeft(e.target.checked)} /> Show people who left</label>
      </div>

      {loading ? <SkeletonTable rows={6} columns={6} /> : people.length === 0 ? (
        <div className="card">
          <EmptyState icon="team" title="No one here yet"
            line={manager ? 'Add your first employee and their leave, pay and checklists all live in one place.' : 'When an owner or admin adds people, they show up here.'}
            action={manager ? { label: 'New employee', onClick: () => setEditing(blankEmployee) } : undefined} />
        </div>
      ) : visible.length === 0 ? (
        <div className="card">
          <EmptyState compact icon="search" title="No one matches" line="Try a different name, or clear the filters."
            action={{ label: 'Clear filters', onClick: () => { setSearch(''); setDepartment(''); } }} />
        </div>
      ) : (
        <div className={`card table-wrap ${styles.directory}`}>
          <table>
            <thead>
              <tr><th>Name</th><th>Role</th><th>Department</th><th>Manager</th><th>Started</th><th>Status</th>{payroll && <th className="num">Pay</th>}</tr>
            </thead>
            <tbody>
              {visible.map((person) => {
                const state = status(person);
                return (
                  <tr key={person.id} tabIndex={0} onClick={() => setOpen(person)} onKeyDown={(e) => openRow(e, person)} aria-label={`Open ${fullName(person)}`}>
                    <td className="wrap"><PersonCell person={person} sub={person.email || `#${person.employee_number}`} /></td>
                    <td className="wrap">
                      <div>{person.job_title || <span className="muted">No job title</span>}</div>
                      <span className="muted small">{EMPLOYMENT_TYPES[person.employment_type]}</span>
                    </td>
                    <td>{person.department ? <span className="chip">{person.department.name}</span> : <span className="muted">—</span>}</td>
                    <td>{person.manager ? fullName(person.manager) : <span className="muted">—</span>}</td>
                    <td>{formatDate(person.start_date)}</td>
                    <td><span className={`badge ${state.style}`}>{state.label}</span></td>
                    {payroll && <td className="num">{person.employment_type === 'contractor' ? '—' : payText(person.pay)}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Drawer open={!!open} title={open ? fullName(open) : ''} subtitle={open?.job_title || 'No job title'} onClose={() => setOpen(null)}
        footer={open && <Link className="button primary always" href={`/saas/hr/employee/${open.id}`}>Open full page <Icon name="arrow-right" size={14} /></Link>}>
        {open && <PersonDetails person={open} payroll={payroll} />}
      </Drawer>

      {editing && <EmployeeForm initial={editing} people={people} onClose={() => setEditing(null)} onSaved={saved} />}
      {asking && me?.employee && (
        <LeaveForm people={[me.employee]} employeeId={me.employee.id} onClose={() => setAsking(false)}
          onSaved={async () => { await load(); toast.success('Leave requested', { detail: 'Your manager will get a note to decide.' }); }} />
      )}
    </div>
  );
}

function PersonDetails({ person, payroll }: { person: any; payroll: boolean }) {
  const state = status(person);
  return (
    <>
      <div className={styles.drawerHead}>
        <Avatar person={person} size="large" gone={state.key === 'left'} />
        <div className={styles.chips}>
          <span className={`badge ${state.style}`}>{state.label}</span>
          {person.department && <span className="chip">{person.department.name}</span>}
          <span className="chip">{EMPLOYMENT_TYPES[person.employment_type]}</span>
          <span className="chip">#{person.employee_number}</span>
        </div>
      </div>
      <dl className={styles.facts}>
        <div><dt>Email</dt><dd>{person.email ? <a href={`mailto:${person.email}`}>{person.email}</a> : <span className="muted">None</span>}</dd></div>
        <div><dt>Phone</dt><dd>{person.phone ? <a href={`tel:${person.phone}`}>{person.phone}</a> : <span className="muted">None</span>}</dd></div>
        <div><dt>Reports to</dt><dd>{person.manager ? fullName(person.manager) : 'No one'}</dd></div>
        <div><dt>Started</dt><dd>{formatDate(person.start_date)}</dd></div>
        {person.end_date && <div><dt>Last day</dt><dd>{formatDate(person.end_date)}</dd></div>}
        {payroll && person.employment_type !== 'contractor' && <div><dt>Pay</dt><dd>{payText(person.pay)}</dd></div>}
      </dl>
    </>
  );
}
