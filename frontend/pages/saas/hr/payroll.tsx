import Link from 'next/link';
import { useRouter } from 'next/router';
import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { monthName } from '@/components/HrForms';
import HrNav from '@/components/HrNav';
import Modal from '@/components/Modal';
import { api, formatDate, money, today } from '@/lib/api';

export default function Payroll() {
  return <AppShell><PayrollApp /></AppShell>;
}

function PayrollApp() {
  const [runs, setRuns] = useState<any[] | null>(null);
  const [manager, setManager] = useState<boolean | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.get('/api/hr/overview'), api.get('/api/hr/pay-runs')])
      .then(([summary, rows]) => {
        setManager(summary.is_manager);
        setRuns(rows);
      })
      .catch((err) => setError(err.message));
  }, []);

  if (manager === false) {
    return (
      <div className="stack">
        <HrNav />
        <h1>Payroll</h1>
        <p className="muted">Only owners and admins can run payroll. Your own payslips are on the People page.</p>
      </div>
    );
  }

  return (
    <div className="stack">
      <HrNav />
      <div className="page-head">
        <h1>Payroll</h1>
        <button className="primary" onClick={() => setCreating(true)}>New pay run</button>
      </div>
      {error && <p className="error">{error}</p>}
      <p className="muted">
        Each month's pay run works out everyone's pay from their salary or hours, less unpaid leave. Approving it books
        the cost in Accounting, and marking it paid takes the wages out of your bank account.
      </p>

      <div className="card table-wrap">
        {!runs ? <p className="empty">Loading…</p> : (
          <table>
            <thead><tr><th>#</th><th>Month</th><th>Pay date</th><th>Status</th><th className="num">Gross</th><th className="num">Deductions</th><th className="num">Employer costs</th><th className="num">Take-home</th></tr></thead>
            <tbody>
              {runs.length === 0 && <tr><td colSpan={8} className="empty">No pay runs yet</td></tr>}
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>{run.run_number}</td>
                  <td><Link href={`/saas/hr/payroll/${run.id}`}>{monthName(run.period_start)}</Link></td>
                  <td>{formatDate(run.pay_date)}</td>
                  <td><span className={`badge ${run.status === 'approved' ? 'open' : run.status}`}>{run.status}</span></td>
                  <td className="num">{money(run.gross)}</td>
                  <td className="num">{money(run.deductions)}</td>
                  <td className="num">{money(run.employer_costs)}</td>
                  <td className="num">{money(run.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && <NewRun onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewRun({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const now = today();
  const lastDay = new Date(Number(now.slice(0, 4)), Number(now.slice(5, 7)), 0).getDate();
  const [form, setForm] = useState({ month: now.slice(0, 7), pay_date: `${now.slice(0, 7)}-${lastDay}` });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const run = await api.post('/api/hr/pay-runs', form);
      router.push(`/saas/hr/payroll/${run.id}`);
    } catch (err: any) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Modal title="New pay run">
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Month<input type="month" required value={form.month} onChange={(e) => setForm({ ...form, month: e.target.value })} /></label>
          <label>Pay date<input type="date" required value={form.pay_date} onChange={(e) => setForm({ ...form, pay_date: e.target.value })} /></label>
        </div>
        <p className="muted">Everyone employed during the month is included, except contractors. You can check and change it before approving.</p>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary" disabled={saving}>{saving ? 'Working it out…' : 'Create'}</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
