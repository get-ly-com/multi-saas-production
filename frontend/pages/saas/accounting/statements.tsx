import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { Amount, PageHead, styles } from '@/components/AccountingKit';
import AccountingNav from '@/components/AccountingNav';
import AppShell from '@/components/AppShell';
import EmptyState from '@/components/EmptyState';
import Skeleton, { SkeletonText } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api, formatDate, money, today, isUuid } from '@/lib/api';

const KIND_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  payment: 'Payment',
  credit_note: 'Credit note',
  write_off: 'Write-off'
};

const AGEING = [
  ['not_due', 'Not due'],
  ['days_1_30', '1 to 30 days'],
  ['days_31_60', '31 to 60 days'],
  ['days_61_90', '61 to 90 days'],
  ['days_over_90', 'Over 90 days']
];

const monthsAgo = (months: number) => {
  const date = new Date(`${today()}T00:00:00`);
  date.setMonth(date.getMonth() - months);
  date.setDate(1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
};

export default function Statements() {
  return <AppShell><StatementsApp /></AppShell>;
}

function StatementsApp() {
  const router = useRouter();
  const [customers, setCustomers] = useState<any[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [from, setFrom] = useState(monthsAgo(3));
  const [to, setTo] = useState(today());
  const [company, setCompany] = useState('');
  const [statement, setStatement] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/accounting/customers').then(setCustomers).catch((err) => setError(err.message));
    api.get('/api/me').then((me) => setCompany(me.tenant.name)).catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (isUuid(router.query.customer)) setCustomerId(router.query.customer);
  }, [router.query.customer]);

  useEffect(() => {
    if (!customerId) {
      setStatement(null);
      return;
    }
    let current = true;
    api.get(`/api/accounting/customers/${customerId}/statement?from=${from}&to=${to}`)
      .then((data) => {
        if (current) {
          setStatement(data);
          setError('');
        }
      })
      .catch((err) => current && setError(err.message));
    return () => {
      current = false;
    };
  }, [customerId, from, to]);

  const currency = statement?.currency;

  // A plain-text version to paste into an email or message
  const copyText = async () => {
    if (!statement) return;
    const lines = [
      `Statement of account from ${company}`,
      `For ${statement.customer.name}, ${formatDate(statement.from)} to ${formatDate(statement.to)}`,
      '',
      `Opening balance: ${money(statement.opening, currency)}`,
      ...statement.lines.map((line: any) =>
        `${formatDate(line.date)}  ${KIND_LABELS[line.kind]} ${line.reference}  ${line.charge > 0 ? money(line.charge, currency) : `-${money(line.credit, currency)}`}  balance ${money(line.balance, currency)}`),
      `Closing balance: ${money(statement.closing, currency)}`,
      ''
    ];
    if (statement.open_invoices.length) {
      lines.push('Still open:');
      statement.open_invoices.forEach((invoice: any) => lines.push(
        `${invoice.invoice_number}  due ${formatDate(invoice.due_date || invoice.invoice_date)}  ${money(invoice.open, currency)}${invoice.days_overdue > 0 ? ` (${invoice.days_overdue} days overdue)` : ''}`
      ));
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast.success('Statement copied', { detail: `Paste it into an email or message to ${statement.customer.name}.` });
    } catch {
      setError('Your browser did not allow copying. Use Print or save as PDF instead.');
    }
  };

  const mailto = statement?.customer.email
    ? `mailto:${encodeURIComponent(statement.customer.email)}?subject=${encodeURIComponent(`Statement of account from ${company}`)}`
    : '';

  return (
    <div className="stack">
      <AccountingNav />
      <PageHead
        className="no-print"
        title="Customer statements"
        line="Everything a customer was invoiced and paid in a period, and what they still owe. Amounts are in your main currency."
      >
        {mailto && <a href={mailto} className="button">Open in email app</a>}
        {statement && <button className="always" onClick={copyText}>Copy as text</button>}
        {statement && <button className="primary always" onClick={() => window.print()}>Print or save as PDF</button>}
      </PageHead>

      <div className="report-filters no-print">
        <label>Customer
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">Choose a customer</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>{customer.name}{Number(customer.balance) ? ` (${money(customer.balance)})` : ''}</option>
            ))}
          </select>
        </label>
        <label>From<input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <label>To<input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
      </div>

      {error && <p className="error no-print">{error}</p>}

      {!customerId && (
        <div className="card">
          <EmptyState
            icon="contact"
            title="Choose a customer"
            line={customers.length ? 'Pick someone above to see their statement, ready to print or copy into an email.' : 'Add a customer first. Their statement fills in as you invoice them.'}
            action={customers.length ? undefined : { label: 'Add a customer', href: '/saas/accounting/customers?new=1' }}
          />
        </div>
      )}

      {customerId && !statement && !error && (
        <div className="card document" role="status" aria-label="Loading statement">
          <div className="document-head">
            <div style={{ display: 'grid', gap: 8 }}><Skeleton width={200} height={24} /><Skeleton width={130} height={12} /></div>
            <div style={{ display: 'grid', gap: 8, justifyItems: 'end' }}><Skeleton width={170} height={12} /><Skeleton width={100} height={12} /></div>
          </div>
          <SkeletonText lines={6} />
        </div>
      )}

      {statement && (
        <div className="card document">
          <div className="document-head">
            <div>
              <h1>{company}</h1>
              <p className="muted">Statement of account</p>
            </div>
            <div className="document-meta">
              <div>{formatDate(statement.from)} to {formatDate(statement.to)}</div>
              <div>Amounts in {currency}</div>
            </div>
          </div>

          <div>
            <div className="muted">For</div>
            <div>{statement.customer.name}</div>
            {statement.customer.address && <div className="wrap">{statement.customer.address}</div>}
            {statement.customer.email && <div>{statement.customer.email}</div>}
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Date</th><th>Item</th><th>Details</th><th className="num">Charges</th><th className="num">Payments and credits</th><th className="num">Balance</th></tr>
              </thead>
              <tbody>
                <tr><td>{formatDate(statement.from)}</td><td colSpan={4}><strong>Opening balance</strong></td><td className="num"><Amount value={statement.opening} currency={currency} strong /></td></tr>
                {statement.lines.length === 0 && <tr><td colSpan={6} className="empty">Nothing happened in this period</td></tr>}
                {statement.lines.map((line: any, index: number) => (
                  <tr key={`${line.kind}-${line.reference}-${index}`}>
                    <td>{formatDate(line.date)}</td>
                    <td>
                      {KIND_LABELS[line.kind]}{' '}
                      {line.invoice_id && line.kind === 'invoice'
                        ? <Link href={`/saas/accounting/invoice/${line.invoice_id}`}>{line.reference}</Link>
                        : line.reference}
                    </td>
                    <td className="wrap">{line.description}{line.due_date && <span className="muted"> · due {formatDate(line.due_date)}</span>}</td>
                    <td className="num"><Amount value={line.charge} currency={currency} blankZero /></td>
                    <td className="num"><Amount value={line.credit} currency={currency} blankZero /></td>
                    <td className="num"><Amount value={line.balance} currency={currency} /></td>
                  </tr>
                ))}
                <tr className={styles.totalRow}><td colSpan={5}>Balance due on {formatDate(statement.to)}</td><td className="num"><Amount value={statement.closing} currency={currency} strong /></td></tr>
              </tbody>
            </table>
          </div>

          <div className="stats">
            {AGEING.map(([key, label]) => (
              <div key={key}><div className="stat-label">{label}</div><div className="stat-value"><Amount value={statement.ageing[key]} currency={currency} dim={!Number(statement.ageing[key])} /></div></div>
            ))}
          </div>

          {statement.open_invoices.length > 0 && (
            <div className="table-wrap">
              <h2>Still open on {formatDate(statement.to)}</h2>
              <table>
                <thead><tr><th>Invoice</th><th>Date</th><th>Due</th><th className="num">Total</th><th className="num">Still owed</th><th className="num">Days overdue</th></tr></thead>
                <tbody>
                  {statement.open_invoices.map((invoice: any) => (
                    <tr key={invoice.id}>
                      <td><Link href={`/saas/accounting/invoice/${invoice.id}`}>{invoice.invoice_number}</Link></td>
                      <td>{formatDate(invoice.invoice_date)}</td>
                      <td>{formatDate(invoice.due_date)}</td>
                      <td className="num"><Amount value={invoice.amount} currency={currency} /></td>
                      <td className="num"><Amount value={invoice.open} currency={currency} strong={invoice.days_overdue > 0} /></td>
                      <td className="num">{invoice.days_overdue > 0 ? <span style={{ color: 'var(--danger)' }}>{invoice.days_overdue}</span> : <span className="muted">Not yet</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
