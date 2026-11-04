import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import EmptyState from '@/components/EmptyState';
import { PersonCell } from '@/components/HrForms';
import HrNav from '@/components/HrNav';
import { ExpenseForm, openReceipt } from '@/components/HrWork';
import Icon from '@/components/Icon';
import { SkeletonStats, SkeletonTable } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api, formatDate, money, today } from '@/lib/api';
import styles from '@/styles/hr.module.css';

export default function Expenses() {
  return <AppShell><ExpensesApp /></AppShell>;
}

const STATUS_STYLE: Record<string, string> = { submitted: 'pending', approved: 'approved_run', paid: 'paid', rejected: 'declined', cancelled: 'cancelled', void: 'void' };
const STATUS_TEXT: Record<string, string> = { submitted: 'Waiting', approved: 'Approved, to pay', paid: 'Paid', rejected: 'Not approved', cancelled: 'Cancelled', void: 'Void' };

function ExpensesApp() {
  const [role, setRole] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [mine, setMine] = useState<any>(null);
  const [people, setPeople] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [claims, setClaims] = useState<any[] | null>(null);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [payment, setPayment] = useState({ account_id: '', date: today() });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const manager = role === 'owner' || role === 'admin';
  const handles = manager || role === 'accountant';

  const load = async () => {
    try {
      const [account, me, directory, kinds, rows] = await Promise.all([
        api.get('/api/me'), api.get('/api/hr/me'), api.get('/api/hr/employees'), api.get('/api/hr/expense-categories'), api.get('/api/hr/expenses')
      ]);
      setRole(account.tenant.role);
      setTenantId(account.tenant.id);
      setMine(me.employee);
      setPeople(directory);
      setCategories(kinds);
      setClaims(rows);
      setError('');
      if (['owner', 'admin', 'accountant'].includes(account.tenant.role) && !accounts.length) {
        const ledger = await api.get('/api/accounting/accounts').catch(() => []);
        const cash = ledger.filter((row: any) => row.is_cash && row.is_active !== false);
        setAccounts(cash);
        setPayment((current) => ({ ...current, account_id: current.account_id || cash[0]?.id || '' }));
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const act = async (work: () => Promise<unknown>, done?: { title: string; detail?: string }) => {
    setBusy(true);
    try {
      await work();
      await load();
      if (done) toast.success(done.title, { detail: done.detail });
    } catch (err: any) {
      toast.error('That did not go through', { detail: err.message });
    } finally {
      setBusy(false);
    }
  };

  // The database decides; this only chooses which buttons to show
  const canDecide = (claim: any) => {
    if (role === 'viewer' || claim.status !== 'submitted') return false;
    const own = mine && claim.employee_id === mine.id;
    if (own) return role === 'owner';
    return manager || (mine && claim.employee?.manager_id === mine.id);
  };

  const decide = (claim: any, approved: boolean) => {
    const note = approved ? '' : window.prompt('Why not? (they will see this)', '');
    if (note === null) return;
    act(() => api.post(`/api/hr/expenses/${claim.id}/decide`, { status: approved ? 'approved' : 'rejected', note }),
      approved ? { title: 'Claim approved', detail: `Claim ${claim.claim_number}, ${money(claim.amount)}, is booked in Accounting.` }
        : { title: 'Claim not approved', detail: `Claim ${claim.claim_number}. They will see your note.` });
  };

  const pay = (event: FormEvent) => {
    event.preventDefault();
    const total = (claims || []).filter((claim) => chosen.includes(claim.id)).reduce((sum, claim) => sum + Number(claim.amount), 0);
    if (!window.confirm(`Pay back ${money(total)} for ${chosen.length} ${chosen.length === 1 ? 'claim' : 'claims'}?`)) return;
    act(async () => {
      await api.post('/api/hr/expenses/pay', { claim_ids: chosen, ...payment });
      setChosen([]);
    }, { title: `Paid back ${money(total)}`, detail: 'The payments are in Accounting.' });
  };

  const receipt = async (claim: any) => {
    try {
      await openReceipt(claim.receipt_path);
    } catch (err: any) {
      toast.error('Could not open the receipt', { detail: err.message });
    }
  };

  const all = claims || [];
  const toDecide = all.filter(canDecide);
  const toPay = handles ? all.filter((claim) => claim.status === 'approved') : [];
  const visible = all.filter((claim) => !status || claim.status === status);
  const waitingTotal = all.filter((claim) => claim.status === 'submitted').reduce((sum, claim) => sum + Number(claim.amount), 0);
  const owedTotal = all.filter((claim) => claim.status === 'approved').reduce((sum, claim) => sum + Number(claim.amount), 0);
  const claimants = manager ? people.filter((row) => !row.end_date || row.end_date >= today()) : mine ? [mine] : [];

  return (
    <div className="stack">
      <HrNav />
      <div className="page-head">
        <div>
          <h1>Expenses</h1>
          <p className="muted">Claim what you spent for work, and get it paid back.</p>
        </div>
        {claimants.length > 0 && <button className="primary always" onClick={() => setCreating(true)}>New claim</button>}
      </div>
      {error && <p className="error">{error}</p>}
      {claims && !mine && !manager && <p className="muted">Your sign-in isn&apos;t linked to an employee, so you can&apos;t claim expenses. Ask an owner or admin to link it.</p>}

      {!claims && !error ? <SkeletonStats count={3} /> : (
        <div className="stats">
          <div className="card">
            <div className="stat-label">Waiting for approval</div><div className="stat-value">{money(waitingTotal)}</div>
            <div className="muted">{all.filter((claim) => claim.status === 'submitted').length} claims</div>
          </div>
          <div className="card">
            <div className="stat-label">Approved, to pay back</div><div className="stat-value">{money(owedTotal)}</div>
            <div className="muted">{all.filter((claim) => claim.status === 'approved').length} claims</div>
          </div>
          {toDecide.length > 0 && <div className="card"><div className="stat-label">For you to decide</div><div className="stat-value">{toDecide.length}</div></div>}
        </div>
      )}

      {toDecide.length > 0 && (
        <div className="card table-wrap">
          <h2>For you to decide <span className="count-pill">{toDecide.length}</span></h2>
          <ClaimTable rows={toDecide} onReceipt={receipt} actions={(claim) => (
            <div className="row-actions">
              <button className="small" disabled={busy} onClick={() => decide(claim, false)}>Decline</button>
              <button className="primary small" disabled={busy} onClick={() => decide(claim, true)}><Icon name="check" size={14} /> Approve</button>
            </div>
          )} />
        </div>
      )}

      {toPay.length > 0 && (
        <form className="card table-wrap" onSubmit={pay}>
          <h2>Approved, to pay back <span className="count-pill">{toPay.length}</span></h2>
          <ClaimTable rows={toPay} onReceipt={receipt} select={{ chosen, setChosen }} />
          <div className="row-actions" style={{ justifyContent: 'flex-start', marginTop: 12 }}>
            <label>Pay from
              <select required value={payment.account_id} onChange={(e) => setPayment({ ...payment, account_id: e.target.value })}>
                {accounts.map((row) => <option key={row.id} value={row.id}>{row.code} {row.name}</option>)}
              </select>
            </label>
            <label>Paid on<input type="date" required value={payment.date} onChange={(e) => setPayment({ ...payment, date: e.target.value })} /></label>
            <button className="primary always" disabled={busy || !chosen.length || !payment.account_id}>Pay {chosen.length || ''} chosen</button>
          </div>
          <p className="muted small">Approving books the cost against 2510 Expenses to Reimburse. Paying clears that from the bank or cash account you choose.</p>
        </form>
      )}

      <div className="card table-wrap">
        <div className="page-head">
          <h2>{manager || role === 'accountant' ? 'All claims' : 'Your claims'}</h2>
          <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any status</option>
            {Object.entries(STATUS_TEXT).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        {!claims ? <SkeletonTable rows={4} columns={6} /> : visible.length === 0 ? (
          <EmptyState compact icon="money" title={status ? `No ${STATUS_TEXT[status].toLowerCase()} claims` : 'No claims yet'}
            line={claimants.length ? 'Snap a receipt and we fill in the date and amount for you.' : 'Claims you can see show up here.'}
            action={claimants.length ? { label: 'New claim', onClick: () => setCreating(true) } : undefined} />
        ) : (
          <ClaimTable rows={visible} onReceipt={receipt} actions={(claim) => (
            <div className="row-actions">
              {claim.status === 'submitted' && (manager || claim.employee_id === mine?.id) && (
                <button className="small always" disabled={busy} onClick={() => window.confirm('Cancel this claim?') && act(() => api.post(`/api/hr/expenses/${claim.id}/cancel`, {}), { title: 'Claim cancelled', detail: `Claim ${claim.claim_number}` })}>Cancel</button>
              )}
              {manager && ['approved', 'paid'].includes(claim.status) && (
                <button className="danger small" disabled={busy} onClick={() => window.confirm('Void this claim? Its entries in Accounting are reversed.') && act(() => api.post(`/api/hr/expenses/${claim.id}/void`, {}), { title: 'Claim voided', detail: 'Its entries in Accounting are reversed.' })}>Void</button>
              )}
            </div>
          )} />
        )}
        <p className="muted small">You see your own claims, your team&apos;s if you manage people, and everyone&apos;s if you&apos;re an owner, admin or accountant. Categories and their ledger accounts are in <Link href="/saas/hr/settings">HR settings</Link>.</p>
      </div>

      {creating && (
        <ExpenseForm people={claimants} me={mine} categories={categories} tenantId={tenantId} onClose={() => setCreating(false)}
          onSaved={async () => { await load(); toast.success('Claim sent', { detail: 'Your manager will get a note to approve it.' }); }} />
      )}
    </div>
  );
}

function ClaimTable({ rows, onReceipt, actions, select }: {
  rows: any[]; onReceipt: (claim: any) => void; actions?: (claim: any) => JSX.Element;
  select?: { chosen: string[]; setChosen: (ids: string[]) => void };
}) {
  return (
    <table>
      <thead>
        <tr>
          {select && <th />}
          <th>Receipt</th><th>Person</th><th>For</th><th>Date</th><th className="num">Amount</th><th>Status</th>{actions && <th />}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && <tr><td colSpan={8} className="empty">No claims</td></tr>}
        {rows.map((claim) => (
          <tr key={claim.id}>
            {select && (
              <td><input type="checkbox" aria-label={`Pay claim ${claim.claim_number}`} checked={select.chosen.includes(claim.id)}
                onChange={(e) => select.setChosen(e.target.checked ? [...select.chosen, claim.id] : select.chosen.filter((value) => value !== claim.id))} /></td>
            )}
            <td>
              {claim.receipt_path
                ? <button type="button" className={`always ${styles.receipt}`} onClick={() => onReceipt(claim)} aria-label={`Open the receipt for claim ${claim.claim_number}`} title="Open receipt"><Icon name="invoice" size={18} /></button>
                : <span className={styles.noReceipt} title="No receipt"><Icon name="x" size={14} /><span className="sr-only">No receipt</span></span>}
            </td>
            <td className="wrap">{claim.employee ? <Link href={`/saas/hr/employee/${claim.employee.id}`}><PersonCell person={claim.employee} size="small" sub={`Claim ${claim.claim_number}`} /></Link> : '—'}</td>
            <td className="wrap">
              <div>{claim.description}</div>
              {claim.category?.name && <span className="chip">{claim.category.name}</span>}
              {claim.decision_note ? <div className="muted small">Note: {claim.decision_note}</div> : null}
            </td>
            <td>{formatDate(claim.expense_date)}</td>
            <td className="num"><strong>{money(claim.amount)}</strong></td>
            <td><span className={`badge ${STATUS_STYLE[claim.status] || ''}`}>{STATUS_TEXT[claim.status] || claim.status}</span>{claim.paid_on && <div className="muted small">{formatDate(claim.paid_on)}</div>}</td>
            {actions && <td>{actions(claim)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
