import { useEffect, useState } from 'react';
import AccountingNav from '@/components/AccountingNav';
import AppShell from '@/components/AppShell';
import BankImport from '@/components/BankImport';
import Modal from '@/components/Modal';
import { api, formatDate, money, today } from '@/lib/api';

export default function Banking() {
  return <AppShell><BankingApp /></AppShell>;
}

function BankingApp() {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [accountId, setAccountId] = useState('');
  const [tab, setTab] = useState<'lines' | 'reconcile'>('lines');
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/accounting/accounts')
      .then((rows) => {
        const banks = rows.filter((account: any) => account.is_cash && account.is_active);
        setAccounts(rows.filter((account: any) => account.is_active));
        if (banks[0]) setAccountId(banks[0].id);
      })
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div className="stack">
      <AccountingNav />
      <div className="page-head"><h1>Banking</h1></div>

      <label>Account
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.filter((account) => account.is_cash).map((account) => (
            <option key={account.id} value={account.id}>{account.code} {account.name}</option>
          ))}
        </select>
      </label>

      <div className="tabs">
        <button className={tab === 'lines' ? 'active' : ''} onClick={() => setTab('lines')}>Statement lines</button>
        <button className={tab === 'reconcile' ? 'active' : ''} onClick={() => setTab('reconcile')}>Reconcile</button>
      </div>

      {error && <p className="error">{error}</p>}

      {accountId && tab === 'lines' && <StatementLines key={accountId} accountId={accountId} accounts={accounts} />}
      {accountId && tab === 'reconcile' && <Reconcile key={accountId} accountId={accountId} />}
    </div>
  );
}

function StatementLines({ accountId, accounts }: { accountId: string; accounts: any[] }) {
  const [lines, setLines] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [importing, setImporting] = useState(false);
  const [posting, setPosting] = useState<any>(null);

  const load = async () => {
    try {
      setLines(await api.get(`/api/accounting/bank/lines?account_id=${accountId}`));
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

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <>
      <div className="page-head">
        <span className="muted">{lines.filter((line) => line.status === 'unmatched').length} lines to review</span>
        <button className="primary" onClick={() => setImporting(true)}>Import statement</button>
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="card table-wrap">
        {loading ? <p className="empty">Loading…</p> : (
          <table>
            <thead><tr><th>Date</th><th>Description</th><th className="num">Amount</th><th>Status</th><th /></tr></thead>
            <tbody>
              {lines.length === 0 && <tr><td colSpan={5} className="empty">No statement lines yet</td></tr>}
              {lines.map((line) => (
                <tr key={line.id}>
                  <td>{formatDate(line.line_date)}</td>
                  <td className="wrap">
                    {line.description}
                    {line.status === 'matched' && <div className="muted">{line.matched_memo}</div>}
                    {line.suggested_line_id && <div className="muted">Looks like: {line.suggested_memo}, {formatDate(line.suggested_date)}</div>}
                  </td>
                  <td className="num">{money(line.amount)}</td>
                  <td><span className={`badge ${line.status === 'matched' ? 'paid' : ''}`}>{line.reconciled ? 'reconciled' : line.status}</span></td>
                  <td>
                    <div className="row-actions">
                      {line.suggested_line_id && (
                        <button onClick={() => run(() => api.post(`/api/accounting/bank/lines/${line.id}/match`, { journal_line_id: line.suggested_line_id }))}>Match</button>
                      )}
                      {line.status === 'unmatched' && (
                        <>
                          <button onClick={() => setPosting(line)}>Post</button>
                          <button onClick={() => run(() => api.post(`/api/accounting/bank/lines/${line.id}/ignore`, { ignored: true }))}>Ignore</button>
                        </>
                      )}
                      {line.status === 'ignored' && (
                        <button onClick={() => run(() => api.post(`/api/accounting/bank/lines/${line.id}/ignore`, { ignored: false }))}>Restore</button>
                      )}
                      {line.status === 'matched' && !line.reconciled && (
                        <button onClick={() => run(() => api.post(`/api/accounting/bank/lines/${line.id}/unmatch`, {}))}>Unmatch</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {importing && (
        <BankImport
          accountId={accountId}
          onClose={() => setImporting(false)}
          onSaved={async (message) => {
            setNotice(message);
            await load();
          }}
        />
      )}
      {posting && (
        <PostForm
          line={posting}
          accounts={accounts.filter((account) => account.id !== accountId && !['1200', '2000'].includes(account.code))}
          onClose={() => setPosting(null)}
          onSaved={load}
        />
      )}
    </>
  );
}

function PostForm({ line, accounts, onClose, onSaved }: { line: any; accounts: any[]; onClose: () => void; onSaved: () => void }) {
  const [accountId, setAccountId] = useState('');
  const [memo, setMemo] = useState(line.description);
  const [error, setError] = useState('');

  const save = async () => {
    try {
      await api.post(`/api/accounting/bank/lines/${line.id}/post`, { account_id: accountId, memo });
      await onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title={`Post ${money(line.amount)} to the books`}>
      <p className="muted">Use this for money the books don't have yet, such as a bank fee. Customer and vendor money should be matched to its payment instead.</p>
      <div className="form-grid">
        <label>Account
          <select required value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Choose an account</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.code} {account.name}</option>)}
          </select>
        </label>
        <label>Description<input value={memo} onChange={(e) => setMemo(e.target.value)} /></label>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button className="primary" disabled={!accountId} onClick={save}>Post</button>
        <button type="button" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

function Reconcile({ accountId }: { accountId: string }) {
  const [asOf, setAsOf] = useState(today());
  const [balance, setBalance] = useState('');
  const [status, setStatus] = useState<any>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    try {
      setStatus(await api.get(`/api/accounting/bank/reconcile?account_id=${accountId}&as_of=${asOf}`));
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, [asOf]);

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const unclear = (item: any) => {
    if (window.confirm('Unclear this item? If it was posted from a statement line, that entry is reversed.')) {
      run(() => api.post(`/api/accounting/bank/lines/${item.bank_line_id}/unmatch`, {}));
    }
  };

  const finish = () =>
    run(async () => {
      await api.post('/api/accounting/bank/reconcile', { account_id: accountId, statement_date: asOf, statement_balance: balance });
      setNotice(`Reconciled to ${formatDate(asOf)}. Cleared items up to that date are now locked.`);
      setBalance('');
    });

  if (!status) return error ? <p className="error">{error}</p> : <p className="empty">Loading…</p>;

  const cents = (value: unknown) => Math.round(Number(value) * 100);
  const difference = (cents(balance) - cents(status.cleared_balance)) / 100;

  return (
    <>
      <div className="report-filters">
        <label>Statement date<input type="date" value={asOf} onChange={(e) => e.target.value && setAsOf(e.target.value)} /></label>
        <label>Statement ending balance<input type="number" step="0.01" value={balance} onChange={(e) => setBalance(e.target.value)} /></label>
      </div>

      {status.last_reconciled && <p className="muted">Last reconciled to {formatDate(status.last_reconciled)}</p>}
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="stats">
        <div className="card"><div className="stat-label">Book balance</div><div className="stat-value">{money(status.book_balance)}</div></div>
        <div className="card"><div className="stat-label">Cleared</div><div className="stat-value">{money(status.cleared_balance)}</div></div>
        <div className="card"><div className="stat-label">Difference</div><div className="stat-value">{balance === '' ? '—' : money(difference)}</div></div>
      </div>

      <div className="form-actions">
        <button className="primary" disabled={balance === '' || difference !== 0} onClick={finish}>Finish reconciliation</button>
      </div>

      <div className="card table-wrap">
        <h2>Not cleared yet</h2>
        <table>
          <thead><tr><th>#</th><th>Date</th><th>Description</th><th className="num">Amount</th><th /></tr></thead>
          <tbody>
            {status.uncleared.length === 0 && <tr><td colSpan={5} className="empty">Everything has cleared</td></tr>}
            {status.uncleared.map((item: any) => (
              <tr key={item.id}>
                <td>{item.entry_number}</td>
                <td>{formatDate(item.entry_date)}</td>
                <td className="wrap">{item.memo}</td>
                <td className="num">{money(item.amount)}</td>
                <td className="num"><button onClick={() => run(() => api.post('/api/accounting/bank/clear', { journal_line_id: item.id }))}>Clear</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card table-wrap">
        <h2>Cleared</h2>
        <table>
          <thead><tr><th>#</th><th>Date</th><th>Description</th><th className="num">Amount</th><th /></tr></thead>
          <tbody>
            {status.cleared.length === 0 && <tr><td colSpan={5} className="empty">Nothing cleared since the last reconciliation</td></tr>}
            {status.cleared.map((item: any) => (
              <tr key={item.bank_line_id}>
                <td>{item.entry_number}</td>
                <td>{formatDate(item.entry_date)}</td>
                <td className="wrap">{item.memo}</td>
                <td className="num">{money(item.amount)}</td>
                <td className="num"><button onClick={() => unclear(item)}>Unclear</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
