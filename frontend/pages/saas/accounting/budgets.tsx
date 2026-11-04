import { useEffect, useState } from 'react';
import AccountingNav from '@/components/AccountingNav';
import { Amount, PageHead, styles } from '@/components/AccountingKit';
import AppShell, { useAccount } from '@/components/AppShell';
import EmptyState from '@/components/EmptyState';
import Modal from '@/components/Modal';
import { SkeletonTable } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api, today } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function Budgets() {
  return <AppShell><BudgetsApp /></AppShell>;
}

function BudgetsApp() {
  const [budgets, setBudgets] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [budgetId, setBudgetId] = useState('');
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(12);
  const [report, setReport] = useState<any>(null);
  const [form, setForm] = useState<any>(null);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const canEdit = useAccount()?.canEdit;
  const newBudget = () => setForm({ name: '', fiscal_year: Number(today().slice(0, 4)), lines: [] });

  const load = async () => {
    try {
      const [budgetRows, accountRows] = await Promise.all([
        api.get('/api/accounting/budgets'),
        api.get('/api/accounting/accounts')
      ]);
      setBudgets(budgetRows);
      setAccounts(accountRows.filter((account: any) => ['revenue', 'expense'].includes(account.type) && account.is_active));
      setBudgetId((current) => (budgetRows.some((row: any) => row.id === current) ? current : budgetRows[0]?.id || ''));
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const loadReport = () => {
    if (!budgetId) return setReport(null);
    api.get(`/api/accounting/budgets/${budgetId}/actual?from=${from}&to=${to}`)
      .then((data) => {
        setReport(data);
        setError('');
      })
      .catch((err) => setError(err.message));
  };

  useEffect(loadReport, [budgetId, from, to]);

  const selected = budgets.find((budget) => budget.id === budgetId);

  const { busy, run: once } = useSubmit();
  const remove = () => once(async () => {
    if (!window.confirm(`Delete ${selected.name}? This can't be undone.`)) return;
    try {
      await api.delete(`/api/accounting/budgets/${budgetId}`);
      toast.success('Budget deleted', { detail: `${selected.name} ${selected.fiscal_year} is gone` });
      setBudgetId('');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  });

  return (
    <div className="stack">
      <AccountingNav />
      <PageHead title="Budgets" line="Plan income and spending by month, then see how the year is really going.">
        <button className="primary" onClick={newBudget}>New budget</button>
      </PageHead>

      {error && <p className="error">{error}</p>}

      {!loaded ? <SkeletonTable rows={5} columns={4} /> : budgets.length === 0 ? (
        <div className="card">
          <EmptyState icon="analytics" title="No budgets yet" line="Set a monthly target for each income and expense account, then compare it with what really happened."
            action={canEdit ? { label: 'New budget', onClick: newBudget } : undefined} />
        </div>
      ) : (
        <>
          <div className="report-filters">
            <label>Budget
              <select value={budgetId} onChange={(e) => setBudgetId(e.target.value)}>
                {budgets.map((budget) => <option key={budget.id} value={budget.id}>{budget.name} {budget.fiscal_year}</option>)}
              </select>
            </label>
            <label>From
              <select value={from} onChange={(e) => setFrom(Number(e.target.value))}>
                {MONTHS.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}
              </select>
            </label>
            <label>To
              <select value={to} onChange={(e) => setTo(Number(e.target.value))}>
                {MONTHS.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}
              </select>
            </label>
          </div>

          <div className="form-actions">
            <button onClick={() => setForm(selected)}>Edit budget</button>
            <button disabled={busy} className="danger" onClick={remove}>Delete budget</button>
          </div>

          <div className="card table-wrap">
            <h2>Budget against actual</h2>
            {!report ? <SkeletonTable rows={4} columns={4} /> : report.rows.length === 0 ? (
              <EmptyState compact icon="analytics" title="Nothing budgeted or posted in these months" line="Pick other months, or edit the budget to add amounts." />
            ) : (
              <table>
                <thead><tr><th>Account</th><th className="num">Budget</th><th className="num">Actual</th><th className="num">Better or worse</th></tr></thead>
                <tbody>
                  {report.rows.map((row: any) => (
                    <tr key={row.account_id}>
                      <td className="wrap"><span className="muted">{row.code}</span> {row.name}</td>
                      <td className="num"><Amount value={row.budgeted} /></td>
                      <td className="num"><Amount value={row.actual} /></td>
                      <td className="num"><Amount value={row.variance} /></td>
                    </tr>
                  ))}
                  <tr className={styles.totalRow}><td colSpan={3}>Overall</td><td className="num"><Amount value={report.total_variance} strong /></td></tr>
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {form && (
        <BudgetForm
          initial={form}
          accounts={accounts}
          onClose={() => setForm(null)}
          onSaved={async (id: string) => {
            await load();
            setBudgetId(id);
            loadReport();
          }}
        />
      )}
    </div>
  );
}

function BudgetForm({ initial, accounts, onClose, onSaved }: { initial: any; accounts: any[]; onClose: () => void; onSaved: (id: string) => void }) {
  const [name, setName] = useState(initial.name);
  const [year, setYear] = useState(initial.fiscal_year);
  const [cells, setCells] = useState<Record<string, string>>(() =>
    Object.fromEntries(initial.lines.map((line: any) => [`${line.account_id}:${line.month}`, String(line.amount)])));
  const [error, setError] = useState('');

  const setCell = (key: string, value: string) => setCells({ ...cells, [key]: value });

  const fillYear = (accountId: string) => {
    const first = cells[`${accountId}:1`] || '';
    const filled = { ...cells };
    MONTHS.forEach((_, index) => {
      filled[`${accountId}:${index + 1}`] = first;
    });
    setCells(filled);
  };

  const { busy, run: once } = useSubmit();
  const save = () => once(async () => {
    const lines = Object.entries(cells)
      .filter(([, value]) => Number(value) > 0)
      .map(([key, value]) => {
        const [account_id, month] = key.split(':');
        return { account_id, month: Number(month), amount: Number(value) };
      });

    try {
      const result = await api.post('/api/accounting/budgets', { id: initial.id, name, fiscal_year: year, lines });
      await onSaved(result.id);
      toast.success(initial.id ? 'Budget saved' : 'Budget created', { detail: `${name} ${year} is ready to compare` });
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  });

  return (
    <Modal title={initial.id ? `Edit ${initial.name}` : 'New budget'} onClose={onClose}>
      <div className="form-grid">
        <label>Name<input required value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Year<input required type="number" min="2000" max="2100" value={year} onChange={(e) => setYear(Number(e.target.value))} /></label>
      </div>
      <div className="table-wrap budget-grid" style={{ marginTop: 12 }}>
        <table>
          <thead><tr><th>Account</th>{MONTHS.map((month) => <th key={month}>{month}</th>)}<th /></tr></thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.id}>
                <td>{account.code} {account.name}</td>
                {MONTHS.map((month, index) => {
                  const key = `${account.id}:${index + 1}`;
                  return (
                    <td key={month}>
                      <input aria-label={`${account.name} ${month}`} type="number" min="0" step="0.01" value={cells[key] || ''} onChange={(e) => setCell(key, e.target.value)} />
                    </td>
                  );
                })}
                <td><button type="button" onClick={() => fillYear(account.id)}>Copy Jan</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button className="primary" disabled={!name} onClick={save}>Save budget</button>
        <button type="button" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
