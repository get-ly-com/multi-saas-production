import Link from 'next/link';
import { useRouter } from 'next/router';
import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import Modal from '@/components/Modal';
import { api, formatDate, money, today } from '@/lib/api';

export default function Invoice() {
  return <AppShell><InvoiceDocument /></AppShell>;
}

function InvoiceDocument() {
  const router = useRouter();
  const id = router.query.id as string | undefined;
  const [invoice, setInvoice] = useState<any>(null);
  const [company, setCompany] = useState('');
  const [error, setError] = useState('');
  const [refunding, setRefunding] = useState(false);

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

  const run = async (question: string, action: () => Promise<unknown>) => {
    if (!window.confirm(question)) return;
    try {
      await action();
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (error && !invoice) return <p className="error">{error}</p>;
  if (!invoice) return <p className="empty">Loading…</p>;

  const balance = Number(invoice.amount) - Number(invoice.amount_paid) - Number(invoice.amount_credited);

  return (
    <div className="stack">
      <div className="page-head no-print">
        <Link href="/saas/accounting">← Invoices</Link>
        <div className="row-actions">
          {Number(invoice.amount_paid) > 0 && <button onClick={() => setRefunding(true)}>Refund</button>}
          {invoice.status === 'sent' && (
            <button className="danger" onClick={() => run(
              `Void ${invoice.invoice_number}? Its ledger entry will be reversed.`,
              () => api.put(`/api/accounting/invoices/${invoice.id}`, { status: 'void' })
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
            <p className="muted">Invoice {invoice.status === 'void' && '(void)'}</p>
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
                  <td className="num">{money(line.unit_price, invoice.currency)}</td>
                  <td className="num">{money(line.quantity * line.unit_price, invoice.currency)}</td>
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
          <div className="due"><span>Balance due</span><span>{money(invoice.status === 'void' ? 0 : balance, invoice.currency)}</span></div>
        </div>

        {invoice.description && <p className="wrap">{invoice.description}</p>}
      </div>

      {invoice.payments.length > 0 && (
        <div className="card table-wrap no-print">
          <h2>Payments</h2>
          <table>
            <thead><tr><th>Date</th><th>Account</th><th>Reference</th><th className="num">Amount</th><th /></tr></thead>
            <tbody>
              {invoice.payments.map((payment: any) => (
                <tr key={payment.id}>
                  <td>{formatDate(payment.payment_date)}</td>
                  <td>{payment.account?.code} {payment.account?.name}</td>
                  <td>{payment.reference || '—'}</td>
                  <td className="num">{money(payment.amount, invoice.currency)}</td>
                  <td className="num">
                    {payment.voided_at
                      ? <span className="badge void">void</span>
                      : <button className="danger" onClick={() => run(
                          'Void this payment? Its ledger entry will be reversed.',
                          () => api.post(`/api/accounting/payments/${payment.id}/void`, {})
                        )}>Void</button>}
                  </td>
                </tr>
              ))}
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
                  <td>{credit.credit_number}{credit.refund_account_id && <span className="badge">refund</span>}</td>
                  <td>{formatDate(credit.credit_date)}</td>
                  <td className="wrap">{credit.reason}</td>
                  <td className="num">{money(credit.amount, invoice.currency)}</td>
                  <td className="num">
                    {credit.voided_at
                      ? <span className="badge void">void</span>
                      : <button className="danger" onClick={() => run(
                          `Void ${credit.credit_number}? Its ledger entry will be reversed.`,
                          () => api.post(`/api/accounting/credit-notes/${credit.id}/void`, {})
                        )}>Void</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post('/api/accounting/refunds', { invoice_id: invoice.id, ...form });
      await onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title={`Refund on ${invoice.invoice_number}`}>
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
          <button className="primary">Record refund</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
