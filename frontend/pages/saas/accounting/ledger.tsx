import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import AccountingNav from '@/components/AccountingNav';
import { Amount, PageHead, styles } from '@/components/AccountingKit';
import AppShell from '@/components/AppShell';
import EmptyState from '@/components/EmptyState';
import { SkeletonTable } from '@/components/Skeleton';
import { api, formatDate, isUuid } from '@/lib/api';

const cents = (value: unknown) => Math.round(Number(value || 0) * 100);

export default function Ledger() {
  return <AppShell><LedgerApp /></AppShell>;
}

function LedgerApp() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<any[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const accountId = isUuid(router.query.account) ? router.query.account : '';

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
      <PageHead title="General ledger" line="Every line posted to one account, with the running balance." />

      <div className="report-filters">
        <label style={{ width: 320 }}>Account
          <select value={accountId} onChange={(e) => chooseAccount(e.target.value)}>
            <option value="">Choose an account</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.code} {account.name}</option>)}
          </select>
        </label>
      </div>

      {error && <p className="error">{error}</p>}

      {!accountId && (
        <div className="card">
          <EmptyState icon="search" title="Choose an account" line="Pick one above to see everything posted to it." />
        </div>
      )}

      {accountId && (loading ? <SkeletonTable rows={8} columns={6} /> : (
        <div className="card table-wrap">
          {rows.length === 0 ? (
            <EmptyState compact icon="accounting" title="No activity on this account" line="Lines show up here as soon as something posts to it." />
          ) : (
            <table>
              <thead>
                <tr><th>#</th><th>Date</th><th>Description</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={`${row.entry_id}-${index}`}>
                    <td>{row.entry_number}</td>
                    <td>{formatDate(row.entry_date)}</td>
                    <td className="wrap">{row.memo}</td>
                    <td className="num"><Amount value={row.debit} blankZero /></td>
                    <td className="num"><Amount value={row.credit} blankZero /></td>
                    <td className="num"><Amount value={row.balance} /></td>
                  </tr>
                ))}
                <tr className={styles.totalRow}>
                  <td colSpan={3}>Closing balance</td>
                  <td className="num"><Amount value={rows.reduce((sum, row) => sum + cents(row.debit), 0) / 100} /></td>
                  <td className="num"><Amount value={rows.reduce((sum, row) => sum + cents(row.credit), 0) / 100} /></td>
                  <td className="num"><Amount value={rows[rows.length - 1].balance} strong /></td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}
