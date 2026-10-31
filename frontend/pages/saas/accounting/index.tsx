import { FormEvent, useEffect, useState } from 'react';
import AccountingNav from '@/components/AccountingNav';
import AppShell from '@/components/AppShell';
import Modal from '@/components/Modal';
import { api, formatDate, money } from '@/lib/api';

const blankLine = { description: '', quantity: '1', unit_price: '' };
const blankInvoice = { customer_name: '', customer_email: '', due_date: '', description: '', line_items: [blankLine] };
const blankExpense = { amount: '', category: '', description: '', expense_date: '', account_id: '' };

const lineTotal = (lines: any[]) =>
  lines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unit_price || 0), 0);

export default function Accounting() {
  return <AppShell><AccountingApp /></AppShell>;
}

function AccountingApp() {
  const [tab, setTab] = useState<'invoices' | 'expenses'>('invoices');
  const [invoices, setInvoices] = useState<any[]>([]);
  const [expenses, setExpenses] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [invoiceForm, setInvoiceForm] = useState<any>(null);
  const [expenseForm, setExpenseForm] = useState<any>(null);

  const load = async () => {
    try {
      const [invoiceRows, expenseRows, analytics, accountRows] = await Promise.all([
        api.get('/api/accounting/invoices'),
        api.get('/api/accounting/expenses'),
        api.get('/api/accounting/analytics'),
        api.get('/api/accounting/accounts')
      ]);
      setInvoices(invoiceRows);
      setExpenses(expenseRows);
      setSummary(analytics);
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

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

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
          ? <button className="primary" onClick={() => setInvoiceForm(blankInvoice)}>New invoice</button>
          : <button className="primary" onClick={() => setExpenseForm(blankExpense)}>New expense</button>}
      </div>

      {error && <p className="error">{error}</p>}

      {summary && (
        <div className="stats">
          <Stat label="Revenue (paid)" value={money(summary.revenue)} />
          <Stat label="Outstanding" value={money(summary.outstanding)} />
          <Stat label="Overdue" value={money(summary.overdue)} />
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
              <tr><th>Invoice</th><th>Customer</th><th>Due</th><th>Status</th><th className="num">Amount</th><th /></tr>
            </thead>
            <tbody>
              {invoices.length === 0 && <tr><td colSpan={6} className="empty">No invoices yet</td></tr>}
              {invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td>{invoice.invoice_number}</td>
                  <td className="wrap">{invoice.customer_name}</td>
                  <td>{formatDate(invoice.due_date)}</td>
                  <td><span className={`badge ${invoice.status}`}>{invoice.status}</span></td>
                  <td className="num">{money(invoice.amount)}</td>
                  <td>
                    <div className="row-actions">
                      {invoice.status === 'draft' && (
                        <button onClick={() => run(() => api.put(`/api/accounting/invoices/${invoice.id}`, { status: 'sent' }))}>Mark sent</button>
                      )}
                      {invoice.status === 'sent' && (
                        <button onClick={() => run(() => api.put(`/api/accounting/invoices/${invoice.id}`, { status: 'paid' }))}>Mark paid</button>
                      )}
                      <button onClick={() => setInvoiceForm({ ...invoice, due_date: invoice.due_date || '', customer_email: invoice.customer_email || '', description: invoice.description || '' })}>Edit</button>
                      {invoice.status === 'draft' && (
                        <button className="danger" onClick={() => remove(`/api/accounting/invoices/${invoice.id}`, 'invoice')}>Delete</button>
                      )}
                      {(invoice.status === 'sent' || invoice.status === 'paid') && (
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

      {invoiceForm && <InvoiceForm initial={invoiceForm} onClose={() => setInvoiceForm(null)} onSaved={load} />}
      {expenseForm && <ExpenseForm initial={expenseForm} accounts={accounts} onClose={() => setExpenseForm(null)} onSaved={load} />}
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

function InvoiceForm({ initial, onClose, onSaved }: { initial: any; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<any>(initial);
  const [error, setError] = useState('');
  const set = (field: string, value: unknown) => setForm({ ...form, [field]: value });

  const setLine = (index: number, field: string, value: string) =>
    set('line_items', form.line_items.map((line: any, i: number) => (i === index ? { ...line, [field]: value } : line)));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const { customer_name, customer_email, due_date, description, line_items } = form;
    const body = { customer_name, customer_email, due_date, description, line_items };
    try {
      if (form.id) await api.put(`/api/accounting/invoices/${form.id}`, body);
      else await api.post('/api/accounting/invoices', body);
      await onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title={form.id ? `Edit ${form.invoice_number}` : 'New invoice'}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Customer<input required value={form.customer_name} onChange={(e) => set('customer_name', e.target.value)} /></label>
          <label>Customer email<input type="email" value={form.customer_email} onChange={(e) => set('customer_email', e.target.value)} /></label>
          <label>Due date<input type="date" value={form.due_date} onChange={(e) => set('due_date', e.target.value)} /></label>
        </div>
        <div className="lines">
          {form.line_items.map((line: any, index: number) => (
            <div className="line" key={index}>
              <input required aria-label="Description" placeholder="Description" value={line.description} onChange={(e) => setLine(index, 'description', e.target.value)} />
              <input required aria-label="Quantity" type="number" min="0.01" step="0.01" value={line.quantity} onChange={(e) => setLine(index, 'quantity', e.target.value)} />
              <input required aria-label="Unit price" placeholder="Price" type="number" min="0" step="0.01" value={line.unit_price} onChange={(e) => setLine(index, 'unit_price', e.target.value)} />
              <button type="button" aria-label="Remove line" disabled={form.line_items.length === 1} onClick={() => set('line_items', form.line_items.filter((_: any, i: number) => i !== index))}>×</button>
            </div>
          ))}
        </div>
        <button type="button" onClick={() => set('line_items', [...form.line_items, blankLine])}>Add line</button>
        <p>Total: <strong>{money(lineTotal(form.line_items))}</strong></p>
        <label>Notes<textarea rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function ExpenseForm({ initial, accounts, onClose, onSaved }: { initial: any; accounts: any[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<any>(initial);
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm({ ...form, [field]: value });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const { amount, category, description, expense_date, account_id } = form;
    const body = { amount, category, description, expense_date, account_id };
    try {
      if (form.id) await api.put(`/api/accounting/expenses/${form.id}`, body);
      else await api.post('/api/accounting/expenses', body);
      await onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title={form.id ? 'Edit expense' : 'New expense'}>
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
        </div>
        <label style={{ marginTop: 12 }}>Description<textarea rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
