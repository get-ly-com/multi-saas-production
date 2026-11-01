import { FormEvent, useEffect, useState } from 'react';
import AccountingNav from '@/components/AccountingNav';
import AppShell from '@/components/AppShell';
import CurrencyFields from '@/components/CurrencyFields';
import Modal from '@/components/Modal';
import { api, formatDate, money, today } from '@/lib/api';

const blankLine = { description: '', account_id: '', quantity: '1', unit_price: '', tax_rate_id: '', cost_center_id: '' };
const blankOrder = { vendor_id: '', order_date: '', expected_date: '', notes: '', currency: '', exchange_rate: '1', line_items: [blankLine] };

export default function PurchaseOrders() {
  return <AppShell><OrdersApp /></AppShell>;
}

function OrdersApp() {
  const [orders, setOrders] = useState<any[]>([]);
  const [vendors, setVendors] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [taxRates, setTaxRates] = useState<any[]>([]);
  const [costCenters, setCostCenters] = useState<any[]>([]);
  const [role, setRole] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState<any>(null);

  const load = async () => {
    try {
      const [orderRows, vendorRows, accountRows, rateRows, centerRows, me] = await Promise.all([
        api.get('/api/accounting/purchase-orders'),
        api.get('/api/accounting/vendors'),
        api.get('/api/accounting/accounts'),
        api.get('/api/accounting/tax-rates'),
        api.get('/api/accounting/cost-centers'),
        api.get('/api/me')
      ]);
      setOrders(orderRows);
      setVendors(vendorRows);
      setAccounts(accountRows.filter((account: any) =>
        ['expense', 'asset'].includes(account.type) && account.is_active && !account.is_cash && !['1200', '1590'].includes(account.code)));
      setTaxRates(rateRows);
      setCostCenters(centerRows);
      setRole(me.tenant.role);
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

  const run = async (action: () => Promise<unknown>, done = '') => {
    try {
      await action();
      setNotice(done);
      await load();
    } catch (err: any) {
      setNotice('');
      setError(err.message);
    }
  };

  const reject = (order: any) => {
    const note = window.prompt(`Why are you rejecting ${order.po_number}?`);
    if (note !== null) run(() => api.post(`/api/accounting/purchase-orders/${order.id}/decide`, { approve: false, note }));
  };

  const remove = (order: any) => {
    if (window.confirm(`Delete ${order.po_number}? This can't be undone.`)) {
      run(() => api.delete(`/api/accounting/purchase-orders/${order.id}`));
    }
  };

  const manager = ['owner', 'admin'].includes(role);

  return (
    <div className="stack">
      <AccountingNav />
      <div className="page-head">
        <h1>Purchase orders</h1>
        <button className="primary" onClick={() => setForm({ ...blankOrder, order_date: today() })}>New purchase order</button>
      </div>

      <p className="muted">An order posts nothing to the books. Once approved it can become a draft bill. People can't approve their own order if someone else in the company can.</p>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="card table-wrap">
        {loading ? <p className="empty">Loading…</p> : (
          <table>
            <thead><tr><th>Order</th><th>Vendor</th><th>Date</th><th>Status</th><th className="num">Amount</th><th /></tr></thead>
            <tbody>
              {orders.length === 0 && <tr><td colSpan={6} className="empty">No purchase orders yet</td></tr>}
              {orders.map((order) => (
                <tr key={order.id}>
                  <td>{order.po_number}</td>
                  <td className="wrap">{order.vendor?.name}{order.decision_note && <div className="muted">{order.decision_note}</div>}</td>
                  <td>{formatDate(order.order_date)}</td>
                  <td><span className={`badge ${order.status === 'approved' ? 'paid' : order.status === 'rejected' ? 'void' : order.status === 'pending' ? 'sent' : ''}`}>{order.status}</span></td>
                  <td className="num">{money(order.amount, order.currency)}</td>
                  <td>
                    <div className="row-actions">
                      {order.status === 'draft' && (
                        <button onClick={() => run(() => api.post(`/api/accounting/purchase-orders/${order.id}/submit`, {}))}>Submit</button>
                      )}
                      {order.status === 'pending' && manager && (
                        <>
                          <button onClick={() => run(() => api.post(`/api/accounting/purchase-orders/${order.id}/decide`, { approve: true }))}>Approve</button>
                          <button className="danger" onClick={() => reject(order)}>Reject</button>
                        </>
                      )}
                      {order.status === 'approved' && (
                        <button onClick={() => run(() => api.post(`/api/accounting/purchase-orders/${order.id}/bill`, {}), `${order.po_number} is now a draft bill. Approve it under Bills.`)}>Create bill</button>
                      )}
                      {['draft', 'rejected'].includes(order.status) && (
                        <>
                          <button onClick={() => setForm({ ...order, expected_date: order.expected_date || '', notes: order.notes || '' })}>Edit</button>
                          <button className="danger" onClick={() => remove(order)}>Delete</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {form && (
        <OrderForm
          initial={form}
          vendors={vendors}
          accounts={accounts}
          taxRates={taxRates}
          costCenters={costCenters}
          onClose={() => setForm(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}

function OrderForm({ initial, vendors, accounts, taxRates, costCenters, onClose, onSaved }: { initial: any; vendors: any[]; accounts: any[]; taxRates: any[]; costCenters: any[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<any>(initial);
  const [error, setError] = useState('');
  const set = (field: string, value: unknown) => setForm({ ...form, [field]: value });

  const setLine = (index: number, field: string, value: string) =>
    set('line_items', form.line_items.map((line: any, i: number) => (i === index ? { ...line, [field]: value } : line)));

  const net = (line: any) => Number(line.quantity || 0) * Number(line.unit_price || 0);
  const subtotal = form.line_items.reduce((sum: number, line: any) => sum + net(line), 0);
  const tax = form.line_items.reduce((sum: number, line: any) => {
    const rate = taxRates.find(({ id }) => id === line.tax_rate_id);
    return sum + Math.round(net(line) * Number(rate?.rate || 0)) / 100;
  }, 0);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const { id, vendor_id, order_date, expected_date, notes, currency, exchange_rate, line_items } = form;
    try {
      await api.post('/api/accounting/purchase-orders', { id, vendor_id, order_date, expected_date, notes, currency, exchange_rate, line_items });
      await onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title={form.id ? `Edit ${form.po_number}` : 'New purchase order'}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Vendor
            <select required value={form.vendor_id} onChange={(e) => set('vendor_id', e.target.value)}>
              <option value="">Choose a vendor</option>
              {vendors.filter((vendor) => vendor.is_active || vendor.id === form.vendor_id).map((vendor) => (
                <option key={vendor.id} value={vendor.id}>{vendor.name}</option>
              ))}
            </select>
          </label>
          <label>Order date<input required type="date" value={form.order_date} onChange={(e) => set('order_date', e.target.value)} /></label>
          <label>Expected<input type="date" value={form.expected_date} onChange={(e) => set('expected_date', e.target.value)} /></label>
          <CurrencyFields
            currency={form.currency}
            rate={form.exchange_rate}
            locked={false}
            onChange={(currency, exchange_rate) => setForm((current: any) => ({ ...current, currency, exchange_rate }))}
          />
        </div>
        <div className="lines">
          {form.line_items.map((line: any, index: number) => (
            <div className="order-line" key={index}>
              <input required aria-label="Description" placeholder="Description" value={line.description} onChange={(e) => setLine(index, 'description', e.target.value)} />
              <select required aria-label="Account" value={line.account_id} onChange={(e) => setLine(index, 'account_id', e.target.value)}>
                <option value="">Account</option>
                {accounts.map((account) => <option key={account.id} value={account.id}>{account.code} {account.name}</option>)}
              </select>
              <input required aria-label="Quantity" type="number" min="0.01" step="0.01" value={line.quantity} onChange={(e) => setLine(index, 'quantity', e.target.value)} />
              <input required aria-label="Unit price" placeholder="Price" type="number" min="0" step="0.01" value={line.unit_price} onChange={(e) => setLine(index, 'unit_price', e.target.value)} />
              <select aria-label="Tax" value={line.tax_rate_id || ''} onChange={(e) => setLine(index, 'tax_rate_id', e.target.value)}>
                <option value="">No tax</option>
                {taxRates.filter((rate) => rate.is_active || rate.id === line.tax_rate_id).map((rate) => <option key={rate.id} value={rate.id}>{rate.name}</option>)}
              </select>
              <select aria-label="Cost center" value={line.cost_center_id || ''} onChange={(e) => setLine(index, 'cost_center_id', e.target.value)}>
                <option value="">No center</option>
                {costCenters.filter((center) => center.is_active || center.id === line.cost_center_id).map((center) => <option key={center.id} value={center.id}>{center.code}</option>)}
              </select>
              <button type="button" aria-label="Remove line" disabled={form.line_items.length === 1} onClick={() => set('line_items', form.line_items.filter((_: any, i: number) => i !== index))}>×</button>
            </div>
          ))}
        </div>
        <button type="button" onClick={() => set('line_items', [...form.line_items, blankLine])}>Add line</button>
        <p>Subtotal {money(subtotal, form.currency || undefined)} · Tax {money(tax, form.currency || undefined)} · Total: <strong>{money(subtotal + tax, form.currency || undefined)}</strong></p>
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
