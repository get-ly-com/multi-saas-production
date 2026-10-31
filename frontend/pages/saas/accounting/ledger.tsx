import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import AccountingNav from '@/components/AccountingNav';
import AppShell from '@/components/AppShell';
import { api, formatDate, money } from '@/lib/api';

export default function Ledger() {
  return <AppShell><LedgerApp /></AppShell>;
}

function LedgerApp() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<any[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const accountId = (router.query.account as string) || '';

  useEffect(() => {
    api.get('/api/accounting/accounts').then(setAccounts).catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!accountId) return;
    setLoading(true);
    api.get(`/api/accounting/ledger/${accountId}`)
      .then((data) => {
        setRows(data);
        setError('');
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [accountId]);

  const chooseAccount = (id: string) =>
    router.replace({ pathname: router.pathname, query: id ? { account: id } : {} });

  return (
    <div className="stack">
      <AccountingNav />
      <div className="page-head"><h1>General ledger</h1></div>

      <label>Account
        <select value={accountId} onChange={(e) => chooseAccount(e.target.value)}>
          <option value="">Choose an account</option>
          {accounts.map((account) => <option key={account.id} value={account.id}>{account.code} {account.name}</option>)}
        </select>
      </label>

      {error && <p className="error">{error}</p>}

      {accountId && (
        <div className="card table-wrap">
          {loading ? <p className="empty">Loading…</p> : (
            <table>
              <thead>
                <tr><th>#</th><th>Date</th><th>Description</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={6} className="empty">No activity on this account</td></tr>}
                {rows.map((row, index) => (
                  <tr key={`${row.entry_id}-${index}`}>
                    <td>{row.entry_number}</td>
                    <td>{formatDate(row.entry_date)}</td>
                    <td className="wrap">{row.memo}</td>
                    <td className="num">{Number(row.debit) ? money(row.debit) : ''}</td>
                    <td className="num">{Number(row.credit) ? money(row.credit) : ''}</td>
                    <td className="num">{money(row.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
