import { useEffect, useState } from 'react';
import {
  PageHead, Statement, StatementEmpty, StatementHeading, StatementLine, StatementSpacer, StatementTotal, StatusPill, styles
} from '@/components/AccountingKit';
import AccountingNav from '@/components/AccountingNav';
import AppShell from '@/components/AppShell';
import { SkeletonTable } from '@/components/Skeleton';
import { api, formatDate, today } from '@/lib/api';

// The order a trial balance is read in, with plain names for each group
const GROUPS = [
  ['asset', 'Assets'],
  ['liability', 'Liabilities'],
  ['equity', 'Equity'],
  ['revenue', 'Revenue'],
  ['expense', 'Expenses']
];

const cents = (value: number) => Math.round(value * 100);

export default function TrialBalance() {
  return <AppShell><TrialBalanceApp /></AppShell>;
}

function TrialBalanceApp() {
  const [asOf, setAsOf] = useState(today);
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
  const totalOf = (list: any[], field: 'debitBalance' | 'creditBalance') =>
    list.reduce((sum, row) => sum + cents(row[field]), 0) / 100;
  const balanced = totalOf(balances, 'debitBalance') === totalOf(balances, 'creditBalance');

  const known = GROUPS.map(([type]) => type);
  const groups = [
    ...GROUPS.map(([type, name]) => ({ name, rows: balances.filter((row) => row.type === type) })),
    { name: 'Other', rows: balances.filter((row) => !known.includes(row.type)) }
  ].filter((group) => group.rows.length > 0);

  return (
    <div className="stack">
      <AccountingNav />
      <PageHead title="Trial balance" line="Every account's balance on one date. Debits and credits should come out equal.">
        {!loading && !error && rows.length > 0 && (
          <StatusPill status={balanced ? 'paid' : 'overdue'} label={balanced ? 'In balance' : 'Out of balance'} />
        )}
      </PageHead>

      <div className="report-filters">
        <label>As of<input type="date" value={asOf} onChange={(e) => e.target.value && setAsOf(e.target.value)} /></label>
      </div>

      {error && <p className="error">{error}</p>}

      {loading ? <SkeletonTable rows={10} columns={3} /> : (
        <div className="card table-wrap">
          <div className={styles.statementHead}>
            <div>
              <h2>Trial balance</h2>
              <p className="muted">As of {formatDate(asOf)}</p>
            </div>
          </div>
          <Statement columns={['Account', 'Debit', 'Credit']}>
            {groups.length === 0 && <StatementEmpty text="Nothing has been posted yet" span={3} />}
            {groups.map((group) => (
              <TrialGroup key={group.name} name={group.name} rows={group.rows} debit={totalOf(group.rows, 'debitBalance')} credit={totalOf(group.rows, 'creditBalance')} />
            ))}
            <StatementSpacer span={3} />
            <StatementTotal grand label="Total" values={[totalOf(balances, 'debitBalance'), totalOf(balances, 'creditBalance')]} />
          </Statement>
          {!balanced && (
            <p className="error" style={{ marginTop: 12 }}>
              Debits and credits differ by {Math.abs(totalOf(balances, 'debitBalance') - totalOf(balances, 'creditBalance')).toFixed(2)}. Check the journal for an entry that does not balance.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function TrialGroup({ name, rows, debit, credit }: { name: string; rows: any[]; debit: number; credit: number }) {
  return (
    <>
      <StatementHeading title={name} span={3} />
      {rows.map((row) => (
        <StatementLine
          key={row.account_id}
          code={row.code}
          label={row.name}
          href={`/saas/accounting/ledger?account=${row.account_id}`}
          values={[row.debitBalance, row.creditBalance]}
          blankZero
        />
      ))}
      <StatementTotal label={`Total ${name.toLowerCase()}`} values={[debit, credit]} />
    </>
  );
}
