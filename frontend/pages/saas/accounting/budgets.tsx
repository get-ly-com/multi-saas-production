import { useEffect, useState } from 'react';
import AccountingNav from '@/components/AccountingNav';
import AppShell from '@/components/AppShell';
import Modal from '@/components/Modal';
import { api, money, today } from '@/lib/api';

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

  const remove = async () => {
    if (!window.confirm(`Delete ${selected.name}? This can't be undone.`)) return;
    try {
      await api.delete(`/api/accounting/budgets/${budgetId}`);
      setBudgetId('');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="stack">
      <AccountingNav />
      <div className="page-head">
        <h1>Budgets</h1>
        <button className="primary" onClick={() => setForm({ name: '', fiscal_year: Number(today().slice(0, 4)), lines: [] })}>New budget</button>
      </div>

      {error && <p className="error">{error}</p>}

      {budgets.length === 0 ? <div className="card"><p className="empty">No budgets yet</p></div> : (
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
            <button className="danger" onClick={remove}>Delete budget</button>
          </div>

          <div className="card table-wrap">
            <h2>Budget against actual</h2>
            {!report ? <p className="empty">Loading…</p> : (
              <table>
                <thead><tr><th>Account</th><th className="num">Budget</th><th className="num">Actual</th><th className="num">Better or worse</th></tr></thead>
                <tbody>
                  {report.rows.length === 0 && <tr><td colSpan={4} className="empty">Nothing budgeted or posted in these months</td></tr>}
                  {report.rows.map((row: any) => (
                    <tr key={row.account_id}>
                      <td className="wrap">{row.code} {row.name}</td>
                      <td className="num">{money(row.budgeted)}</td>
                      <td className="num">{money(row.actual)}</td>
                      <td className="num">{money(row.variance)}</td>
                    </tr>
                  ))}
                  <tr className="total"><td colSpan={3}>Overall</td><td className="num">{money(report.total_variance)}</td></tr>
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

  const save = async () => {
    const lines = Object.entries(cells)
      .filter(([, value]) => Number(value) > 0)
      .map(([key, value]) => {
        const [account_id, month] = key.split(':');
        return { account_id, month: Number(month), amount: Number(value) };
      });

    try {
      const result = await api.post('/api/accounting/budgets', { id: initial.id, name, fiscal_year: year, lines });
      await onSaved(result.id);
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title={initial.id ? `Edit ${initial.name}` : 'New budget'}>
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
