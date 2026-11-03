import Link from 'next/link';
import { useRouter } from 'next/router';
import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { fullName, monthName } from '@/components/HrForms';
import HrNav from '@/components/HrNav';
import Modal from '@/components/Modal';
import { api, formatDate, money, today } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';

export default function PayRunPage() {
  return <AppShell><PayRunApp /></AppShell>;
}

const deductions = (line: any) => Number(line.income_tax) + Number(line.employee_contributions) + Number(line.other_deductions);

function PayRunApp() {
  const router = useRouter();
  const id = router.query.id as string | undefined;
  const [run, setRun] = useState<any>(null);
  const [editing, setEditing] = useState<any>(null);
  const [paying, setPaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    if (!id) return;
    try {
      setRun(await api.get(`/api/hr/pay-runs/${id}`));
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, [id]);

  const act = async (work: () => Promise<unknown>, question?: string) => {
    if (question && !window.confirm(question)) return;
    setBusy(true);
    try {
      await work();
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm('Delete this draft pay run?')) return;
    try {
      await api.delete(`/api/hr/pay-runs/${run.id}`);
      router.push('/saas/hr/payroll');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const exportCsv = () => {
    downloadCsv(`payroll-${run.period_start.slice(0, 7)}.csv`, [
      ['Number', 'Name', 'Hours', 'Base pay', 'Unpaid leave', 'Additions', 'Gross', 'Income tax', 'Employee contributions', 'Other deductions', 'Take-home', 'Employer contributions'],
      ...run.lines.map((line: any) => [line.employee?.employee_number, fullName(line.employee), line.hours ?? '', line.base_pay, line.unpaid_deduction,
        line.additions, line.gross, line.income_tax, line.employee_contributions, line.other_deductions, line.net, line.employer_contributions])
    ]);
  };

  if (!run) return <div className="stack"><HrNav />{error ? <p className="error">{error}</p> : <p className="empty">Loading…</p>}</div>;

  const draft = run.status === 'draft';

  return (
    <div className="stack">
      <HrNav />
      <div className="page-head">
        <div>
          <h1>Payroll for {monthName(run.period_start)}</h1>
          <p className="muted">Pay run {run.run_number} · paid on {formatDate(run.pay_date)} · <span className={`badge ${run.status === 'approved' ? 'open' : run.status}`}>{run.status}</span>
            {run.paid_on && ` · paid ${formatDate(run.paid_on)}`}</p>
        </div>
        <div className="row-actions">
          <button onClick={exportCsv}>Download CSV</button>
          {draft && (
            <>
              <button disabled={busy} onClick={() => act(() => api.post(`/api/hr/pay-runs/${run.id}/recalculate`, {}), 'Work everyone\'s pay out again from their current pay and leave? Your changes to this run will be lost.')}>Recalculate</button>
              <button className="danger" disabled={busy} onClick={remove}>Delete</button>
              <button className="primary" disabled={busy || !run.lines.length} onClick={() => act(() => api.post(`/api/hr/pay-runs/${run.id}/approve`, {}), `Approve ${money(run.gross)} of pay? It's booked in Accounting and can't be changed after, only voided.`)}>Approve</button>
            </>
          )}
          {run.status === 'approved' && <button className="primary" disabled={busy} onClick={() => setPaying(true)}>Mark as paid</button>}
          {['approved', 'paid'].includes(run.status) && (
            <button className="danger" disabled={busy} onClick={() => act(() => api.post(`/api/hr/pay-runs/${run.id}/void`, {}), 'Void this pay run? Its entries in Accounting are reversed.')}>Void</button>
          )}
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="stats">
        <div className="card"><div className="stat-label">Gross pay</div><div className="stat-value">{money(run.gross)}</div></div>
        <div className="card"><div className="stat-label">Deductions</div><div className="stat-value">{money(run.deductions)}</div><div className="muted">Tax and contributions you pay over</div></div>
        <div className="card"><div className="stat-label">Employer costs</div><div className="stat-value">{money(run.employer_costs)}</div></div>
        <div className="card"><div className="stat-label">Take-home to pay staff</div><div className="stat-value">{money(run.net)}</div></div>
      </div>

      <div className="card table-wrap">
        <table>
          <thead>
            <tr><th>Person</th><th className="num">Hours</th><th className="num">Base pay</th><th className="num">Unpaid leave</th><th className="num">Additions</th>
              <th className="num">Gross</th><th className="num">Deductions</th><th className="num">Take-home</th><th className="num">Employer</th><th /></tr>
          </thead>
          <tbody>
            {run.lines.length === 0 && <tr><td colSpan={10} className="empty">No one on this pay run</td></tr>}
            {run.lines.map((line: any) => (
              <tr key={line.id}>
                <td className="wrap">
                  <Link href={`/saas/hr/employee/${line.employee_id}`}>{fullName(line.employee)}</Link>
                  {line.note && <div className="muted">{line.note}</div>}
                </td>
                <td className="num">{line.hours ?? '—'}</td>
                <td className="num">{money(line.base_pay)}</td>
                <td className="num">{Number(line.unpaid_deduction) ? `−${money(line.unpaid_deduction)} (${Number(line.unpaid_days)} days)` : '—'}</td>
                <td className="num">{Number(line.additions) ? money(line.additions) : '—'}</td>
                <td className="num">{money(line.gross)}</td>
                <td className="num">{money(deductions(line))}</td>
                <td className="num"><strong>{money(line.net)}</strong></td>
                <td className="num">{money(line.employer_contributions)}</td>
                <td>
                  <div className="row-actions">
                    <Link href={`/saas/hr/payslip/${line.id}`}>Payslip</Link>
                    {draft && <button onClick={() => setEditing(line)}>Change</button>}
                    {draft && <button className="danger" onClick={() => act(() => api.delete(`/api/hr/pay-lines/${line.id}`), `Take ${fullName(line.employee)} off this pay run?`)}>Remove</button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {draft && <p className="muted">Taxes start from the rates in HR settings. Change any line to add a bonus or overtime, or to enter the exact tax for that person.</p>}

      {editing && <LineForm line={editing} onClose={() => setEditing(null)} onSaved={load} />}
      {paying && <PayForm run={run} onClose={() => setPaying(false)} onSaved={load} />}
    </div>
  );
}

const LINE_FIELDS = [
  { field: 'additions', label: 'Bonus, overtime or other additions' },
  { field: 'income_tax', label: 'Income tax withheld' },
  { field: 'employee_contributions', label: 'Employee contributions' },
  { field: 'other_deductions', label: 'Other deductions' },
  { field: 'employer_contributions', label: 'Employer contributions' }
];

function LineForm({ line, onClose, onSaved }: { line: any; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<any>({
    hours: line.hours ?? '', note: line.note || '',
    ...Object.fromEntries(LINE_FIELDS.map(({ field }) => [field, line[field]]))
  });
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // Only changed amounts are sent, so a new bonus still has its tax worked out from the rates
    const body: any = { note: form.note };
    for (const field of ['hours', ...LINE_FIELDS.map(({ field }) => field)]) {
      if (String(form[field]) !== String(line[field] ?? '')) body[field] = form[field];
    }
    try {
      await api.put(`/api/hr/pay-lines/${line.id}`, body);
      await onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title={`Change pay for ${fullName(line.employee)}`}>
      <form onSubmit={submit}>
        <div className="form-grid">
          {line.pay_type === 'hourly' && (
            <label>Hours worked<input type="number" min="0" max="744" step="0.25" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} /></label>
          )}
          {LINE_FIELDS.map(({ field, label }) => (
            <label key={field}>{label}<input type="number" min="0" step="0.01" value={form[field]} onChange={(e) => setForm({ ...form, [field]: e.target.value })} /></label>
          ))}
        </div>
        <label style={{ marginTop: 12 }}>Note on the payslip<input maxLength={200} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
        <p className="muted">If you change hours or additions and leave the taxes as they are, the taxes are worked out again from your rates.</p>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function PayForm({ run, onClose, onSaved }: { run: any; onClose: () => void; onSaved: () => void }) {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [form, setForm] = useState({ account_id: '', date: run.pay_date || today() });
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/accounting/accounts').then((rows) => {
      const cash = rows.filter((row: any) => row.is_cash && row.is_active !== false);
      setAccounts(cash);
      setForm((current) => ({ ...current, account_id: current.account_id || cash[0]?.id || '' }));
    }).catch((err) => setError(err.message));
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post(`/api/hr/pay-runs/${run.id}/pay`, form);
      await onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title="Mark as paid">
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Paid from
            <select required value={form.account_id} onChange={(e) => setForm({ ...form, account_id: e.target.value })}>
              {accounts.map((row) => <option key={row.id} value={row.id}>{row.code} {row.name}</option>)}
            </select>
          </label>
          <label>Date paid<input type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
        </div>
        <p className="muted">
          This records {money(run.net)} of take-home pay leaving that account. The {money(Number(run.deductions) + Number(run.employer_costs))} of
          tax and contributions stays in Payroll Liabilities until you pay it to the tax office.
        </p>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary">Mark as paid</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
