import Link from 'next/link';
import { useRouter } from 'next/router';
import { FormEvent, useEffect, useState } from 'react';
import { Amount, StatusPill, shownStatus, styles } from '@/components/AccountingKit';
import AppShell from '@/components/AppShell';
import Modal from '@/components/Modal';
import PaymentLinkModal, { payLinkUrl } from '@/components/PaymentLinkModal';
import Skeleton, { SkeletonText } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import WriteOffForm from '@/components/WriteOffForm';
import { api, formatDate, money, today, queryId } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

export default function Invoice() {
  return <AppShell><InvoiceDocument /></AppShell>;
}

function InvoiceDocument() {
  const router = useRouter();
  const id = queryId(router.query.id);
  const [invoice, setInvoice] = useState<any>(null);
  const [company, setCompany] = useState('');
  const [error, setError] = useState('');
  const [refunding, setRefunding] = useState(false);
  const [writingOff, setWritingOff] = useState(false);
  const [linking, setLinking] = useState(false);

  const load = async () => {
    try {
      setInvoice(await api.get(`/api/accounting/invoices/${id}`));
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    if (!id) return;
    load();
    api.get('/api/me').then((me) => setCompany(me.tenant.name)).catch((err) => setError(err.message));
  }, [id]);

  const { busy, run: once } = useSubmit();
  // One action at a time, so a double click cannot repeat it
  const run = (question: string, action: () => Promise<unknown>, title: string, detail?: string) => once(async () => {
    if (!window.confirm(question)) return;
    try {
      await action();
      await load();
      toast.success(title, { detail });
    } catch (err: any) {
      setError(err.message);
    }
  });

  if (error && !invoice) return <p className="error">{error}</p>;
  if (!invoice) return (
    <div className="stack" role="status" aria-label="Loading invoice">
      <div className="page-head"><Skeleton width={90} height={14} /><Skeleton width={180} height={34} radius={8} /></div>
      <div className="card document">
        <div className="document-head">
          <div style={{ display: 'grid', gap: 8 }}><Skeleton width={200} height={24} /><Skeleton width={70} height={12} /></div>
          <div style={{ display: 'grid', gap: 8, justifyItems: 'end' }}><Skeleton width={110} height={14} /><Skeleton width={130} height={12} /><Skeleton width={130} height={12} /></div>
        </div>
        <SkeletonText lines={4} />
        <div style={{ display: 'grid', gap: 8, justifyItems: 'end' }}><Skeleton width={220} height={14} /><Skeleton width={220} height={20} /></div>
      </div>
    </div>
  );

  const balance = Number(invoice.amount) - Number(invoice.amount_paid) - Number(invoice.amount_credited);
  const sales = Math.round(Number(invoice.subtotal) * Number(invoice.exchange_rate) * 100) / 100;
  const payable = (invoice.status === 'sent' || invoice.status === 'partial') && balance > 0;
  // One link per invoice; the database may send it as one row or a list of one
  const linkRow = Array.isArray(invoice.payment_links) ? invoice.payment_links[0] : invoice.payment_links;
  const payUrl = linkRow?.token ? payLinkUrl(linkRow.token) : '';
  // Card payments that came in but could not be put on the invoice automatically
  const toReview = (invoice.online_payments || []).filter((row: any) => row.status === 'review');

  return (
    <div className="stack">
      <div className="page-head no-print">
        <div className="row-actions">
          <Link href="/saas/accounting">← Invoices</Link>
          <StatusPill status={shownStatus(invoice)} />
        </div>
        <div className="row-actions">
          {invoice.customer_id && <Link href={`/saas/accounting/statements?customer=${invoice.customer_id}`}>Customer statement</Link>}
          {payable && <button onClick={() => setLinking(true)}>Get payment link</button>}
          {payable && (
            <button onClick={() => setWritingOff(true)}>Write off</button>
          )}
          {Number(invoice.amount_paid) > 0 && <button onClick={() => setRefunding(true)}>Refund</button>}
          {invoice.status === 'sent' && (
            <button className="danger" disabled={busy} onClick={() => run(
              `Void ${invoice.invoice_number}? Its ledger entry will be reversed.`,
              () => api.put(`/api/accounting/invoices/${invoice.id}`, { status: 'void' }),
              `${invoice.invoice_number} voided`,
              'Its ledger entry was reversed. The customer no longer owes it.'
            )}>Void invoice</button>
          )}
          <button className="primary always" onClick={() => window.print()}>Print or save as PDF</button>
        </div>
      </div>

      {error && <p className="error no-print">{error}</p>}

      <div className="card document">
        <div className="document-head">
          <div>
            <h1>{company}</h1>
            <p className="muted">Invoice {invoice.status === 'void' && <StatusPill status="void" />}</p>
          </div>
          <div className="document-meta">
            <div><strong>{invoice.invoice_number}</strong></div>
            <div>Date {formatDate(invoice.invoice_date)}</div>
            <div>Due {formatDate(invoice.due_date)}</div>
            {Number(invoice.exchange_rate) !== 1 && <div>Rate {Number(invoice.exchange_rate)}</div>}
          </div>
        </div>

        <div>
          <div className="muted">Bill to</div>
          <div>{invoice.customer_name}</div>
          {invoice.customer_email && <div>{invoice.customer_email}</div>}
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Description</th><th className="num">Quantity</th><th className="num">Price</th><th className="num">Amount</th></tr>
            </thead>
            <tbody>
              {invoice.line_items.map((line: any, index: number) => (
                <tr key={index}>
                  <td className="wrap">{line.description}</td>
                  <td className="num">{line.quantity}</td>
                  <td className="num"><Amount value={line.unit_price} currency={invoice.currency} /></td>
                  <td className="num"><Amount value={line.quantity * line.unit_price} currency={invoice.currency} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="document-totals">
          {Number(invoice.tax_amount) > 0 && (
            <>
              <div><span>Subtotal</span><span>{money(invoice.subtotal, invoice.currency)}</span></div>
              <div><span>Tax</span><span>{money(invoice.tax_amount, invoice.currency)}</span></div>
            </>
          )}
          <div><span>Total</span><span>{money(invoice.amount, invoice.currency)}</span></div>
          {Number(invoice.amount_paid) > 0 && <div><span>Paid</span><span>{money(invoice.amount_paid, invoice.currency)}</span></div>}
          {Number(invoice.amount_credited) > 0 && <div><span>Credited</span><span>{money(invoice.amount_credited, invoice.currency)}</span></div>}
          <div className="due"><span>Balance due</span><Amount value={invoice.status === 'void' ? 0 : balance} currency={invoice.currency} strong /></div>
        </div>

        {invoice.description && <p className="wrap">{invoice.description}</p>}

        {payable && payUrl && (
          <p className="wrap"><strong>Pay online:</strong> <a href={payUrl}>{payUrl}</a></p>
        )}
      </div>

      {toReview.length > 0 && (
        <div className="card no-print">
          <h2>Card payments to check</h2>
          <p className="muted">These card payments came in but could not be added to the invoice by themselves. Check them in Stripe, then record or refund them.</p>
          <ul>
            {toReview.map((row: any) => (
              <li key={row.id} className="wrap">{formatDate(row.paid_at)}: {money(row.amount, row.currency)}{row.reference ? ` (${row.reference})` : ''}. {row.note}</li>
            ))}
          </ul>
        </div>
      )}

      {Number(invoice.stock_cost) !== 0 && (
        <div className="card no-print">
          <h2>Profit</h2>
          <p className="muted">In your main currency{Number(invoice.exchange_rate) !== 1 && ', at this invoice\'s rate'}, before tax. Stock is costed at its average cost when the invoice was sent.</p>
          <div className="stats">
            <div><div className="stat-label">Sales</div><div className="stat-value">{money(sales)}</div></div>
            <div><div className="stat-label">Cost of stock</div><div className="stat-value">{money(invoice.stock_cost)}</div></div>
            <div><div className="stat-label">Gross profit</div><div className="stat-value">{money(sales - Number(invoice.stock_cost))}</div><div className="muted">{sales ? `${Math.round(((sales - Number(invoice.stock_cost)) / sales) * 100)}% margin` : ''}</div></div>
          </div>
        </div>
      )}

      {invoice.payments.length > 0 && (
        <div className="card table-wrap no-print">
          <h2>Payments</h2>
          <table>
            <thead><tr><th>Date</th><th>Account</th><th>Reference</th><th className="num">Amount</th><th /></tr></thead>
            <tbody>
              {invoice.payments.map((payment: any) => (
                <tr key={payment.id}>
                  <td>{formatDate(payment.payment_date)}</td>
                  <td>{payment.account?.code} {payment.account?.name}{payment.is_write_off && <> <span className="badge">Write-off</span></>}</td>
                  <td className="wrap">{payment.reference || '—'}</td>
                  <td className="num"><Amount value={payment.amount} currency={invoice.currency} dim={Boolean(payment.voided_at)} /></td>
                  <td className="num">
                    {payment.voided_at
                      ? <StatusPill status="void" />
                      : <button className="small danger" disabled={busy} onClick={() => run(
                          payment.is_write_off
                            ? 'Undo this write-off? Its ledger entry will be reversed and the balance will be owed again.'
                            : 'Void this payment? Its ledger entry will be reversed.',
                          () => api.post(`/api/accounting/payments/${payment.id}/void`, {}),
                          payment.is_write_off ? 'Write-off undone' : 'Payment voided',
                          `${money(payment.amount, invoice.currency)} is owed again.`
                        )}>{payment.is_write_off ? 'Undo write-off' : 'Void'}</button>}
                  </td>
                </tr>
              ))}
              {invoice.payments.length > 1 && (
                <tr className={styles.totalRow}>
                  <td colSpan={3}>Total received</td>
                  <td className="num"><Amount value={invoice.payments.filter((payment: any) => !payment.voided_at && !payment.is_write_off).reduce((sum: number, payment: any) => sum + Number(payment.amount), 0)} currency={invoice.currency} strong /></td>
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {invoice.credit_notes.length > 0 && (
        <div className="card table-wrap no-print">
          <h2>Credit notes</h2>
          <table>
            <thead><tr><th>Number</th><th>Date</th><th>Reason</th><th className="num">Amount</th><th /></tr></thead>
            <tbody>
              {invoice.credit_notes.map((credit: any) => (
                <tr key={credit.id}>
                  <td>{credit.credit_number}{credit.refund_account_id && <> <span className="badge">Refund</span></>}</td>
                  <td>{formatDate(credit.credit_date)}</td>
                  <td className="wrap">{credit.reason}</td>
                  <td className="num"><Amount value={credit.amount} currency={invoice.currency} dim={Boolean(credit.voided_at)} /></td>
                  <td className="num">
                    {credit.voided_at
                      ? <StatusPill status="void" />
                      : <button className="small danger" disabled={busy} onClick={() => run(
                          `Void ${credit.credit_number}? Its ledger entry will be reversed.`,
                          () => api.post(`/api/accounting/credit-notes/${credit.id}/void`, {}),
                          `${credit.credit_number} voided`,
                          `${money(credit.amount, invoice.currency)} is back on the invoice.`
                        )}>Void</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {writingOff && <WriteOffForm invoice={invoice} onClose={() => setWritingOff(false)} onSaved={load} />}
      {linking && <PaymentLinkModal invoice={invoice} onClose={() => setLinking(false)} onSaved={load} />}
      {refunding && <RefundForm invoice={invoice} onClose={() => setRefunding(false)} onSaved={load} />}
    </div>
  );
}

function RefundForm({ invoice, onClose, onSaved }: { invoice: any; onClose: () => void; onSaved: () => void }) {
  const paid = Number(invoice.amount_paid);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [form, setForm] = useState({ amount: paid.toFixed(2), credit_date: today(), account_id: '', reason: '', exchange_rate: '' });
  const [base, setBase] = useState(invoice.currency);
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm((current) => ({ ...current, [field]: value }));

  useEffect(() => {
    api.get('/api/accounting/accounts')
      .then((rows) => {
        const usable = rows.filter((account: any) => account.is_cash && account.is_active);
        setAccounts(usable);
        if (usable[0]) set('account_id', usable[0].id);
      })
      .catch((err) => setError(err.message));

    api.get('/api/accounting/currencies')
      .then((data) => {
        setBase(data.base);
        const latest = data.rates.find((row: any) => row.currency === invoice.currency);
        if (latest) set('exchange_rate', String(Number(latest.rate)));
      })
      .catch((err) => setError(err.message));
  }, []);

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api.post('/api/accounting/refunds', { invoice_id: invoice.id, ...form });
        toast.success('Refund recorded', { detail: `${money(form.amount, invoice.currency)} paid back on ${invoice.invoice_number}.` });
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title={`Refund on ${invoice.invoice_number}`} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="muted">Paid so far {money(paid, invoice.currency)}</p>
        <div className="form-grid">
          <label>Amount<input required type="number" min="0.01" step="0.01" max={paid} value={form.amount} onChange={(e) => set('amount', e.target.value)} /></label>
          <label>Date<input required type="date" value={form.credit_date} onChange={(e) => set('credit_date', e.target.value)} /></label>
          <label>Paid from
            <select required value={form.account_id} onChange={(e) => set('account_id', e.target.value)}>
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.code} {account.name}</option>)}
            </select>
          </label>
          {invoice.currency !== base && (
            <label>Rate today (1 {invoice.currency} in {base})
              <input required type="number" min="0.00000001" step="any" value={form.exchange_rate} onChange={(e) => set('exchange_rate', e.target.value)} />
            </label>
          )}
        </div>
        <label style={{ marginTop: 12 }}>Reason<textarea required rows={2} value={form.reason} onChange={(e) => set('reason', e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">Record refund</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
