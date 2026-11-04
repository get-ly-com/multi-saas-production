import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import {
  Amount, CreateMenu, DrawerActions, DrawerHero, DrawerSection, Facts, FilterPills, PageHead, StatusPill,
  isOverdue, rowOpener, shownStatus, styles
} from '@/components/AccountingKit';
import AccountingNav from '@/components/AccountingNav';
import AppShell, { useAccount } from '@/components/AppShell';
import CurrencyFields from '@/components/CurrencyFields';
import Drawer from '@/components/Drawer';
import EmptyState from '@/components/EmptyState';
import Modal from '@/components/Modal';
import PaymentForm from '@/components/PaymentForm';
import ReceiptReader, { ReceiptFields } from '@/components/ReceiptReader';
import { SkeletonTable } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api, formatDate, money, today } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

const blankLine = { description: '', account_id: '', amount: '', tax_rate_id: '', cost_center_id: '' };
const blankBill = { vendor_id: '', vendor_ref: '', bill_date: '', due_date: '', notes: '', currency: '', exchange_rate: '1', line_items: [blankLine] };

const billBalance = (bill: any) => Number(bill.amount) - Number(bill.amount_paid);

const payable = (bill: any) => bill.status === 'open' || bill.status === 'partial';

const sharedCurrency = (rows: any[]) => {
  const codes = new Set(rows.map((row) => row.currency || ''));
  return codes.size === 1 ? Array.from(codes)[0] : null;
};

type Filter = 'all' | 'draft' | 'unpaid' | 'overdue' | 'paid';

const FILTERS: Record<Filter, (bill: any) => boolean> = {
  all: () => true,
  draft: (bill) => bill.status === 'draft',
  unpaid: (bill) => payable(bill),
  overdue: (bill) => isOverdue(bill),
  paid: (bill) => bill.status === 'paid'
};

export default function Bills() {
  return <AppShell><BillsApp /></AppShell>;
}

function BillsApp() {
  const account = useAccount();
  const canEdit = account?.canEdit !== false;
  const [bills, setBills] = useState<any[]>([]);
  const [vendors, setVendors] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [taxRates, setTaxRates] = useState<any[]>([]);
  const [costCenters, setCostCenters] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [crediting, setCrediting] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState<any>(null);
  const [paying, setPaying] = useState<any>(null);
  const [openId, setOpenId] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const load = async () => {
    try {
      const [billRows, vendorRows, accountRows, rateRows, centerRows, itemRows] = await Promise.all([
        api.get('/api/accounting/bills'),
        api.get('/api/accounting/vendors'),
        api.get('/api/accounting/accounts'),
        api.get('/api/accounting/tax-rates'),
        api.get('/api/accounting/cost-centers'),
        api.get('/api/inventory/items').catch(() => [])
      ]);
      setBills(billRows);
      setVendors(vendorRows);
      setTaxRates(rateRows);
      setCostCenters(centerRows);
      setItems(itemRows);
      // Inventory only moves with a stock item, so it isn't offered as a plain account
      setAccounts(accountRows.filter((account: any) =>
        ['expense', 'asset'].includes(account.type) && account.is_active && !account.is_cash && !['1200', '1300', '1400', '1590'].includes(account.code)));
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

  const { busy, run: once } = useSubmit();
  // One action at a time, so a double click cannot repeat it
  const run = (action: () => Promise<unknown>, title?: string, detail?: string) => once(async () => {
    try {
      await action();
      await load();
      if (title) toast.success(title, { detail });
    } catch (err: any) {
      setError(err.message);
      toast.error('That did not work', { detail: err.message });
    }
  });

  const remove = (bill: any) => {
    if (window.confirm(`Delete ${bill.bill_number}? This can't be undone.`)) {
      setOpenId('');
      run(() => api.delete(`/api/accounting/bills/${bill.id}`), `${bill.bill_number} deleted`, 'The draft is gone for good.');
    }
  };

  const voidBill = (bill: any) => {
    if (window.confirm(`Void ${bill.bill_number}? Its ledger entry will be reversed.`)) {
      run(() => api.put(`/api/accounting/bills/${bill.id}`, { status: 'void' }), `${bill.bill_number} voided`, 'Its ledger entry was reversed. You no longer owe it.');
    }
  };

  const approve = (bill: any) =>
    run(() => api.put(`/api/accounting/bills/${bill.id}`, { status: 'open' }), `${bill.bill_number} approved`, `${money(bill.amount, bill.currency)} is now ready to pay.`);

  const voidPayment = (payment: any) => {
    if (window.confirm('Void this payment? Its ledger entry will be reversed.')) {
      run(() => api.post(`/api/accounting/payments/${payment.id}/void`, {}), 'Payment voided', 'Its ledger entry was reversed and the bill is owed again.');
    }
  };

  const voidCredit = (credit: any) => {
    if (window.confirm(`Void ${credit.credit_number}? Its ledger entry will be reversed.`)) {
      run(() => api.post(`/api/accounting/vendor-credits/${credit.id}/void`, {}), `${credit.credit_number} voided`, 'Its ledger entry was reversed.');
    }
  };

  const newBill = () => setForm({ ...blankBill, bill_date: today() });
  const editBill = (bill: any) => setForm({ ...bill, vendor_ref: bill.vendor_ref || '', due_date: bill.due_date || '', notes: bill.notes || '' });
  const fromDrawer = (open: () => void) => () => {
    setOpenId('');
    open();
  };

  const open = bills.find((bill) => bill.id === openId);
  const shown = bills.filter(FILTERS[filter]);
  const counts = (Object.keys(FILTERS) as Filter[]).reduce((all, key) => ({ ...all, [key]: bills.filter(FILTERS[key]).length }), {} as Record<Filter, number>);
  const listCurrency = sharedCurrency(shown);

  return (
    <div className="stack">
      <AccountingNav />
      <PageHead title="Bills" line="What you owe your vendors, and when it is due.">
        <CreateMenu
          label="New bill"
          onClick={newBill}
          items={[
            { label: 'Bill', icon: 'accounting', onClick: newBill },
            { label: 'Purchase order', icon: 'quote', href: '/saas/accounting/purchase-orders?new=1' },
            { label: 'Expense', icon: 'money', href: '/saas/accounting?create=expense' },
            { label: 'Vendor', icon: 'contact', href: '/saas/accounting/vendors?new=1' }
          ]}
        />
      </PageHead>

      {error && <p className="error">{error}</p>}

      {!loading && bills.length > 0 && (
        <FilterPills<Filter>
          label="Show bills"
          value={filter}
          onChange={setFilter}
          options={[
            { id: 'all', label: 'All', count: counts.all },
            { id: 'draft', label: 'Drafts', count: counts.draft },
            { id: 'unpaid', label: 'To pay', count: counts.unpaid },
            { id: 'overdue', label: 'Overdue', count: counts.overdue },
            { id: 'paid', label: 'Paid', count: counts.paid }
          ]}
        />
      )}

      {loading ? <SkeletonTable rows={6} columns={6} /> : shown.length === 0 ? (
        <div className="card">
          {bills.length === 0 ? (
            <EmptyState
              icon="accounting"
              title="No bills yet"
              line={vendors.length === 0
                ? 'Bills need a vendor. Add one, then snap the bill and we fill in the date and amount.'
                : 'Add a bill when one arrives. Snap it and we fill in the date and amount.'}
              action={canEdit ? (vendors.length === 0 ? { label: 'Add a vendor', href: '/saas/accounting/vendors?new=1' } : { label: 'New bill', onClick: newBill }) : undefined}
            />
          ) : filter === 'overdue' || filter === 'unpaid' ? (
            <EmptyState tone="done" icon="paid" title={filter === 'overdue' ? 'No overdue bills' : 'Nothing left to pay'} line="Your vendors are all paid up." secondary={{ label: 'See all bills', onClick: () => setFilter('all') }} />
          ) : (
            <EmptyState icon="accounting" title={filter === 'draft' ? 'No drafts' : 'No paid bills yet'} line={filter === 'draft' ? 'Every bill has been approved.' : 'Bills show up here once you pay them.'} secondary={{ label: 'See all bills', onClick: () => setFilter('all') }} />
          )}
        </div>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr><th>Bill</th><th>Vendor</th><th>Due</th><th>Status</th><th className="num">Amount</th><th className="num">Balance</th><th /></tr>
            </thead>
            <tbody>
              {shown.map((bill) => (
                <tr key={bill.id} {...rowOpener(() => setOpenId(bill.id))}>
                  <td>
                    <button type="button" className={`${styles.rowTitle} always`} onClick={() => setOpenId(bill.id)}>{bill.bill_number}</button>
                    {bill.vendor_ref && <span className={styles.rowSub}>Their ref {bill.vendor_ref}</span>}
                  </td>
                  <td className="wrap">{bill.vendor?.name}</td>
                  <td>{formatDate(bill.due_date)}</td>
                  <td><StatusPill status={shownStatus(bill)} /></td>
                  <td className="num"><Amount value={bill.amount} currency={bill.currency} /></td>
                  <td className="num">
                    {bill.status === 'void' || bill.status === 'draft'
                      ? null
                      : <Amount value={billBalance(bill)} currency={bill.currency} dim={billBalance(bill) <= 0} strong={isOverdue(bill)} />}
                  </td>
                  <td>
                    <div className="row-actions">
                      {bill.status === 'draft' && <button className="small" disabled={busy} onClick={() => approve(bill)}>Approve</button>}
                      {payable(bill) && <button className="small" onClick={() => setPaying(bill)}>Pay</button>}
                    </div>
                  </td>
                </tr>
              ))}
              {listCurrency !== null && shown.length > 1 && (
                <tr className={styles.totalRow}>
                  <td colSpan={4}>Total of {shown.length} bills</td>
                  <td className="num"><Amount value={shown.reduce((sum, bill) => sum + Number(bill.amount), 0)} currency={listCurrency || undefined} strong /></td>
                  <td className="num"><Amount value={shown.filter((bill) => bill.status !== 'void' && bill.status !== 'draft').reduce((sum, bill) => sum + billBalance(bill), 0)} currency={listCurrency || undefined} strong /></td>
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <Drawer
        open={Boolean(open)}
        title={open?.bill_number}
        subtitle={open?.vendor?.name}
        onClose={() => setOpenId('')}
        footer={open && canEdit && (
          <>
            {open.status === 'draft' && <button className="primary" disabled={busy} onClick={() => approve(open)}>Approve bill</button>}
            {payable(open) && <button className="primary" onClick={fromDrawer(() => setPaying(open))}>Pay bill</button>}
          </>
        )}
      >
        {open && (
          <>
            <DrawerHero
              label={open.status === 'paid' ? 'Paid in full' : open.status === 'draft' ? 'Draft total' : 'Left to pay'}
              value={<Amount value={open.status === 'paid' || open.status === 'draft' ? open.amount : open.status === 'void' ? 0 : billBalance(open)} currency={open.currency} />}
              line={open.status === 'draft'
                ? 'Approve it to add it to what you owe.'
                : open.status === 'void' ? 'This bill was voided.'
                : `${money(open.amount_paid, open.currency)} of ${money(open.amount, open.currency)} paid`}
              pill={<StatusPill status={shownStatus(open)} />}
              paidShare={open.status === 'draft' || open.status === 'void' || !Number(open.amount) ? undefined : Number(open.amount_paid) / Number(open.amount)}
            />

            <Facts items={[
              ['Vendor', open.vendor?.name],
              ["Vendor's number", open.vendor_ref],
              ['Bill date', formatDate(open.bill_date)],
              ['Due', open.due_date ? formatDate(open.due_date) : <span className="muted">No due date</span>],
              ['Currency', Number(open.exchange_rate) !== 1 ? `${open.currency} at ${Number(open.exchange_rate)}` : null],
              ['Notes', open.notes ? <span style={{ whiteSpace: 'pre-wrap' }}>{open.notes}</span> : null]
            ]} />

            {(open.line_items || []).length > 0 && (
              <DrawerSection title="Lines">
                <table className={styles.mini}>
                  <tbody>
                    {open.line_items.map((line: any, index: number) => (
                      <tr key={index}>
                        <td className="wrap">{line.description || <span className="muted">No description</span>}{line.quantity ? <span className={styles.rowSub}>{Number(line.quantity)} units</span> : null}</td>
                        <td className="num"><Amount value={line.amount} currency={open.currency} /></td>
                      </tr>
                    ))}
                    <tr className="total"><td>Total</td><td className="num"><Amount value={open.amount} currency={open.currency} strong /></td></tr>
                  </tbody>
                </table>
              </DrawerSection>
            )}

            {open.payments.length + open.vendor_credits.length > 0 && (
              <DrawerSection title="Payments and credits">
                <table className={styles.mini}>
                  <tbody>
                    {open.payments.map((payment: any) => (
                      <tr key={payment.id}>
                        <td>
                          {formatDate(payment.payment_date)}
                          <span className={styles.rowSub}>{payment.account?.code} {payment.account?.name}{payment.reference ? ` · ${payment.reference}` : ''}</span>
                        </td>
                        <td className="num"><Amount value={payment.amount} currency={open.currency} dim={Boolean(payment.voided_at)} /></td>
                        <td className="num">
                          {payment.voided_at
                            ? <StatusPill status="void" />
                            : canEdit && <button className="small danger" disabled={busy} onClick={() => voidPayment(payment)}>Void</button>}
                        </td>
                      </tr>
                    ))}
                    {open.vendor_credits.map((credit: any) => (
                      <tr key={credit.id}>
                        <td className="wrap">
                          {formatDate(credit.credit_date)}
                          <span className={styles.rowSub}>{credit.credit_number}: {credit.reason}</span>
                        </td>
                        <td className="num"><Amount value={credit.amount} currency={open.currency} dim={Boolean(credit.voided_at)} /></td>
                        <td className="num">
                          {credit.voided_at
                            ? <StatusPill status="void" />
                            : canEdit && <button className="small danger" disabled={busy} onClick={() => voidCredit(credit)}>Void</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DrawerSection>
            )}

            {canEdit && open.status !== 'void' && (
              <DrawerActions>
                {payable(open) && <button onClick={fromDrawer(() => setCrediting(open))}>Vendor credit</button>}
                <button onClick={fromDrawer(() => editBill(open))}>Edit</button>
                {open.status === 'draft' && <button className="danger" disabled={busy} onClick={() => remove(open)}>Delete draft</button>}
                {open.status === 'open' && <button className="danger" disabled={busy} onClick={() => voidBill(open)}>Void</button>}
              </DrawerActions>
            )}
          </>
        )}
      </Drawer>

      {form && <BillForm initial={form} vendors={vendors} accounts={accounts} items={items} taxRates={taxRates} costCenters={costCenters} onClose={() => setForm(null)} onSaved={load} />}
      {paying && (
        <PaymentForm
          target={{ bill_id: paying.id }}
          label={paying.bill_number}
          balance={billBalance(paying)}
          currency={paying.currency}
          onClose={() => setPaying(null)}
          onSaved={load}
        />
      )}
      {crediting && <VendorCreditForm bill={crediting} accounts={accounts} onClose={() => setCrediting(null)} onSaved={load} />}
    </div>
  );
}

function VendorCreditForm({ bill, accounts, onClose, onSaved }: { bill: any; accounts: any[]; onClose: () => void; onSaved: () => void }) {
  const balance = billBalance(bill);
  const [form, setForm] = useState({ amount: balance.toFixed(2), credit_date: today(), account_id: bill.line_items[0]?.account_id || '', reason: '' });
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm({ ...form, [field]: value });

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api.post('/api/accounting/vendor-credits', { bill_id: bill.id, ...form });
        toast.success('Vendor credit saved', { detail: `${money(form.amount, bill.currency)} taken off ${bill.bill_number}.` });
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title={`Vendor credit for ${bill.bill_number}`} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="muted">Balance {money(balance, bill.currency)}</p>
        <div className="form-grid">
          <label>Amount<input required type="number" min="0.01" step="0.01" max={balance} value={form.amount} onChange={(e) => set('amount', e.target.value)} /></label>
          <label>Date<input required type="date" value={form.credit_date} onChange={(e) => set('credit_date', e.target.value)} /></label>
          <label>Take off account
            <select required value={form.account_id} onChange={(e) => set('account_id', e.target.value)}>
              <option value="">Choose an account</option>
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.code} {account.name}</option>)}
            </select>
          </label>
        </div>
        <label style={{ marginTop: 12 }}>Reason<textarea required rows={2} value={form.reason} onChange={(e) => set('reason', e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">Save credit</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function BillForm({ initial, vendors, accounts, items, taxRates, costCenters, onClose, onSaved }: { initial: any; vendors: any[]; accounts: any[]; items: any[]; taxRates: any[]; costCenters: any[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<any>(initial);
  const [error, setError] = useState('');
  const set = (field: string, value: unknown) => setForm({ ...form, [field]: value });
  const posted = form.id && form.status !== 'draft';

  const setLine = (index: number, field: string, value: string) =>
    set('line_items', form.line_items.map((line: any, i: number) => (i === index ? { ...line, [field]: value } : line)));

  // One choice covers both: a stock item (posted to Inventory) or an account
  const lineTarget = (line: any) => (line.item_id ? `item:${line.item_id}` : line.account_id);
  const setTarget = (index: number, value: string) =>
    set('line_items', form.line_items.map((line: any, i: number) => {
      if (i !== index) return line;
      if (value.startsWith('item:')) {
        const item = items.find(({ id }) => id === value.slice(5));
        return { ...line, item_id: value.slice(5), account_id: '', quantity: line.quantity || '1', description: line.description || item?.name || '' };
      }
      return { ...line, item_id: '', quantity: '', account_id: value };
    }));

  // A read receipt fills the date, a vendor with the same name, and a single empty line before tax
  const fromReceipt = (read: ReceiptFields) =>
    setForm((current: any) => {
      const name = (read.vendor || '').toLowerCase();
      const vendor = name && vendors.find((row) => row.is_active && row.name.length >= 3 && (row.name.toLowerCase().includes(name) || name.includes(row.name.toLowerCase())));
      const [line, ...rest] = current.line_items;
      const net = read.total !== null ? Math.max(0, Math.round((read.total - (read.tax || 0)) * 100) / 100) : null;
      return {
        ...current,
        bill_date: read.date || current.bill_date,
        vendor_id: current.vendor_id || vendor?.id || '',
        line_items: !rest.length && !line.amount && net ? [{ ...line, amount: String(net), description: line.description || read.vendor || '' }] : current.line_items
      };
    });

  const subtotal = form.line_items.reduce((sum: number, line: any) => sum + Number(line.amount || 0), 0);
  const tax = form.line_items.reduce((sum: number, line: any) => {
    const rate = taxRates.find(({ id }) => id === line.tax_rate_id);
    return sum + Math.round(Number(line.amount || 0) * Number(rate?.rate || 0)) / 100;
  }, 0);

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      const { vendor_id, vendor_ref, bill_date, due_date, notes, line_items, currency, exchange_rate } = form;
      const body = { vendor_id, vendor_ref, bill_date, due_date, notes, line_items, currency, exchange_rate };
      try {
        if (form.id) await api.put(`/api/accounting/bills/${form.id}`, body);
        else await api.post('/api/accounting/bills', body);
        const vendor = vendors.find(({ id }) => id === vendor_id)?.name;
        if (form.id) toast.success('Bill saved', { detail: `${form.bill_number} is up to date.` });
        else toast.success('Draft bill added', { detail: `${money(subtotal + tax, currency || undefined)} from ${vendor || 'your vendor'}. Approve it when you are ready to pay.` });
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title={form.id ? `Edit ${form.bill_number}` : 'New bill'} onClose={onClose}>
      <form onSubmit={submit}>
        {!form.id && <ReceiptReader onRead={fromReceipt} />}
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
          <CurrencyFields
            currency={form.currency}
            rate={form.exchange_rate}
            locked={Boolean(form.id) && Number(form.amount_paid) > 0}
            onChange={(currency, exchange_rate) => setForm((current: any) => ({ ...current, currency, exchange_rate }))}
          />
        </div>
        <div className="lines">
          {form.line_items.map((line: any, index: number) => (
            <div className="bill-line" key={index}>
              <input aria-label="Description" placeholder="Description" value={line.description || ''} onChange={(e) => setLine(index, 'description', e.target.value)} />
              <select required aria-label="Account or stock item" value={lineTarget(line)} onChange={(e) => setTarget(index, e.target.value)}>
                <option value="">Choose an account or item</option>
                {items.length > 0 && (
                  <optgroup label="Stock items (to Inventory)">
                    {items.map((item) => <option key={item.id} value={`item:${item.id}`}>{item.sku} {item.name}</option>)}
                  </optgroup>
                )}
                <optgroup label="Accounts">
                  {accounts.map((account) => <option key={account.id} value={account.id}>{account.code} {account.name}</option>)}
                </optgroup>
              </select>
              {line.item_id
                ? <input required aria-label="Quantity" placeholder="Qty" type="number" min="1" step="1" value={line.quantity} onChange={(e) => setLine(index, 'quantity', e.target.value)} />
                : <span />}
              <input required aria-label="Amount" placeholder="Amount" type="number" min="0.01" step="0.01" value={line.amount} onChange={(e) => setLine(index, 'amount', e.target.value)} />
              <select aria-label="Tax" value={line.tax_rate_id || ''} onChange={(e) => setLine(index, 'tax_rate_id', e.target.value)}>
                <option value="">No tax</option>
                {taxRates.filter((rate) => rate.is_active || rate.id === line.tax_rate_id).map((rate) => (
                  <option key={rate.id} value={rate.id}>{rate.name}</option>
                ))}
              </select>
              <select aria-label="Cost center" value={line.cost_center_id || ''} onChange={(e) => setLine(index, 'cost_center_id', e.target.value)}>
                <option value="">No center</option>
                {costCenters.filter((center) => center.is_active || center.id === line.cost_center_id).map((center) => (
                  <option key={center.id} value={center.id}>{center.code}</option>
                ))}
              </select>
              <button type="button" aria-label="Remove line" disabled={form.line_items.length === 1} onClick={() => set('line_items', form.line_items.filter((_: any, i: number) => i !== index))}>×</button>
            </div>
          ))}
        </div>
        <button type="button" onClick={() => set('line_items', [...form.line_items, blankLine])}>Add line</button>
        <div className="document-totals" style={{ margin: '12px 0 12px auto' }}>
          <div><span className="muted">Subtotal</span><Amount value={subtotal} currency={form.currency || undefined} /></div>
          <div><span className="muted">Tax</span><Amount value={tax} currency={form.currency || undefined} /></div>
          <div className="due"><span>Total</span><Amount value={subtotal + tax} currency={form.currency || undefined} strong /></div>
        </div>
        <label>Notes<textarea rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
