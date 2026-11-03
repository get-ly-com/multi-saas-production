import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import IntegrationsNav, { OnlyManagers, dateTime } from '@/components/IntegrationsNav';
import { api } from '@/lib/api';

export default function Jobs() {
  return <AppShell><JobsApp /></AppShell>;
}

const SCHEDULES: Record<string, string> = {
  '* * * * *': 'Every minute',
  '5 * * * *': 'Every hour, 5 minutes past',
  '17 3 * * *': 'Every day at 03:17 UTC'
};

function JobsApp() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setData(await api.get('/api/integration/overview'));
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (!data) return <div className="stack"><IntegrationsNav />{error ? <p className="error">{error}</p> : <p className="empty">Loading…</p>}</div>;
  if (!data.is_manager) return <div className="stack"><IntegrationsNav /><h1>Background jobs</h1><OnlyManagers /></div>;

  return (
    <div className="stack">
      <IntegrationsNav />
      <div className="page-head">
        <h1>Background jobs</h1>
        <button onClick={load}>Refresh</button>
      </div>
      <p className="muted">
        These run on a schedule inside the database for every company. Nothing here changes your books: recurring invoices,
        depreciation, revenue schedules and payroll still only run when someone chooses to run them.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Job</th><th>When</th><th>Last run</th><th>Result</th></tr></thead>
          <tbody>
            {data.jobs.length === 0 && <tr><td colSpan={4} className="empty">No jobs found</td></tr>}
            {data.jobs.map((job: any) => (
              <tr key={job.name}>
                <td>{job.description || job.name}<div className="muted">{job.name}</div></td>
                <td>{job.active ? SCHEDULES[job.schedule] || job.schedule : 'Paused'}</td>
                <td>{job.last_run ? dateTime(job.last_run) : 'Not yet'}</td>
                <td>
                  {job.last_status === 'succeeded' && <span className="badge delivered">Worked</span>}
                  {job.last_status === 'failed' && <span className="badge failed">Failed</span>}
                  {job.last_status && !['succeeded', 'failed'].includes(job.last_status) && <span className="badge">{job.last_status}</span>}
                  {Number(job.failed_today) > 0 && <div className="muted">{job.failed_today} failed in the last day</div>}
                  {job.last_error && <div className="muted">{job.last_error}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
