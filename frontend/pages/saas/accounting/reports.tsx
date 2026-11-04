import { useEffect, useState } from 'react';
import {
  PageHead, Statement, StatementEmpty, StatementHeading, StatementLine, StatementSpacer, StatementTotal, StatusPill, styles
} from '@/components/AccountingKit';
import AccountingNav from '@/components/AccountingNav';
import AppShell from '@/components/AppShell';
import Skeleton from '@/components/Skeleton';
import { api, formatDate, today } from '@/lib/api';

const REPORTS = [
  { id: 'profit-and-loss', name: 'Profit and loss', dates: 'range' },
  { id: 'balance-sheet', name: 'Balance sheet', dates: 'single' },
  { id: 'cash-flow', name: 'Cash flow', dates: 'range' },
  { id: 'aged/receivable', name: 'Aged receivables', dates: 'none' },
  { id: 'aged/payable', name: 'Aged payables', dates: 'none' },
  { id: 'tax', name: 'Tax summary', dates: 'range' },
  { id: 'cost-centers', name: 'By cost center', dates: 'range' }
];

export default function Reports() {
  return <AppShell><ReportsApp /></AppShell>;
}

function ReportsApp() {
  const [reportId, setReportId] = useState(REPORTS[0].id);
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today());
  const [asOf, setAsOf] = useState(today());
  const [company, setCompany] = useState('');
  const [basis, setBasis] = useState<'accrual' | 'cash'>('accrual');
  const [loaded, setLoaded] = useState<{ path: string; data: any } | null>(null);
  const [error, setError] = useState('');

  const report = REPORTS.find(({ id }) => id === reportId)!;
  const query = report.dates === 'range' ? `?from=${from}&to=${to}` : report.dates === 'single' ? `?as_of=${asOf}` : '';
  const cashBasis = reportId === 'profit-and-loss' && basis === 'cash';
  const path = `/api/accounting/reports/${reportId}${query}${cashBasis ? '&basis=cash' : ''}`;
  // Each report has its own shape, so only draw data fetched for the one on screen
  const data = loaded?.path === path ? loaded.data : null;

  useEffect(() => {
    api.get('/api/me').then((me) => setCompany(me.tenant.name)).catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    let current = true;
    api.get(path)
      .then((result) => {
        if (current) {
          setLoaded({ path, data: result });
          setError('');
        }
      })
      .catch((err) => current && setError(err.message));
    return () => {
      current = false;
    };
  }, [path]);

  const period = report.dates === 'range'
    ? `${formatDate(from)} to ${formatDate(to)}`
    : report.dates === 'single' ? `As of ${formatDate(asOf)}` : `As of ${formatDate(today())}`;

  return (
    <div className="stack">
      <AccountingNav />
      <PageHead className="no-print" title="Reports" line="Your financial statements, ready to print or share with your accountant.">
        <button className="primary always" onClick={() => window.print()}>Print or save as PDF</button>
      </PageHead>

      <div className="tabs no-print">
        {REPORTS.map(({ id, name }) => (
          <button key={id} className={id === reportId ? 'active' : ''} onClick={() => setReportId(id)}>{name}</button>
        ))}
      </div>

      {report.dates !== 'none' && (
        <div className="report-filters no-print">
          {report.dates === 'range' ? (
            <>
              <label>From<input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
              <label>To<input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
            </>
          ) : (
            <label>As of<input type="date" value={asOf} onChange={(e) => e.target.value && setAsOf(e.target.value)} /></label>
          )}
          {reportId === 'profit-and-loss' && (
            <label>Basis
              <select value={basis} onChange={(e) => setBasis(e.target.value as 'accrual' | 'cash')}>
                <option value="accrual">Accrual (when invoiced and billed)</option>
                <option value="cash">Cash (when paid)</option>
              </select>
            </label>
          )}
        </div>
      )}

      {error && <p className="error">{error}</p>}

      <div className="card table-wrap">
        <div className={styles.statementHead}>
          <div>
            <h2>{company ? `${company} · ` : ''}{report.name}{cashBasis && ' (cash basis)'}</h2>
            <p className="muted">{period}</p>
          </div>
          {reportId === 'balance-sheet' && data && (
            <StatusPill status={data.balanced ? 'paid' : 'overdue'} label={data.balanced ? 'In balance' : 'Out of balance'} />
          )}
        </div>
        {cashBasis && <p className="muted">Sales and bills count when they are paid, in proportion to what was paid. Write-offs and credit notes move no money, so they are left out. Other entries, such as depreciation, count on their date.</p>}
        {!data ? (
          <div role="status" aria-label="Loading report" style={{ display: 'grid', gap: 10, paddingTop: 8 }}>
            {[42, 70, 64, 76, 50, 68, 58].map((width, index) => (
              <div key={index} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, paddingLeft: index % 3 === 0 ? 0 : 28 }}>
                <Skeleton width={`${width}%`} height={index % 3 === 0 ? 11 : 13} />
                <Skeleton width={90} height={13} />
              </div>
            ))}
          </div>
        ) : (
          <>
            {reportId === 'profit-and-loss' && <ProfitAndLoss data={data} />}
            {reportId === 'balance-sheet' && <BalanceSheet data={data} />}
            {reportId === 'cash-flow' && <CashFlow data={data} />}
            {reportId.startsWith('aged') && <Aged data={data} payable={reportId === 'aged/payable'} />}
            {reportId === 'tax' && <TaxSummary data={data} />}
            {reportId === 'cost-centers' && <ByCostCenter rows={data} />}
          </>
        )}
      </div>
    </div>
  );
}

const ledgerLink = (row: any) => (row.account_id ? `/saas/accounting/ledger?account=${row.account_id}` : undefined);

function AccountRows({ rows, empty }: { rows: any[]; empty?: string }) {
  if (!rows.length) return <StatementEmpty text={empty || 'Nothing in this period'} />;
  return (
    <>
      {rows.map((row) => (
        <StatementLine key={row.code || row.name} code={row.account_id ? row.code : undefined} label={row.name} href={ledgerLink(row)} values={[row.amount]} />
      ))}
    </>
  );
}

// Matches the accounts the database counts in gross profit
const COST_OF_SALES = ['5000', '5100'];

function ProfitAndLoss({ data }: { data: any }) {
  const hasCostOfSales = Number(data.cost_of_sales) !== 0;
  return (
    <Statement columns={['', 'Amount']}>
      <StatementHeading title="Revenue" />
      <AccountRows rows={data.revenue} empty="No revenue in this period" />
      <StatementTotal label="Total revenue" values={[data.total_revenue]} />
      {hasCostOfSales && (
        <>
          <StatementHeading title="Cost of sales" />
          <AccountRows rows={data.expenses.filter(({ code }: any) => COST_OF_SALES.includes(code))} />
          <StatementTotal label="Gross profit" values={[data.gross_profit]} />
        </>
      )}
      <StatementHeading title="Expenses" />
      <AccountRows rows={hasCostOfSales ? data.expenses.filter(({ code }: any) => !COST_OF_SALES.includes(code)) : data.expenses} empty="No expenses in this period" />
      <StatementTotal label="Total expenses" values={[data.total_expenses]} />
      <StatementSpacer />
      <StatementTotal grand label={Number(data.net_income) < 0 ? 'Net loss' : 'Net income'} values={[data.net_income]} />
    </Statement>
  );
}

function BalanceSheet({ data }: { data: any }) {
  return (
    <Statement columns={['', 'Amount']}>
      <StatementHeading title="Assets" />
      <AccountRows rows={data.assets} empty="No assets" />
      <StatementTotal grand label="Total assets" values={[data.total_assets]} />
      <StatementSpacer />
      <StatementHeading title="Liabilities" />
      <AccountRows rows={data.liabilities} empty="No liabilities" />
      <StatementTotal label="Total liabilities" values={[data.total_liabilities]} />
      <StatementHeading title="Equity" />
      <AccountRows rows={data.equity} empty="No equity accounts" />
      <StatementLine label="Earnings to date" values={[data.earnings]} />
      <StatementTotal label="Total equity" values={[data.total_equity]} />
      <StatementSpacer />
      <StatementTotal grand label="Total liabilities and equity" values={[Number(data.total_liabilities) + Number(data.total_equity)]} />
    </Statement>
  );
}

function CashFlow({ data }: { data: any }) {
  return (
    <Statement columns={['', 'Amount']}>
      <StatementHeading title="Operating activities" />
      <AccountRows rows={data.operating} empty="No operating cash movements" />
      <StatementTotal label="Cash from operations" values={[data.total_operating]} />
      <StatementHeading title="Investing activities" />
      <AccountRows rows={data.investing} empty="No investing cash movements" />
      <StatementTotal label="Cash from investing" values={[data.total_investing]} />
      <StatementHeading title="Financing activities" />
      <AccountRows rows={data.financing} empty="No financing cash movements" />
      <StatementTotal label="Cash from financing" values={[data.total_financing]} />
      <StatementHeading title="Cash" />
      <StatementLine label="Opening cash" values={[data.opening]} />
      <StatementLine label="Net change" values={[data.net_change]} />
      <StatementSpacer />
      <StatementTotal grand label="Closing cash" values={[data.closing]} />
    </Statement>
  );
}

function ByCostCenter({ rows }: { rows: any[] }) {
  const sum = (field: string) => rows.reduce((total, row) => total + Number(row[field] || 0), 0);
  return (
    <Statement columns={['Cost center', 'Revenue', 'Expenses', 'Net']}>
      {rows.length === 0 && <StatementEmpty text="No activity in this period" span={4} />}
      {rows.map((row) => (
        <StatementLine key={row.code} code={row.code} label={row.name} values={[row.revenue, row.expenses, row.net]} />
      ))}
      {rows.length > 0 && <StatementTotal grand label="Total" values={[sum('revenue'), sum('expenses'), sum('net')]} />}
    </Statement>
  );
}

function TaxSummary({ data }: { data: any }) {
  return (
    <Statement columns={['', 'Amount']}>
      <StatementHeading title="This period" />
      <StatementLine label="Tax collected on sales" values={[data.collected]} />
      <StatementLine label="Tax paid on purchases" values={[data.on_purchases]} />
      <StatementTotal label="Net tax for the period" values={[data.net]} />
      <StatementHeading title="Payments" />
      <StatementLine label="Paid to the tax office in the period" values={[data.paid]} />
      <StatementSpacer />
      <StatementTotal grand label="Tax owed at the end of the period" values={[data.balance]} />
    </Statement>
  );
}

function Aged({ data, payable }: { data: any; payable: boolean }) {
  const values = (row: any) => [row.not_due, row.days_1_30, row.days_31_60, row.days_61_90, row.days_over_90, row.total];

  return (
    <Statement columns={[payable ? 'Vendor' : 'Customer', 'Not due', '1 to 30 days', '31 to 60 days', '61 to 90 days', 'Over 90 days', 'Total']}>
      {data.rows.length === 0 && <StatementEmpty text={payable ? 'You owe nothing right now' : 'Nobody owes you anything right now'} span={7} />}
      {data.rows.map((row: any) => <StatementLine key={row.party_id} label={row.name} values={values(row)} blankZero />)}
      {data.rows.length > 0 && <StatementTotal grand label="Total" values={values(data.totals)} />}
    </Statement>
  );
}
