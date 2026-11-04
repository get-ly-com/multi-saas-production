import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import AccountingNav from '@/components/AccountingNav';
import AppShell from '@/components/AppShell';
import CurrencyFields from '@/components/CurrencyFields';
import Modal from '@/components/Modal';
import PaymentForm from '@/components/PaymentForm';
import WriteOffForm from '@/components/WriteOffForm';
import { api, formatDate, money, today } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

const blankLine = { description: '', quantity: '1', unit_price: '', tax_rate_id: '' };
const blankInvoice = { customer_id: '', invoice_date: '', due_date: '', description: '', cost_center_id: '', currency: '', exchange_rate: '1', line_items: [blankLine] };
const blankExpense = { amount: '', category: '', description: '', expense_date: '', account_id: '', cost_center_id: '' };

const invoiceBalance = (invoice: any) =>
  Number(invoice.amount) - Number(invoice.amount_paid) - Number(invoice.amount_credited);

const lineNet = (line: any) => Number(line.quantity || 0) * Number(line.unit_price || 0);

export default function Accounting() {
  return <AppShell><AccountingApp /></AppShell>;
}

function AccountingApp() {
  const [tab, setTab] = useState<'invoices' | 'expenses'>('invoices');
  const [invoices, setInvoices] = useState<any[]>([]);
  const [expenses, setExpenses] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [taxRates, setTaxRates] = useState<any[]>([]);
  const [costCenters, setCostCenters] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [invoiceForm, setInvoiceForm] = useState<any>(null);
  const [expenseForm, setExpenseForm] = useState<any>(null);
  const [paying, setPaying] = useState<any>(null);
  const [crediting, setCrediting] = useState<any>(null);
  const [writingOff, setWritingOff] = useState<any>(null);

  const load = async () => {
    try {
      const [invoiceRows, expenseRows, analytics, accountRows, customerRows, rateRows, centerRows] = await Promise.all([
        api.get('/api/accounting/invoices'),
        api.get('/api/accounting/expenses'),
        api.get('/api/accounting/analytics'),
        api.get('/api/accounting/accounts'),
        api.get('/api/accounting/customers'),
        api.get('/api/accounting/tax-rates'),
        api.get('/api/accounting/cost-centers')
      ]);
      setInvoices(invoiceRows);
      setExpenses(expenseRows);
      setSummary(analytics);
      setCustomers(customerRows);
      setTaxRates(rateRows);
      setCostCenters(centerRows);
      setAccounts(accountRows.filter((account: any) => account.type === 'expense' && account.is_active));
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
  const run = (action: () => Promise<unknown>) => once(async () => {
    try {
      await action();
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  });

  const remove = (path: string, label: string) => {
    if (window.confirm(`Delete this ${label}? This can't be undone.`)) {
      run(() => api.delete(path));
    }
  };

  const voidInvoice = (invoice: any) => {
    if (window.confirm(`Void ${invoice.invoice_number}? Its ledger entries will be reversed.`)) {
      run(() => api.put(`/api/accounting/invoices/${invoice.id}`, { status: 'void' }));
    }
  };

  return (
    <div className="stack">
      <AccountingNav />
      <div className="page-head">
        <h1>Invoices and expenses</h1>
        {tab === 'invoices'
          ? <button className="primary" onClick={() => setInvoiceForm({ ...blankInvoice, invoice_date: today() })}>New invoice</button>
          : <button className="primary" onClick={() => setExpenseForm(blankExpense)}>New expense</button>}
      </div>

      {error && <p className="error">{error}</p>}

      {summary && (
        <div className="stats">
          <Stat label="Revenue" value={money(summary.revenue)} />
          <Stat label="Customers owe you" value={money(summary.outstanding)} />
          <Stat label="Overdue" value={money(summary.overdue)} />
          <Stat label="You owe vendors" value={money(summary.payables)} />
          <Stat label="Expenses" value={money(summary.totalExpenses)} />
          <Stat label="Net profit" value={money(summary.netProfit)} />
        </div>
      )}

      <div className="tabs">
        <button className={tab === 'invoices' ? 'active' : ''} onClick={() => setTab('invoices')}>Invoices</button>
        <button className={tab === 'expenses' ? 'active' : ''} onClick={() => setTab('expenses')}>Expenses</button>
      </div>

      <div className="card table-wrap">
        {loading ? <p className="empty">Loading…</p> : tab === 'invoices' ? (
          <table>
            <thead>
              <tr><th>Invoice</th><th>Customer</th><th>Due</th><th>Status</th><th className="num">Amount</th><th className="num">Balance</th><th /></tr>
            </thead>
            <tbody>
              {invoices.length === 0 && <tr><td colSpan={7} className="empty">No invoices yet</td></tr>}
              {invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td><Link href={`/saas/accounting/invoice/${invoice.id}`}>{invoice.invoice_number}</Link></td>
                  <td className="wrap">{invoice.customer_name}</td>
                  <td>{formatDate(invoice.due_date)}</td>
                  <td><span className={`badge ${invoice.status}`}>{invoice.status}</span></td>
                  <td className="num">{money(invoice.amount, invoice.currency)}</td>
                  <td className="num">{invoice.status === 'void' || invoice.status === 'draft' ? '—' : money(invoiceBalance(invoice), invoice.currency)}</td>
                  <td>
                    <div className="row-actions">
                      {invoice.status === 'draft' && (
                        <button onClick={() => run(() => api.put(`/api/accounting/invoices/${invoice.id}`, { status: 'sent' }))}>Mark sent</button>
                      )}
                      {(invoice.status === 'sent' || invoice.status === 'partial') && (
                        <>
                          <button onClick={() => setPaying(invoice)}>Record payment</button>
                          <button onClick={() => setCrediting(invoice)}>Credit note</button>
                          <button onClick={() => setWritingOff(invoice)}>Write off</button>
                        </>
                      )}
                      {invoice.status !== 'void' && (
                        <button onClick={() => setInvoiceForm({ ...invoice, due_date: invoice.due_date || '', description: invoice.description || '' })}>Edit</button>
                      )}
                      {invoice.status === 'draft' && (
                        <button className="danger" onClick={() => remove(`/api/accounting/invoices/${invoice.id}`, 'invoice')}>Delete</button>
                      )}
                      {invoice.status === 'sent' && (
                        <button className="danger" onClick={() => voidInvoice(invoice)}>Void</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table>
            <thead>
              <tr><th>Date</th><th>Account</th><th>Category</th><th>Description</th><th className="num">Amount</th><th /></tr>
            </thead>
            <tbody>
              {expenses.length === 0 && <tr><td colSpan={6} className="empty">No expenses yet</td></tr>}
              {expenses.map((expense) => (
                <tr key={expense.id}>
                  <td>{formatDate(expense.expense_date)}</td>
                  <td>{expense.account ? `${expense.account.code} ${expense.account.name}` : '—'}</td>
                  <td>{expense.category || '—'}</td>
                  <td className="wrap">{expense.description || '—'}</td>
                  <td className="num">{money(expense.amount)}</td>
                  <td>
                    <div className="row-actions">
                      <button onClick={() => setExpenseForm({ ...expense, category: expense.category || '', description: expense.description || '' })}>Edit</button>
                      <button className="danger" onClick={() => remove(`/api/accounting/expenses/${expense.id}`, 'expense')}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {invoiceForm && <InvoiceForm initial={invoiceForm} customers={customers} taxRates={taxRates} costCenters={costCenters} onClose={() => setInvoiceForm(null)} onSaved={load} />}
      {paying && (
        <PaymentForm
          target={{ invoice_id: paying.id }}
          label={paying.invoice_number}
          balance={invoiceBalance(paying)}
          currency={paying.currency}
          onClose={() => setPaying(null)}
          onSaved={load}
        />
      )}
      {crediting && <CreditForm invoice={crediting} onClose={() => setCrediting(null)} onSaved={load} />}
      {writingOff && <WriteOffForm invoice={writingOff} onClose={() => setWritingOff(null)} onSaved={load} />}
      {expenseForm && <ExpenseForm initial={expenseForm} accounts={accounts} costCenters={costCenters} onClose={() => setExpenseForm(null)} onSaved={load} />}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

function CreditForm({ invoice, onClose, onSaved }: { invoice: any; onClose: () => void; onSaved: () => void }) {
  const balance = invoiceBalance(invoice);
  const [form, setForm] = useState({ amount: balance.toFixed(2), credit_date: today(), reason: '' });
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm({ ...form, [field]: value });

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api.post('/api/accounting/credit-notes', { invoice_id: invoice.id, ...form });
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title={`Credit note for ${invoice.invoice_number}`} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="muted">Balance {money(balance, invoice.currency)}</p>
        <div className="form-grid">
          <label>Amount<input required type="number" min="0.01" step="0.01" max={balance} value={form.amount} onChange={(e) => set('amount', e.target.value)} /></label>
          <label>Date<input required type="date" value={form.credit_date} onChange={(e) => set('credit_date', e.target.value)} /></label>
        </div>
        <label style={{ marginTop: 12 }}>Reason<textarea required rows={2} value={form.reason} onChange={(e) => set('reason', e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">Issue credit note</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function CostCenterSelect({ value, costCenters, onChange }: { value: string; costCenters: any[]; onChange: (value: string) => void }) {
  return (
    <label>Cost center
      <select value={value || ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">None</option>
        {costCenters.filter((center) => center.is_active || center.id === value).map((center) => (
          <option key={center.id} value={center.id}>{center.code} {center.name}</option>
        ))}
      </select>
    </label>
  );
}

function InvoiceForm({ initial, customers, taxRates, costCenters, onClose, onSaved }: { initial: any; customers: any[]; taxRates: any[]; costCenters: any[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<any>(initial);
  const [error, setError] = useState('');
  const set = (field: string, value: unknown) => setForm({ ...form, [field]: value });

  const setLine = (index: number, field: string, value: string) =>
    set('line_items', form.line_items.map((line: any, i: number) => (i === index ? { ...line, [field]: value } : line)));

  const subtotal = form.line_items.reduce((sum: number, line: any) => sum + lineNet(line), 0);
  const tax = form.line_items.reduce((sum: number, line: any) => {
    const rate = taxRates.find(({ id }) => id === line.tax_rate_id);
    return sum + Math.round(lineNet(line) * Number(rate?.rate || 0)) / 100;
  }, 0);

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      const { customer_id, invoice_date, due_date, description, line_items, cost_center_id, currency, exchange_rate } = form;
      const body = { customer_id, invoice_date, due_date, description, line_items, cost_center_id, currency, exchange_rate };
      try {
        if (form.id) await api.put(`/api/accounting/invoices/${form.id}`, body);
        else await api.post('/api/accounting/invoices', body);
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title={form.id ? `Edit ${form.invoice_number}` : 'New invoice'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Customer
            <select required disabled={form.id && form.status !== 'draft'} value={form.customer_id} onChange={(e) => set('customer_id', e.target.value)}>
              <option value="">Choose a customer</option>
              {customers.filter((customer) => customer.is_active || customer.id === form.customer_id).map((customer) => (
                <option key={customer.id} value={customer.id}>{customer.name}</option>
              ))}
            </select>
          </label>
          <label>Invoice date<input required type="date" value={form.invoice_date} onChange={(e) => set('invoice_date', e.target.value)} /></label>
          <label>Due date<input type="date" value={form.due_date} onChange={(e) => set('due_date', e.target.value)} /></label>
          <CostCenterSelect value={form.cost_center_id} costCenters={costCenters} onChange={(value) => set('cost_center_id', value)} />
          <CurrencyFields
            currency={form.currency}
            rate={form.exchange_rate}
            locked={Boolean(form.id) && Number(form.amount_paid) + Number(form.amount_credited) > 0}
            onChange={(currency, exchange_rate) => setForm((current: any) => ({ ...current, currency, exchange_rate }))}
          />
        </div>
        {customers.length === 0 && <p className="muted"><Link href="/saas/accounting/customers">Add your first customer</Link> to create an invoice.</p>}
        <div className="lines">
          {form.line_items.map((line: any, index: number) => (
            <div className="line" key={index}>
              <input required aria-label="Description" placeholder="Description" value={line.description} onChange={(e) => setLine(index, 'description', e.target.value)} />
              <input required aria-label="Quantity" type="number" min="0.01" step="0.01" value={line.quantity} onChange={(e) => setLine(index, 'quantity', e.target.value)} />
              <input required aria-label="Unit price" placeholder="Price" type="number" min="0" step="any" value={line.unit_price} onChange={(e) => setLine(index, 'unit_price', e.target.value)} />
              <select aria-label="Tax" value={line.tax_rate_id || ''} onChange={(e) => setLine(index, 'tax_rate_id', e.target.value)}>
                <option value="">No tax</option>
                {taxRates.filter((rate) => rate.is_active || rate.id === line.tax_rate_id).map((rate) => (
                  <option key={rate.id} value={rate.id}>{rate.name}</option>
                ))}
              </select>
              <button type="button" aria-label="Remove line" disabled={form.line_items.length === 1} onClick={() => set('line_items', form.line_items.filter((_: any, i: number) => i !== index))}>×</button>
            </div>
          ))}
        </div>
        <button type="button" onClick={() => set('line_items', [...form.line_items, blankLine])}>Add line</button>
        <p>Subtotal {money(subtotal, form.currency || undefined)} · Tax {money(tax, form.currency || undefined)} · Total: <strong>{money(subtotal + tax, form.currency || undefined)}</strong></p>
        <label>Notes<textarea rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function ExpenseForm({ initial, accounts, costCenters, onClose, onSaved }: { initial: any; accounts: any[]; costCenters: any[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<any>(initial);
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm({ ...form, [field]: value });

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      const { amount, category, description, expense_date, account_id, cost_center_id } = form;
      const body = { amount, category, description, expense_date, account_id, cost_center_id };
      try {
        if (form.id) await api.put(`/api/accounting/expenses/${form.id}`, body);
        else await api.post('/api/accounting/expenses', body);
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title={form.id ? 'Edit expense' : 'New expense'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Amount<input required type="number" min="0" step="0.01" value={form.amount} onChange={(e) => set('amount', e.target.value)} /></label>
          <label>Date<input type="date" value={form.expense_date} onChange={(e) => set('expense_date', e.target.value)} /></label>
          <label>Account
            <select value={form.account_id || ''} onChange={(e) => set('account_id', e.target.value)}>
              <option value="">General Expenses</option>
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.code} {account.name}</option>)}
            </select>
          </label>
          <label>Category<input value={form.category} onChange={(e) => set('category', e.target.value)} /></label>
          <CostCenterSelect value={form.cost_center_id} costCenters={costCenters} onChange={(value) => set('cost_center_id', value)} />
        </div>
        <label style={{ marginTop: 12 }}>Description<textarea rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
