import Link from 'next/link';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { fullName } from '@/components/HrForms';
import HrNav from '@/components/HrNav';
import { api, today } from '@/lib/api';

export default function OrgChart() {
  return <AppShell><OrgChartApp /></AppShell>;
}

// Who reports to whom, from each person's manager. People who have left aren't shown;
// anyone whose manager has left sits at the top.
function OrgChartApp() {
  const [people, setPeople] = useState<any[] | null>(null);
  const [department, setDepartment] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/hr/employees').then(setPeople).catch((err) => setError(err.message));
  }, []);

  const now = today();
  const current = (people || []).filter((row) => !row.end_date || row.end_date >= now);
  const ids = new Set(current.map((row) => row.id));
  const reportsOf = new Map<string, any[]>();
  for (const person of current) {
    const key = person.manager_id && ids.has(person.manager_id) ? person.manager_id : '';
    reportsOf.set(key, [...(reportsOf.get(key) || []), person]);
  }
  const departments = Array.from(new Set(current.map((row) => row.department?.name).filter(Boolean))).sort();

  // Shows a branch if anyone in it is in the chosen department
  const inBranch = (person: any, seen: Set<string>): boolean => {
    if (seen.has(person.id)) return false;
    seen.add(person.id);
    return !department || person.department?.name === department
      || (reportsOf.get(person.id) || []).some((row) => inBranch(row, seen));
  };

  const branch = (person: any, seen: Set<string>): JSX.Element | null => {
    if (seen.has(person.id)) return null;
    seen.add(person.id);
    const reports = (reportsOf.get(person.id) || []).filter((row) => inBranch(row, new Set(seen)));
    const dim = department && person.department?.name !== department;
    return (
      <li key={person.id}>
        <Link href={`/saas/hr/employee/${person.id}`} className={`org-card${dim ? ' dim' : ''}`}>
          <strong>{fullName(person)}</strong>
          <span>{person.job_title || 'No job title'}</span>
          {person.department && <span className="muted">{person.department.name}</span>}
          {reports.length > 0 && <span className="muted">{reports.length} {reports.length === 1 ? 'report' : 'reports'}</span>}
        </Link>
        {reports.length > 0 && <ul>{reports.map((row) => branch(row, seen))}</ul>}
      </li>
    );
  };

  const tops = (reportsOf.get('') || []).filter((row) => inBranch(row, new Set()));
  const seen = new Set<string>();

  return (
    <div className="stack">
      <HrNav />
      <div className="page-head">
        <h1>Org chart</h1>
        {departments.length > 0 && (
          <select aria-label="Department" value={department} onChange={(e) => setDepartment(e.target.value)}>
            <option value="">Everyone</option>
            {departments.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {!people ? <p className="empty">Loading…</p> : current.length === 0 ? <p className="empty">No one yet.</p> : (
        <div className="card org-chart-wrap">
          <ul className="org-chart">{tops.map((row) => branch(row, seen))}</ul>
        </div>
      )}
      <p className="muted">Set each person&apos;s manager on their record to build the chart. {current.length} people.</p>
    </div>
  );
}
