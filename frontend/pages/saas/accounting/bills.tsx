import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import AccountingNav from '@/components/AccountingNav';
import AppShell from '@/components/AppShell';
import Modal from '@/components/Modal';
import PaymentForm from '@/components/PaymentForm';
import { api, formatDate, money, today } from '@/lib/api';

const blankLine = { description: '', account_id: '', amount: '' };
const blankBill = { vendor_id: '', vendor_ref: '', bill_date: '', due_date: '', notes: '', line_items: [blankLine] };

const billBalance = (bill: any) => Number(bill.amount) - Number(bill.amount_paid);

export default function Bills() {
  return <AppShell><BillsApp /></AppShell>;
}

function BillsApp() {
  const [bills, setBills] = useState<any[]>([]);
  const [vendors, setVendors] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState<any>(null);
  const [paying, setPaying] = useState<any>(null);
  const [historyId, setHistoryId] = useState('');

  const load = async () => {
    try {
      const [billRows, vendorRows, accountRows] = await Promise.all([
        api.get('/api/accounting/bills'),
        api.get('/api/accounting/vendors'),
        api.get('/api/accounting/accounts')
      ]);
      setBills(billRows);
      setVendors(vendorRows);
      setAccounts(accountRows.filter((account: any) =>
        ['expense', 'asset'].includes(account.type) && account.is_active && !account.is_cash && account.code !== '1200'));
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

  const remove = (bill: any) => {
    if (window.confirm(`Delete ${bill.bill_number}? This can't be undone.`)) {
      run(() => api.delete(`/api/accounting/bills/${bill.id}`));
    }
  };

  const voidBill = (bill: any) => {
    if (window.confirm(`Void ${bill.bill_number}? Its ledger entry will be reversed.`)) {
      run(() => api.put(`/api/accounting/bills/${bill.id}`, { status: 'void' }));
    }
  };

  const voidPayment = (payment: any) => {
    if (window.confirm('Void this payment? Its ledger entry will be reversed.')) {
      run(() => api.post(`/api/accounting/payments/${payment.id}/void`, {}));
    }
  };

  const history = bills.find((bill) => bill.id === historyId);

  return (
    <div className="stack">
      <AccountingNav />
      <div className="page-head">
        <h1>Bills</h1>
        <button className="primary" onClick={() => setForm({ ...blankBill, bill_date: today() })}>New bill</button>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="card table-wrap">
        {loading ? <p className="empty">Loading…</p> : (
          <table>
            <thead>
              <tr><th>Bill</th><th>Vendor</th><th>Due</th><th>Status</th><th className="num">Amount</th><th className="num">Balance</th><th /></tr>
            </thead>
            <tbody>
              {bills.length === 0 && <tr><td colSpan={7} className="empty">No bills yet</td></tr>}
              {bills.map((bill) => (
                <tr key={bill.id}>
                  <td>{bill.bill_number}{bill.vendor_ref && <span className="muted"> · {bill.vendor_ref}</span>}</td>
                  <td className="wrap">{bill.vendor?.name}</td>
                  <td>{formatDate(bill.due_date)}</td>
                  <td><span className={`badge ${bill.status}`}>{bill.status}</span></td>
                  <td className="num">{money(bill.amount)}</td>
                  <td className="num">{bill.status === 'void' || bill.status === 'draft' ? '—' : money(billBalance(bill))}</td>
                  <td>
                    <div className="row-actions">
                      {bill.status === 'draft' && (
                        <button onClick={() => run(() => api.put(`/api/accounting/bills/${bill.id}`, { status: 'open' }))}>Approve</button>
                      )}
                      {(bill.status === 'open' || bill.status === 'partial') && (
                        <button onClick={() => setPaying(bill)}>Pay</button>
                      )}
                      {bill.payments.length > 0 && <button onClick={() => setHistoryId(bill.id)}>Payments</button>}
                      {bill.status !== 'void' && (
                        <button onClick={() => setForm({ ...bill, vendor_ref: bill.vendor_ref || '', due_date: bill.due_date || '', notes: bill.notes || '' })}>Edit</button>
                      )}
                      {bill.status === 'draft' && <button className="danger" onClick={() => remove(bill)}>Delete</button>}
                      {bill.status === 'open' && <button className="danger" onClick={() => voidBill(bill)}>Void</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {vendors.length === 0 && !loading && (
        <p className="muted">Bills need a vendor. <Link href="/saas/accounting/vendors">Add your first vendor</Link>.</p>
      )}

      {form && <BillForm initial={form} vendors={vendors} accounts={accounts} onClose={() => setForm(null)} onSaved={load} />}
      {paying && (
        <PaymentForm
          target={{ bill_id: paying.id }}
          label={paying.bill_number}
          balance={billBalance(paying)}
          onClose={() => setPaying(null)}
          onSaved={load}
        />
      )}
      {history && (
        <Modal title={`Payments for ${history.bill_number}`}>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Account</th><th>Reference</th><th className="num">Amount</th><th /></tr></thead>
              <tbody>
                {history.payments.map((payment: any) => (
                  <tr key={payment.id}>
                    <td>{formatDate(payment.payment_date)}</td>
                    <td>{payment.account?.code} {payment.account?.name}</td>
                    <td>{payment.reference || '—'}</td>
                    <td className="num">{money(payment.amount)}</td>
                    <td className="num">
                      {payment.voided_at
                        ? <span className="badge void">void</span>
                        : <button className="danger" onClick={() => voidPayment(payment)}>Void</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form-actions"><button onClick={() => setHistoryId('')}>Close</button></div>
        </Modal>
      )}
    </div>
  );
}

function BillForm({ initial, vendors, accounts, onClose, onSaved }: { initial: any; vendors: any[]; accounts: any[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<any>(initial);
  const [error, setError] = useState('');
  const set = (field: string, value: unknown) => setForm({ ...form, [field]: value });
  const posted = form.id && form.status !== 'draft';

  const setLine = (index: number, field: string, value: string) =>
    set('line_items', form.line_items.map((line: any, i: number) => (i === index ? { ...line, [field]: value } : line)));

  const total = form.line_items.reduce((sum: number, line: any) => sum + Number(line.amount || 0), 0);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const { vendor_id, vendor_ref, bill_date, due_date, notes, line_items } = form;
    const body = { vendor_id, vendor_ref, bill_date, due_date, notes, line_items };
    try {
      if (form.id) await api.put(`/api/accounting/bills/${form.id}`, body);
      else await api.post('/api/accounting/bills', body);
      await onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title={form.id ? `Edit ${form.bill_number}` : 'New bill'}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Vendor
            <select required disabled={posted} value={form.vendor_id} onChange={(e) => set('vendor_id', e.target.value)}>
              <option value="">Choose a vendor</option>
              {vendors.filter((vendor) => vendor.is_active || vendor.id === form.vendor_id).map((vendor) => (
                <option key={vendor.id} value={vendor.id}>{vendor.name}</option>
              ))}
            </select>
          </label>
          <label>Vendor's bill number<input value={form.vendor_ref} onChange={(e) => set('vendor_ref', e.target.value)} /></label>
          <label>Bill date<input required type="date" value={form.bill_date} onChange={(e) => set('bill_date', e.target.value)} /></label>
          <label>Due date<input type="date" value={form.due_date} onChange={(e) => set('due_date', e.target.value)} /></label>
        </div>
        <div className="lines">
          {form.line_items.map((line: any, index: number) => (
            <div className="bill-line" key={index}>
              <input aria-label="Description" placeholder="Description" value={line.description || ''} onChange={(e) => setLine(index, 'description', e.target.value)} />
              <select required aria-label="Account" value={line.account_id} onChange={(e) => setLine(index, 'account_id', e.target.value)}>
                <option value="">Choose an account</option>
                {accounts.map((account) => <option key={account.id} value={account.id}>{account.code} {account.name}</option>)}
              </select>
              <input required aria-label="Amount" placeholder="Amount" type="number" min="0.01" step="0.01" value={line.amount} onChange={(e) => setLine(index, 'amount', e.target.value)} />
              <button type="button" aria-label="Remove line" disabled={form.line_items.length === 1} onClick={() => set('line_items', form.line_items.filter((_: any, i: number) => i !== index))}>×</button>
            </div>
          ))}
        </div>
        <button type="button" onClick={() => set('line_items', [...form.line_items, blankLine])}>Add line</button>
        <p>Total: <strong>{money(total)}</strong></p>
        <label>Notes<textarea rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
