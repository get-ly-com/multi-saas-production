import Link from 'next/link';
import { useRouter } from 'next/router';
import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import EmptyState from '@/components/EmptyState';
import { PayStepper, monthName } from '@/components/HrForms';
import HrNav from '@/components/HrNav';
import Modal from '@/components/Modal';
import Skeleton, { SkeletonTable } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api, formatDate, money, today } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

export default function Payroll() {
  return <AppShell><PayrollApp /></AppShell>;
}

function PayrollApp() {
  const [runs, setRuns] = useState<any[] | null>(null);
  const [payroll, setPayroll] = useState<boolean | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.get('/api/hr/overview'), api.get('/api/hr/pay-runs')])
      .then(([summary, rows]) => {
        setPayroll(summary.is_payroll);
        setRuns(rows);
      })
      .catch((err) => setError(err.message));
  }, []);

  if (payroll === false) {
    return (
      <div className="stack">
        <HrNav />
        <h1>Payroll</h1>
        <div className="card">
          <EmptyState icon="money" title="Payroll is for the people who run it"
            line="Only owners and admins can run payroll, and accountants if HR settings allow it. Your own payslips are on the People page."
            action={{ label: 'See my payslips', href: '/saas/hr' }} />
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <HrNav />
      <div className="page-head">
        <div>
          <h1>Payroll</h1>
          <p className="muted">Each month: work out pay, approve it, then mark it paid.</p>
        </div>
        <button className="primary" onClick={() => setCreating(true)}>New pay run</button>
      </div>
      {error && <p className="error">{error}</p>}

      {runs && runs[0] && runs[0].status !== 'void' && (
        <Link href={`/saas/hr/payroll/${runs[0].id}`} className="card stat-link" style={{ display: 'grid', gap: 12 }}>
          <div className="page-head" style={{ margin: 0 }}>
            <div>
              <div className="stat-label">Latest pay run</div>
              <div className="stat-value">{monthName(runs[0].period_start)}</div>
            </div>
            <PayStepper status={runs[0].status} large />
          </div>
          <div className="muted">
            {money(runs[0].net)} take-home, paid on {formatDate(runs[0].pay_date)}.{' '}
            {runs[0].status === 'draft' ? 'Check it over, then approve.' : runs[0].status === 'approved' ? 'Approved. Mark it paid when the money leaves.' : 'All paid.'}
          </div>
        </Link>
      )}

      {!runs ? <SkeletonTable rows={4} columns={6} /> : runs.length === 0 ? (
        <div className="card">
          <EmptyState icon="money" title="No pay runs yet"
            line="Start this month's run. Everyone's pay is worked out from their salary or hours, less unpaid leave, and you can check it before approving."
            action={{ label: 'New pay run', onClick: () => setCreating(true) }} />
        </div>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Month</th><th>Pay date</th><th>Progress</th><th className="num">Gross</th><th className="num">Deductions</th><th className="num">Employer costs</th><th className="num">Take-home</th></tr></thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td><Link href={`/saas/hr/payroll/${run.id}`}><strong>{monthName(run.period_start)}</strong></Link><div className="muted small">Run {run.run_number}</div></td>
                  <td>{formatDate(run.pay_date)}</td>
                  <td>{run.status === 'void' ? <span className="badge void">Void</span> : <PayStepper status={run.status} />}</td>
                  <td className="num">{money(run.gross)}</td>
                  <td className="num">{money(run.deductions)}</td>
                  <td className="num">{money(run.employer_costs)}</td>
                  <td className="num"><strong>{money(run.net)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">
        Approving a run books the cost in Accounting. Marking it paid takes the wages out of your bank account.
      </p>

      {payroll && <Liabilities />}

      {creating && <NewRun onClose={() => setCreating(false)} />}
    </div>
  );
}

// What approved pay runs owe the tax office, and recording a payment of it
function Liabilities() {
  const [data, setData] = useState<any>(null);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [form, setForm] = useState({ account_id: '', date: today(), amount: '', memo: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    const result = await api.get('/api/hr/liabilities');
    setData(result);
    setForm((current) => ({ ...current, amount: Number(result.owed) > 0 ? String(result.owed) : '' }));
  };

  useEffect(() => {
    load().catch((err) => setError(err.message));
    api.get('/api/accounting/accounts').then((rows) => {
      const cash = rows.filter((row: any) => row.is_cash && row.is_active !== false);
      setAccounts(cash);
      setForm((current) => ({ ...current, account_id: current.account_id || cash[0]?.id || '' }));
    }).catch((err) => setError(err.message));
  }, []);

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      if (!window.confirm(`Record ${money(form.amount)} of tax and contributions paid?`)) return;
      setSaving(true);
      try {
        await api.post('/api/hr/liabilities/pay', form);
        toast.success('Payment recorded', { detail: `${money(form.amount)} of tax and contributions paid.` });
        setForm((current) => ({ ...current, memo: '' }));
        await load();
        setError('');
      } catch (err: any) {
        setError(err.message);
      } finally {
        setSaving(false);
      }
    });
  };

  const owed = Number(data?.owed || 0);

  return (
    <div className="card stack">
      <h2>Tax and contributions owed</h2>
      {!data ? (error ? <p className="error">{error}</p> : <Skeleton width={160} height={28} />) : (
        <>
          <div className="stat-value">{money(data.owed)}</div>
          {owed <= 0 && <span className="badge paid" style={{ justifySelf: 'start' }}>Nothing owed</span>}
          <p className="muted">Income tax and contributions from approved pay runs, less what you have paid. Paying it takes the money out of a bank or cash account in Accounting.</p>
          {owed > 0 && (
            <form onSubmit={submit}>
              <div className="form-grid">
                <label>Paid from
                  <select required value={form.account_id} onChange={(e) => setForm({ ...form, account_id: e.target.value })}>
                    {accounts.map((row) => <option key={row.id} value={row.id}>{row.code} {row.name}</option>)}
                  </select>
                </label>
                <label>Date paid<input type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
                <label>Amount<input type="number" required min="0.01" max={owed} step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
                <label>Note<input maxLength={200} placeholder="Payroll tax and contributions paid" value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} /></label>
              </div>
              {error && <p className="error">{error}</p>}
              <div className="form-actions">
                <button className="primary" disabled={busy || saving || !form.account_id}>{saving ? 'Saving…' : 'Record payment'}</button>
              </div>
            </form>
          )}
          {data.payments.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Date</th><th>Entry</th><th>Note</th><th>Paid from</th><th className="num">Amount</th></tr></thead>
                <tbody>
                  {data.payments.map((payment: any) => (
                    <tr key={payment.id}>
                      <td>{formatDate(payment.entry_date)}</td>
                      <td>#{payment.entry_number}</td>
                      <td className="wrap">{payment.memo}{payment.reversed && <> <span className="badge void">reversed</span></>}</td>
                      <td>{payment.paid_from}</td>
                      <td className="num">{money(payment.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// The last day of a YYYY-MM month, as YYYY-MM-DD
const monthEnd = (month: string) => {
  if (!/^\d{4}-\d{2}$/.test(month)) return '';
  const last = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  return `${month}-${String(last).padStart(2, '0')}`;
};

function NewRun({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const now = today();
  const [form, setForm] = useState({ month: now.slice(0, 7), pay_date: monthEnd(now.slice(0, 7)) });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      setSaving(true);
      try {
        const run = await api.post('/api/hr/pay-runs', form);
        router.push(`/saas/hr/payroll/${run.id}`);
      } catch (err: any) {
        setError(err.message);
        setSaving(false);
      }
    });
  };

  return (
    <Modal title="New pay run" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Month<input type="month" required value={form.month} onChange={(e) => setForm({ ...form, month: e.target.value, pay_date: monthEnd(e.target.value) || form.pay_date })} /></label>
          <label>Pay date<input type="date" required value={form.pay_date} onChange={(e) => setForm({ ...form, pay_date: e.target.value })} /></label>
        </div>
        <p className="muted">Everyone employed during the month is included, except contractors. You can check and change it before approving.</p>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary" disabled={busy || saving}>{saving ? 'Working it out…' : 'Create'}</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
