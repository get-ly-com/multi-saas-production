import { FormEvent, useEffect, useState } from 'react';
import AccountingNav from '@/components/AccountingNav';
import AppShell from '@/components/AppShell';
import Modal from '@/components/Modal';
import { api, formatDate, money, today } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

const blankLine = { account_id: '', cost_center_id: '', debit: '', credit: '' };

const SOURCE_LABELS: Record<string, string> = {
  invoice_payment: 'payment', invoice_cost: 'cost of sales', payroll_payment: 'wages paid', payroll_tax: 'payroll tax paid'
};
const sourceLabel = (source: string) => SOURCE_LABELS[source] || source.replace('_', ' ');

export default function Journal() {
  return <AppShell><JournalApp /></AppShell>;
}

function JournalApp() {
  const [entries, setEntries] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [costCenters, setCostCenters] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  const load = async () => {
    try {
      const [entryRows, accountRows, centerRows] = await Promise.all([
        api.get('/api/accounting/journal'),
        api.get('/api/accounting/accounts'),
        api.get('/api/accounting/cost-centers')
      ]);
      setCostCenters(centerRows.filter((center: any) => center.is_active));
      setEntries(entryRows);
      setAccounts(accountRows.filter((account: any) => account.is_active));
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
  const reverse = (entry: any) => once(async () => {
    if (!window.confirm(`Reverse entry #${entry.entry_number}? A new entry will cancel it out.`)) return;
    try {
      await api.post(`/api/accounting/journal/${entry.id}/reverse`, {});
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  });

  return (
    <div className="stack">
      <AccountingNav />
      <div className="page-head">
        <h1>Journal</h1>
        <button className="primary" onClick={() => setCreating(true)}>New journal entry</button>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="card table-wrap">
        {loading ? <p className="empty">Loading…</p> : (
          <table>
            <thead>
              <tr><th>#</th><th>Date</th><th>Description</th><th>Account</th><th className="num">Debit</th><th className="num">Credit</th><th /></tr>
            </thead>
            <tbody>
              {entries.length === 0 && <tr><td colSpan={7} className="empty">No journal entries yet</td></tr>}
              {entries.flatMap((entry) => entry.lines.map((line: any, index: number) => (
                <tr key={line.id}>
                  <td>{index === 0 ? entry.entry_number : ''}</td>
                  <td>{index === 0 ? formatDate(entry.entry_date) : ''}</td>
                  <td className="wrap">
                    {index === 0 && <>{entry.memo} <span className="badge">{sourceLabel(entry.source_type)}</span></>}
                    {index === 0 && entry.reversed && <> <span className="badge void">reversed</span></>}
                  </td>
                  <td>{line.account.code} {line.account.name}</td>
                  <td className="num">{Number(line.debit) ? money(line.debit) : ''}</td>
                  <td className="num">{Number(line.credit) ? money(line.credit) : ''}</td>
                  <td>
                    {index === 0 && entry.source_type === 'manual' && !entry.reversal_of && !entry.reversed && (
                      <div className="row-actions"><button disabled={busy} onClick={() => reverse(entry)}>Reverse</button></div>
                    )}
                  </td>
                </tr>
              )))}
            </tbody>
          </table>
        )}
      </div>

      {creating && <EntryForm accounts={accounts} costCenters={costCenters} onClose={() => setCreating(false)} onSaved={load} />}
    </div>
  );
}

function EntryForm({ accounts, costCenters, onClose, onSaved }: { accounts: any[]; costCenters: any[]; onClose: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(today());
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState([blankLine, blankLine]);
  const [error, setError] = useState('');

  const setLine = (index: number, field: string, value: string) =>
    setLines(lines.map((line, i) => (i === index ? { ...line, [field]: value } : line)));

  const total = (field: 'debit' | 'credit') =>
    lines.reduce((sum, line) => sum + Math.round(Number(line[field] || 0) * 100), 0) / 100;

  const balanced = total('debit') === total('credit') && total('debit') > 0;

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api.post('/api/accounting/journal', {
          entry_date: date,
          memo,
          lines: lines.map(({ account_id, cost_center_id, debit, credit }) => ({
            account_id,
            cost_center_id: cost_center_id || null,
            debit: Number(debit || 0),
            credit: Number(credit || 0)
          }))
        });
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title="New journal entry" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Date<input required type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label>Description<input required value={memo} onChange={(e) => setMemo(e.target.value)} /></label>
        </div>
        <div className="lines">
          {lines.map((line, index) => (
            <div className="journal-line" key={index}>
              <select required aria-label="Account" value={line.account_id} onChange={(e) => setLine(index, 'account_id', e.target.value)}>
                <option value="">Choose account</option>
                {accounts.map((account) => <option key={account.id} value={account.id}>{account.code} {account.name}</option>)}
              </select>
              <select aria-label="Cost center" value={line.cost_center_id} onChange={(e) => setLine(index, 'cost_center_id', e.target.value)}>
                <option value="">No center</option>
                {costCenters.map((center) => <option key={center.id} value={center.id}>{center.code}</option>)}
              </select>
              <input aria-label="Debit" placeholder="Debit" type="number" min="0" step="0.01" value={line.debit} onChange={(e) => setLine(index, 'debit', e.target.value)} />
              <input aria-label="Credit" placeholder="Credit" type="number" min="0" step="0.01" value={line.credit} onChange={(e) => setLine(index, 'credit', e.target.value)} />
              <button type="button" aria-label="Remove line" disabled={lines.length === 2} onClick={() => setLines(lines.filter((_, i) => i !== index))}>×</button>
            </div>
          ))}
        </div>
        <button type="button" onClick={() => setLines([...lines, blankLine])}>Add line</button>
        <p>Debits {money(total('debit'))} · Credits {money(total('credit'))}</p>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary" disabled={busy || !balanced}>Post entry</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
