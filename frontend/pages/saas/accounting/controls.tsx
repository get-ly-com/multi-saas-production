import { useEffect, useState } from 'react';
import AccountingNav from '@/components/AccountingNav';
import AppShell from '@/components/AppShell';
import { api, formatDate, money, today } from '@/lib/api';

const TABLE_NAMES: Record<string, string> = {
  invoices: 'Invoice',
  bills: 'Bill',
  expenses: 'Expense',
  customers: 'Customer',
  vendors: 'Vendor',
  accounts: 'Account',
  tax_rates: 'Tax rate',
  payments: 'Payment',
  credit_notes: 'Credit note',
  journal_entries: 'Journal entry',
  bank_lines: 'Bank line',
  reconciliations: 'Reconciliation',
  settings: 'Book setting',
  tenant_members: 'Team member',
  cost_centers: 'Cost center',
  budgets: 'Budget',
  fixed_assets: 'Fixed asset',
  vendor_credits: 'Vendor credit',
  exchange_rates: 'Exchange rate',
  purchase_orders: 'Purchase order',
  recurring_invoices: 'Recurring invoice',
  revenue_schedules: 'Revenue schedule'
};

const ACTIONS: Record<string, string> = { insert: 'Created', update: 'Changed', delete: 'Deleted' };

const describe = (row: any) => {
  if (row.action === 'insert' && row.changes.lock_date) return `lock date: ${short(row.changes.lock_date)}`;
  if (row.action !== 'update') return '';
  return Object.entries(row.changes)
    .map(([field, change]: [string, any]) => `${field.replace(/_/g, ' ')}: ${short(change.from)} → ${short(change.to)}`)
    .join('; ');
};

const short = (value: unknown) => {
  if (value === null || value === undefined) return 'empty';
  const text = typeof value === 'object' ? 'details' : String(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
};

export default function Controls() {
  return <AppShell><ControlsApp /></AppShell>;
}

function ControlsApp() {
  const [role, setRole] = useState('');
  const [lockDate, setLockDate] = useState<string | null>(null);
  const [newLock, setNewLock] = useState(today());
  const [limit, setLimit] = useState('');
  const [savedLimit, setSavedLimit] = useState<string | null>(null);
  const [yearEnd, setYearEnd] = useState(`${Number(today().slice(0, 4)) - 1}-12-31`);
  const [audit, setAudit] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    try {
      const [me, books] = await Promise.all([api.get('/api/me'), api.get('/api/accounting/books')]);
      setRole(me.tenant.role);
      setLockDate(books.lock_date);
      setSavedLimit(books.bill_approval_limit);
      setLimit(books.bill_approval_limit ?? '');
      if (['owner', 'admin'].includes(me.tenant.role)) setAudit(await api.get('/api/accounting/audit'));
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const run = async (action: () => Promise<unknown>, done: string) => {
    try {
      await action();
      setNotice(done);
      await load();
    } catch (err: any) {
      setNotice('');
      setError(err.message);
    }
  };

  const closeYear = () => {
    const question = `Close the year to ${formatDate(yearEnd)}? Profit moves to Retained Earnings and everything up to that date is locked.`;
    if (window.confirm(question)) {
      run(() => api.post('/api/accounting/books/close-year', { date: yearEnd }), `Year closed to ${formatDate(yearEnd)}.`);
    }
  };

  const manager = ['owner', 'admin'].includes(role);

  return (
    <div className="stack">
      <AccountingNav />
      <div className="page-head"><h1>Controls</h1></div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="card">
        <h2>Period lock</h2>
        <p>{lockDate ? `Books are locked through ${formatDate(lockDate)}. Nothing can be posted on or before that date.` : 'No period is locked.'}</p>
        {manager ? (
          <>
            <div className="report-filters">
              <label>Lock through<input type="date" value={newLock} onChange={(e) => setNewLock(e.target.value)} /></label>
            </div>
            <div className="form-actions">
              <button className="primary" disabled={!newLock} onClick={() => run(() => api.put('/api/accounting/books/lock', { lock_date: newLock }), `Locked through ${formatDate(newLock)}.`)}>Lock</button>
              {role === 'owner' && lockDate && (
                <button onClick={() => run(() => api.put('/api/accounting/books/lock', { lock_date: null }), 'All periods reopened.')}>Reopen all</button>
              )}
            </div>
          </>
        ) : <p className="muted">Only owners and admins can change this.</p>}
      </div>

      {manager && (
        <div className="card">
          <h2>Bill approval limit</h2>
          <p>{savedLimit === null ? 'Anyone who can enter bills can approve them.' : `Accountants can approve bills up to ${money(savedLimit)}. Larger bills need an owner or admin, unless they match an approved purchase order.`}</p>
          <div className="report-filters">
            <label>Limit<input type="number" min="0" step="0.01" placeholder="No limit" value={limit} onChange={(e) => setLimit(e.target.value)} /></label>
          </div>
          <div className="form-actions">
            <button className="primary" onClick={() => run(() => api.put('/api/accounting/books/approval-limit', { bill_approval_limit: limit }), 'Approval limit saved.')}>Save limit</button>
          </div>
        </div>
      )}

      {manager && (
        <div className="card">
          <h2>Year-end close</h2>
          <p className="muted">Moves income and expenses up to this date into Retained Earnings, then locks the period. Your profit and loss report still shows the year's figures.</p>
          <div className="report-filters">
            <label>Year end<input type="date" value={yearEnd} onChange={(e) => setYearEnd(e.target.value)} /></label>
          </div>
          <div className="form-actions"><button className="primary" disabled={!yearEnd} onClick={closeYear}>Close year</button></div>
        </div>
      )}

      {manager && (
        <div className="card table-wrap">
          <h2>Audit trail</h2>
          <p className="muted">The latest 200 changes in accounting and to your team. This record can't be edited or deleted by anyone.</p>
          <table>
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Record</th><th>Details</th></tr></thead>
            <tbody>
              {audit.length === 0 && <tr><td colSpan={5} className="empty">No changes recorded yet</td></tr>}
              {audit.map((row) => (
                <tr key={row.id}>
                  <td>{new Date(`${row.created_at}Z`).toLocaleString()}</td>
                  <td>{row.user_email || 'System'}</td>
                  <td>{ACTIONS[row.action]} {(TABLE_NAMES[row.table_name] || row.table_name).toLowerCase()}</td>
                  <td className="wrap">{row.label || '—'}</td>
                  <td className="wrap">{describe(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
