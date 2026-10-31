import Link from 'next/link';
import { useEffect, useState } from 'react';
import AccountingNav from '@/components/AccountingNav';
import AppShell from '@/components/AppShell';
import { api, money } from '@/lib/api';

export default function TrialBalance() {
  return <AppShell><TrialBalanceApp /></AppShell>;
}

function TrialBalanceApp() {
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/api/accounting/trial-balance?as_of=${asOf}`)
      .then((data) => {
        setRows(data.rows);
        setError('');
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [asOf]);

  // Each account shows on one side, by its net balance
  const balances = rows.map((row) => {
    const net = Number(row.debit) - Number(row.credit);
    return { ...row, debitBalance: net > 0 ? net : 0, creditBalance: net < 0 ? -net : 0 };
  });
  const totalOf = (field: 'debitBalance' | 'creditBalance') =>
    balances.reduce((sum, row) => sum + Math.round(row[field] * 100), 0) / 100;
  const balanced = totalOf('debitBalance') === totalOf('creditBalance');

  return (
    <div className="stack">
      <AccountingNav />
      <div className="page-head">
        <h1>Trial balance</h1>
        {!loading && !error && (
          <span className={`badge ${balanced ? 'paid' : 'void'}`}>{balanced ? 'In balance' : 'Out of balance'}</span>
        )}
      </div>

      <label>As of<input type="date" value={asOf} onChange={(e) => e.target.value && setAsOf(e.target.value)} /></label>

      {error && <p className="error">{error}</p>}

      <div className="card table-wrap">
        {loading ? <p className="empty">Loading…</p> : (
          <table>
            <thead><tr><th>Code</th><th>Account</th><th>Type</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
            <tbody>
              {balances.map((row) => (
                <tr key={row.account_id}>
                  <td>{row.code}</td>
                  <td className="wrap"><Link href={`/saas/accounting/ledger?account=${row.account_id}`}>{row.name}</Link></td>
                  <td>{row.type}</td>
                  <td className="num">{row.debitBalance ? money(row.debitBalance) : ''}</td>
                  <td className="num">{row.creditBalance ? money(row.creditBalance) : ''}</td>
                </tr>
              ))}
              <tr className="total">
                <td colSpan={3}>Total</td>
                <td className="num">{money(totalOf('debitBalance'))}</td>
                <td className="num">{money(totalOf('creditBalance'))}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
