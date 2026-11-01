import Link from 'next/link';
import { useEffect, useState } from 'react';
import AccountingNav from '@/components/AccountingNav';
import AppShell from '@/components/AppShell';
import { api, formatDate, money, today } from '@/lib/api';

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
  const [loaded, setLoaded] = useState<{ path: string; data: any } | null>(null);
  const [error, setError] = useState('');

  const report = REPORTS.find(({ id }) => id === reportId)!;
  const query = report.dates === 'range' ? `?from=${from}&to=${to}` : report.dates === 'single' ? `?as_of=${asOf}` : '';
  const path = `/api/accounting/reports/${reportId}${query}`;
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
      <div className="page-head no-print">
        <h1>Reports</h1>
        <button className="primary always" onClick={() => window.print()}>Print or save as PDF</button>
      </div>

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
        </div>
      )}

      {error && <p className="error">{error}</p>}

      <div className="card table-wrap">
        <h2>{company} · {report.name}</h2>
        <p className="muted">{period}</p>
        {!data ? <p className="empty">Loading…</p> : (
          <>
            {reportId === 'profit-and-loss' && <ProfitAndLoss data={data} />}
            {reportId === 'balance-sheet' && <BalanceSheet data={data} />}
            {reportId === 'cash-flow' && <CashFlow data={data} />}
            {reportId.startsWith('aged') && <Aged data={data} />}
            {reportId === 'tax' && <TaxSummary data={data} />}
            {reportId === 'cost-centers' && <ByCostCenter rows={data} />}
          </>
        )}
      </div>
    </div>
  );
}

function AccountRows({ rows }: { rows: any[] }) {
  return (
    <>
      {rows.map((row) => (
        <tr key={row.code}>
          <td className="wrap">
            {row.account_id
              ? <Link href={`/saas/accounting/ledger?account=${row.account_id}`}>{row.code} {row.name}</Link>
              : row.name}
          </td>
          <td className="num">{money(row.amount)}</td>
        </tr>
      ))}
    </>
  );
}

const Section = ({ title }: { title: string }) => <tr className="section"><td colSpan={2}>{title}</td></tr>;

const Total = ({ label, value }: { label: string; value: number }) => (
  <tr className="total"><td>{label}</td><td className="num">{money(value)}</td></tr>
);

function ProfitAndLoss({ data }: { data: any }) {
  return (
    <table>
      <tbody>
        <Section title="Revenue" />
        <AccountRows rows={data.revenue} />
        <Total label="Total revenue" value={data.total_revenue} />
        <Section title="Expenses" />
        <AccountRows rows={data.expenses} />
        <Total label="Total expenses" value={data.total_expenses} />
        <Total label="Net income" value={data.net_income} />
      </tbody>
    </table>
  );
}

function BalanceSheet({ data }: { data: any }) {
  return (
    <>
      <span className={`badge ${data.balanced ? 'paid' : 'void'}`}>{data.balanced ? 'In balance' : 'Out of balance'}</span>
      <table>
        <tbody>
          <Section title="Assets" />
          <AccountRows rows={data.assets} />
          <Total label="Total assets" value={data.total_assets} />
          <Section title="Liabilities" />
          <AccountRows rows={data.liabilities} />
          <Total label="Total liabilities" value={data.total_liabilities} />
          <Section title="Equity" />
          <AccountRows rows={data.equity} />
          <tr><td>Earnings to date</td><td className="num">{money(data.earnings)}</td></tr>
          <Total label="Total equity" value={data.total_equity} />
          <Total label="Total liabilities and equity" value={Number(data.total_liabilities) + Number(data.total_equity)} />
        </tbody>
      </table>
    </>
  );
}

function CashFlow({ data }: { data: any }) {
  return (
    <table>
      <tbody>
        <Section title="Operating activities" />
        <AccountRows rows={data.operating} />
        <Total label="Cash from operations" value={data.total_operating} />
        <Section title="Investing activities" />
        <AccountRows rows={data.investing} />
        <Total label="Cash from investing" value={data.total_investing} />
        <Section title="Financing activities" />
        <AccountRows rows={data.financing} />
        <Total label="Cash from financing" value={data.total_financing} />
        <Section title="Cash" />
        <tr><td>Opening cash</td><td className="num">{money(data.opening)}</td></tr>
        <tr><td>Net change</td><td className="num">{money(data.net_change)}</td></tr>
        <Total label="Closing cash" value={data.closing} />
      </tbody>
    </table>
  );
}

function ByCostCenter({ rows }: { rows: any[] }) {
  return (
    <table>
      <thead><tr><th>Cost center</th><th className="num">Revenue</th><th className="num">Expenses</th><th className="num">Net</th></tr></thead>
      <tbody>
        {rows.length === 0 && <tr><td colSpan={4} className="empty">No activity in this period</td></tr>}
        {rows.map((row) => (
          <tr key={row.code}>
            <td className="wrap">{row.code} {row.name}</td>
            <td className="num">{money(row.revenue)}</td>
            <td className="num">{money(row.expenses)}</td>
            <td className="num">{money(row.net)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TaxSummary({ data }: { data: any }) {
  return (
    <table>
      <tbody>
        <tr><td>Tax collected on sales</td><td className="num">{money(data.collected)}</td></tr>
        <tr><td>Tax paid on purchases</td><td className="num">{money(data.on_purchases)}</td></tr>
        <Total label="Net tax for the period" value={data.net} />
        <tr><td>Paid to the tax office in the period</td><td className="num">{money(data.paid)}</td></tr>
        <Total label="Tax owed at the end of the period" value={data.balance} />
      </tbody>
    </table>
  );
}

function Aged({ data }: { data: any }) {
  const cells = (row: any) => (
    <>
      <td className="num">{money(row.not_due)}</td>
      <td className="num">{money(row.days_1_30)}</td>
      <td className="num">{money(row.days_31_60)}</td>
      <td className="num">{money(row.days_61_90)}</td>
      <td className="num">{money(row.days_over_90)}</td>
      <td className="num">{money(row.total)}</td>
    </>
  );

  return (
    <table>
      <thead>
        <tr>
          <th>Name</th><th className="num">Not due</th><th className="num">1–30 days</th><th className="num">31–60 days</th>
          <th className="num">61–90 days</th><th className="num">Over 90 days</th><th className="num">Total</th>
        </tr>
      </thead>
      <tbody>
        {data.rows.length === 0 && <tr><td colSpan={7} className="empty">Nothing outstanding</td></tr>}
        {data.rows.map((row: any) => <tr key={row.party_id}><td className="wrap">{row.name}</td>{cells(row)}</tr>)}
        <tr className="total"><td>Total</td>{cells(data.totals)}</tr>
      </tbody>
    </table>
  );
}
