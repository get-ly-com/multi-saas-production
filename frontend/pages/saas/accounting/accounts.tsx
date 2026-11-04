import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import AccountingNav from '@/components/AccountingNav';
import { FilterPills, PageHead, StatusPill } from '@/components/AccountingKit';
import AppShell, { useAccount } from '@/components/AppShell';
import EmptyState from '@/components/EmptyState';
import Modal from '@/components/Modal';
import { SkeletonTable } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

const TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'];
const blankAccount = { code: '', name: '', type: 'expense', is_cash: false };
const TYPE_LABELS: Record<string, string> = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', revenue: 'Revenue', expense: 'Expenses' };
const TYPE_NAMES: Record<string, string> = { asset: 'Asset', liability: 'Liability', equity: 'Equity', revenue: 'Revenue', expense: 'Expense' };

export default function Accounts() {
  return <AppShell><AccountsApp /></AppShell>;
}

function AccountsApp() {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState<any>(null);
  const [type, setType] = useState('all');
  const canEdit = useAccount()?.canEdit;

  const load = async () => {
    try {
      setAccounts(await api.get('/api/accounting/accounts'));
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const { busy, run: once } = useSubmit();
  const setActive = (account: any, is_active: boolean): Promise<void> => once(async () => {
    try {
      await api.put(`/api/accounting/accounts/${account.id}`, { is_active });
      await load();
      toast.success(is_active ? 'Account active again' : 'Account deactivated', {
        detail: `${account.code} ${account.name}${is_active ? ' can be used again' : ' is hidden from new entries'}`,
        action: { label: 'Undo', onClick: () => { setActive(account, !is_active); } }
      });
    } catch (err: any) {
      setError(err.message);
    }
  });

  return (
    <div className="stack">
      <AccountingNav />
      <PageHead title="Chart of accounts" line="Every account your books post to. Open one to see its ledger.">
        <button className="primary" onClick={() => setForm(blankAccount)}>New account</button>
      </PageHead>

      {error && <p className="error">{error}</p>}

      {!loading && accounts.length > 0 && (
        <FilterPills
          label="Account type"
          value={type}
          onChange={setType}
          options={[{ id: 'all', label: 'All', count: accounts.length }, ...TYPES.map((id) => ({ id, label: TYPE_LABELS[id], count: accounts.filter((account) => account.type === id).length }))]}
        />
      )}

      {loading ? <SkeletonTable rows={8} columns={5} /> : accounts.length === 0 ? (
        <div className="card">
          <EmptyState icon="accounting" title="No accounts yet" line="Add the accounts your business posts to."
            action={canEdit ? { label: 'New account', onClick: () => setForm(blankAccount) } : undefined} />
        </div>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Status</th><th /></tr></thead>
            <tbody>
              {accounts.filter((account) => type === 'all' || account.type === type).map((account) => (
                <tr key={account.id}>
                  <td>{account.code}</td>
                  <td className="wrap"><Link href={`/saas/accounting/ledger?account=${account.id}`}>{account.name}</Link></td>
                  <td>{account.is_cash ? 'Cash or bank' : TYPE_NAMES[account.type] || account.type}</td>
                  <td><StatusPill status={account.is_active ? 'active' : 'inactive'} /></td>
                  <td>
                    <div className="row-actions">
                      <button onClick={() => setForm(account)}>Rename</button>
                      {!account.is_system && (
                        <button disabled={busy} onClick={() => setActive(account, !account.is_active)}>{account.is_active ? 'Deactivate' : 'Activate'}</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {form && <AccountForm initial={form} onClose={() => setForm(null)} onSaved={load} />}
    </div>
  );
}

function AccountForm({ initial, onClose, onSaved }: { initial: any; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<any>(initial);
  const [error, setError] = useState('');
  const set = (field: string, value: unknown) => setForm({ ...form, [field]: value });

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      const { code, name, type, is_cash } = form;
      try {
        if (form.id) await api.put(`/api/accounting/accounts/${form.id}`, { name });
        else await api.post('/api/accounting/accounts', { code, name, type, is_cash: type === 'asset' && is_cash });
        await onSaved();
        toast.success(form.id ? 'Account renamed' : 'Account added', { detail: `${code} ${name}` });
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title={form.id ? `Rename ${form.code}` : 'New account'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          {!form.id && (
            <label>Code<input required value={form.code} onChange={(e) => set('code', e.target.value)} /></label>
          )}
          <label>Name<input required value={form.name} onChange={(e) => set('name', e.target.value)} /></label>
          {!form.id && (
            <label>Type
              <select value={form.type} onChange={(e) => set('type', e.target.value)}>
                {TYPES.map((type) => <option key={type} value={type}>{TYPE_NAMES[type]}</option>)}
              </select>
            </label>
          )}
        </div>
        {!form.id && form.type === 'asset' && (
          <label className="check">
            <input type="checkbox" checked={form.is_cash} onChange={(e) => set('is_cash', e.target.checked)} />
            This is a cash or bank account
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
