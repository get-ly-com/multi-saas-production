import Link from 'next/link';
import { useRouter } from 'next/router';
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
import PaymentLinkModal from '@/components/PaymentLinkModal';
import ReceiptReader from '@/components/ReceiptReader';
import Skeleton, { SkeletonStats, SkeletonTable } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import WriteOffForm from '@/components/WriteOffForm';
import { api, formatDate, money, today } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

const blankLine = { description: '', quantity: '1', unit_price: '', tax_rate_id: '' };
const blankInvoice = { customer_id: '', invoice_date: '', due_date: '', description: '', cost_center_id: '', currency: '', exchange_rate: '1', line_items: [blankLine] };
const blankExpense = { amount: '', category: '', description: '', expense_date: '', account_id: '', cost_center_id: '' };

const invoiceBalance = (invoice: any) =>
  Number(invoice.amount) - Number(invoice.amount_paid) - Number(invoice.amount_credited);

const lineNet = (line: any) => Number(line.quantity || 0) * Number(line.unit_price || 0);

const payable = (invoice: any) => invoice.status === 'sent' || invoice.status === 'partial';

const daysBetween = (from: string, to: string) =>
  Math.round((new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86400000);

// "Due in 3 days", "12 days overdue": only for invoices still waiting on money
const dueNote = (invoice: any) => {
  if (!payable(invoice) || !invoice.due_date) return '';
  const days = daysBetween(today(), invoice.due_date);
  if (days === 0) return 'Due today';
  if (days > 0) return days === 1 ? 'Due tomorrow' : `Due in ${days} days`;
  return -days === 1 ? '1 day overdue' : `${-days} days overdue`;
};

// One currency for a column total, or none when the rows mix currencies
const sharedCurrency = (rows: any[]) => {
  const codes = new Set(rows.map((row) => row.currency || ''));
  return codes.size === 1 ? Array.from(codes)[0] : null;
};

type Filter = 'all' | 'draft' | 'unpaid' | 'overdue' | 'paid';

const FILTERS: Record<Filter, (invoice: any) => boolean> = {
  all: () => true,
  draft: (invoice) => invoice.status === 'draft',
  unpaid: (invoice) => payable(invoice),
  overdue: (invoice) => isOverdue(invoice),
  paid: (invoice) => invoice.status === 'paid'
};

export default function Accounting() {
  return <AppShell><AccountingApp /></AppShell>;
}

function AccountingApp() {
  const router = useRouter();
  const account = useAccount();
  const canEdit = account?.canEdit !== false;
  const [tab, setTab] = useState<'invoices' | 'expenses'>('invoices');
  const [filter, setFilter] = useState<Filter>('all');
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
  const [linking, setLinking] = useState<any>(null);
  const [openId, setOpenId] = useState('');

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

  const newInvoice = () => setInvoiceForm({ ...blankInvoice, invoice_date: today() });
  const newExpense = () => {
    setTab('expenses');
    setExpenseForm(blankExpense);
  };

  // "?create=expense" (from the Create menu on other pages) opens the expense form here
  useEffect(() => {
    if (router.query.create !== 'expense' || loading) return;
    newExpense();
    router.replace('/saas/accounting', undefined, { shallow: true, scroll: false });
  }, [router.query.create, loading]);

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

  const remove = (path: string, label: string, title: string) => {
    if (window.confirm(`Delete this ${label}? This can't be undone.`)) {
      run(() => api.delete(path), title, 'It is gone for good.');
      setOpenId('');
    }
  };

  const voidInvoice = (invoice: any) => {
    if (window.confirm(`Void ${invoice.invoice_number}? Its ledger entries will be reversed.`)) {
      run(() => api.put(`/api/accounting/invoices/${invoice.id}`, { status: 'void' }), `${invoice.invoice_number} voided`, 'Its ledger entries were reversed. The customer no longer owes it.');
    }
  };

  const markSent = (invoice: any) =>
    run(() => api.put(`/api/accounting/invoices/${invoice.id}`, { status: 'sent' }), `${invoice.invoice_number} marked as sent`, `${money(invoice.amount, invoice.currency)} is now waiting on ${invoice.customer_name || 'the customer'}.`);

  const editInvoice = (invoice: any) => setInvoiceForm({ ...invoice, due_date: invoice.due_date || '', description: invoice.description || '' });

  // Opening a form from the drawer closes the drawer first, so only one panel is ever on top
  const fromDrawer = (open: () => void) => () => {
    setOpenId('');
    open();
  };

  const shown = invoices.filter(FILTERS[filter]);
  const counts = (Object.keys(FILTERS) as Filter[]).reduce((all, key) => ({ ...all, [key]: invoices.filter(FILTERS[key]).length }), {} as Record<Filter, number>);
  const listCurrency = sharedCurrency(shown);
  const openInvoice = invoices.find((invoice) => invoice.id === openId);

  return (
    <div className="stack">
      <AccountingNav />
      <PageHead title="Invoices and expenses" line="What customers owe you, what you spend, and how the month is going.">
        <CreateMenu
          label={tab === 'invoices' ? 'New invoice' : 'New expense'}
          onClick={tab === 'invoices' ? newInvoice : newExpense}
          items={[
            { label: 'Invoice', icon: 'invoice', hint: 'N then I', onClick: newInvoice },
            { label: 'Quote', icon: 'quote', href: '/saas/crm/quotes?new=1' },
            { label: 'Bill', icon: 'accounting', href: '/saas/accounting/bills?new=1' },
            { label: 'Expense', icon: 'money', onClick: newExpense }
          ]}
        />
      </PageHead>

      {error && <p className="error">{error}</p>}

      {!summary && loading ? <SkeletonStats count={6} /> : summary && (
        <div className="stats">
          <Stat label="Revenue" value={summary.revenue} />
          <Stat label="Customers owe you" value={summary.outstanding} />
          <Stat label="Overdue" value={summary.overdue} onClick={Number(summary.overdue) > 0 ? () => { setTab('invoices'); setFilter('overdue'); } : undefined} />
          <Stat label="You owe vendors" value={summary.payables} href="/saas/accounting/bills" />
          <Stat label="Expenses" value={summary.totalExpenses} />
          <Stat label="Net profit" value={summary.netProfit} />
        </div>
      )}

      <div className="tabs">
        <button className={tab === 'invoices' ? 'active' : ''} onClick={() => setTab('invoices')}>Invoices</button>
        <button className={tab === 'expenses' ? 'active' : ''} onClick={() => setTab('expenses')}>Expenses</button>
      </div>

      {tab === 'invoices' && !loading && invoices.length > 0 && (
        <FilterPills<Filter>
          label="Show invoices"
          value={filter}
          onChange={setFilter}
          options={[
            { id: 'all', label: 'All', count: counts.all },
            { id: 'draft', label: 'Drafts', count: counts.draft },
            { id: 'unpaid', label: 'Awaiting payment', count: counts.unpaid },
            { id: 'overdue', label: 'Overdue', count: counts.overdue },
            { id: 'paid', label: 'Paid', count: counts.paid }
          ]}
        />
      )}

      {loading ? <SkeletonTable rows={7} columns={6} /> : tab === 'invoices' ? (
        shown.length === 0 ? (
          <div className="card"><InvoicesEmpty filter={filter} hasAny={invoices.length > 0} onNew={canEdit ? newInvoice : undefined} onAll={() => setFilter('all')} /></div>
        ) : (
          <div className="card table-wrap">
            <table>
              <thead>
                <tr><th>Invoice</th><th>Customer</th><th>Due</th><th>Status</th><th className="num">Amount</th><th className="num">Balance</th><th /></tr>
              </thead>
              <tbody>
                {shown.map((invoice) => {
                  const note = dueNote(invoice);
                  return (
                    <tr key={invoice.id} {...rowOpener(() => setOpenId(invoice.id))}>
                      <td>
                        <button type="button" className={`${styles.rowTitle} always`} onClick={() => setOpenId(invoice.id)}>{invoice.invoice_number}</button>
                        <span className={styles.rowSub}>{formatDate(invoice.invoice_date)}</span>
                      </td>
                      <td className="wrap">{invoice.customer_name}</td>
                      <td>
                        {formatDate(invoice.due_date)}
                        {note && <span className={styles.rowSub} style={isOverdue(invoice) ? { color: 'var(--danger)' } : undefined}>{note}</span>}
                      </td>
                      <td><StatusPill status={shownStatus(invoice)} /></td>
                      <td className="num"><Amount value={invoice.amount} currency={invoice.currency} /></td>
                      <td className="num">
                        {invoice.status === 'void' || invoice.status === 'draft'
                          ? null
                          : <Amount value={invoiceBalance(invoice)} currency={invoice.currency} dim={invoiceBalance(invoice) <= 0} strong={isOverdue(invoice)} />}
                      </td>
                      <td>
                        <div className="row-actions">
                          {invoice.status === 'draft' && <button className="small" disabled={busy} onClick={() => markSent(invoice)}>Mark sent</button>}
                          {payable(invoice) && <button className="small" onClick={() => setPaying(invoice)}>Record payment</button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {listCurrency !== null && shown.length > 1 && (
                  <tr className={styles.totalRow}>
                    <td colSpan={4}>Total of {shown.length} invoices</td>
                    <td className="num"><Amount value={shown.reduce((sum, invoice) => sum + Number(invoice.amount), 0)} currency={listCurrency || undefined} strong /></td>
                    <td className="num"><Amount value={shown.filter((invoice) => invoice.status !== 'void' && invoice.status !== 'draft').reduce((sum, invoice) => sum + invoiceBalance(invoice), 0)} currency={listCurrency || undefined} strong /></td>
                    <td />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )
      ) : expenses.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="money"
            title="No expenses yet"
            line="Add a receipt and the amount and date fill themselves in."
            action={canEdit ? { label: 'New expense', onClick: newExpense } : undefined}
          />
        </div>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr><th>Date</th><th>Account</th><th>Category</th><th>Description</th><th className="num">Amount</th><th /></tr>
            </thead>
            <tbody>
              {expenses.map((expense) => (
                <tr key={expense.id}>
                  <td>{formatDate(expense.expense_date)}</td>
                  <td>{expense.account ? `${expense.account.code} ${expense.account.name}` : <span className="muted">General Expenses</span>}</td>
                  <td>{expense.category || <span className="muted">None</span>}</td>
                  <td className="wrap">{expense.description || <span className="muted">None</span>}</td>
                  <td className="num"><Amount value={expense.amount} /></td>
                  <td>
                    <div className="row-actions">
                      <button className="small" onClick={() => setExpenseForm({ ...expense, category: expense.category || '', description: expense.description || '' })}>Edit</button>
                      <button className="small danger" onClick={() => remove(`/api/accounting/expenses/${expense.id}`, 'expense', 'Expense deleted')}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
              {expenses.length > 1 && (
                <tr className={styles.totalRow}>
                  <td colSpan={4}>Total of {expenses.length} expenses</td>
                  <td className="num"><Amount value={expenses.reduce((sum, expense) => sum + Number(expense.amount), 0)} strong /></td>
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <InvoiceDrawer
        invoice={openInvoice}
        canEdit={canEdit}
        busy={busy}
        onClose={() => setOpenId('')}
        onPay={fromDrawer(() => setPaying(openInvoice))}
        onLink={fromDrawer(() => setLinking(openInvoice))}
        onCredit={fromDrawer(() => setCrediting(openInvoice))}
        onWriteOff={fromDrawer(() => setWritingOff(openInvoice))}
        onEdit={fromDrawer(() => editInvoice(openInvoice))}
        onSend={() => openInvoice && markSent(openInvoice)}
        onVoid={() => openInvoice && voidInvoice(openInvoice)}
        onDelete={() => openInvoice && remove(`/api/accounting/invoices/${openInvoice.id}`, 'invoice', `${openInvoice.invoice_number} deleted`)}
      />

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
      {linking && <PaymentLinkModal invoice={linking} onClose={() => setLinking(null)} />}
      {expenseForm && <ExpenseForm initial={expenseForm} accounts={accounts} costCenters={costCenters} onClose={() => setExpenseForm(null)} onSaved={load} />}
    </div>
  );
}

function InvoicesEmpty({ filter, hasAny, onNew, onAll }: { filter: Filter; hasAny: boolean; onNew?: () => void; onAll: () => void }) {
  const all = { label: 'See all invoices', onClick: onAll };
  if (!hasAny || filter === 'all') {
    return (
      <EmptyState
        icon="invoice"
        title="No invoices yet"
        line="Send your first one in under a minute. We keep track of who has paid."
        action={onNew ? { label: 'New invoice', onClick: onNew } : undefined}
      />
    );
  }
  if (filter === 'overdue') return <EmptyState tone="done" icon="paid" title="No overdue invoices. Nice work." line="Everyone has paid on time." secondary={all} />;
  if (filter === 'unpaid') return <EmptyState tone="done" icon="paid" title="Nothing waiting on payment" line="Every invoice you sent has been paid." secondary={all} />;
  if (filter === 'draft') return <EmptyState icon="invoice" title="No drafts" line="Every invoice has gone out." secondary={all} />;
  return <EmptyState icon="paid" title="No paid invoices yet" line="Invoices show up here once you record a payment." secondary={all} />;
}

// The invoice at a glance, with its main actions, so you can act without leaving the list
function InvoiceDrawer({ invoice, canEdit, busy, onClose, onPay, onLink, onCredit, onWriteOff, onEdit, onSend, onVoid, onDelete }: {
  invoice: any;
  canEdit: boolean;
  busy: boolean;
  onClose: () => void;
  onPay: () => void;
  onLink: () => void;
  onCredit: () => void;
  onWriteOff: () => void;
  onEdit: () => void;
  onSend: () => void;
  onVoid: () => void;
  onDelete: () => void;
}) {
  const [detail, setDetail] = useState<any>(null);
  const id = invoice?.id;

  // Payments and credit notes come with the full invoice
  useEffect(() => {
    if (!id) return;
    let current = true;
    setDetail(null);
    api.get(`/api/accounting/invoices/${id}`).then((data) => current && setDetail(data)).catch(() => current && setDetail(false));
    return () => { current = false; };
  }, [id, invoice?.status, invoice?.amount_paid, invoice?.amount_credited]);

  const balance = invoice ? invoiceBalance(invoice) : 0;
  const settledShare = invoice && Number(invoice.amount) > 0 ? (Number(invoice.amount_paid) + Number(invoice.amount_credited)) / Number(invoice.amount) : 0;
  const lines: any[] = invoice?.line_items || [];
  const payments: any[] = detail?.payments || [];
  const credits: any[] = detail?.credit_notes || [];
  const owing = invoice && payable(invoice) && balance > 0;

  return (
    <Drawer
      open={Boolean(invoice)}
      title={invoice?.invoice_number}
      subtitle={invoice?.customer_name}
      onClose={onClose}
      footer={invoice && (
        <>
          <span className={styles.footSpacer}>
            <Link href={`/saas/accounting/invoice/${invoice.id}`} className="button ghost">Open full page</Link>
          </span>
          {canEdit && invoice.status === 'draft' && <button className="primary" disabled={busy} onClick={onSend}>Mark sent</button>}
          {canEdit && owing && <button className="primary" onClick={onPay}>Record payment</button>}
        </>
      )}
    >
      {invoice && (
        <>
          <DrawerHero
            label={invoice.status === 'paid' ? 'Paid in full' : invoice.status === 'draft' ? 'Draft total' : 'Balance due'}
            value={<Amount value={invoice.status === 'paid' || invoice.status === 'draft' ? invoice.amount : invoice.status === 'void' ? 0 : balance} currency={invoice.currency} />}
            line={invoice.status === 'draft'
              ? 'Not sent yet. Mark it sent when it goes to the customer.'
              : invoice.status === 'void' ? 'This invoice was voided.'
              : `${money(Number(invoice.amount_paid) + Number(invoice.amount_credited), invoice.currency)} of ${money(invoice.amount, invoice.currency)} settled`}
            pill={<StatusPill status={shownStatus(invoice)} />}
            paidShare={invoice.status === 'draft' || invoice.status === 'void' ? undefined : settledShare}
          />

          <Facts items={[
            ['Customer', invoice.customer_name],
            ['Issued', formatDate(invoice.invoice_date)],
            ['Due', invoice.due_date ? <>{formatDate(invoice.due_date)}{dueNote(invoice) && <span className="muted"> · {dueNote(invoice)}</span>}</> : <span className="muted">No due date</span>],
            ['Currency', Number(invoice.exchange_rate) !== 1 ? `${invoice.currency} at ${Number(invoice.exchange_rate)}` : null],
            ['Notes', invoice.description ? <span style={{ whiteSpace: 'pre-wrap' }}>{invoice.description}</span> : null]
          ]} />

          {lines.length > 0 && (
            <DrawerSection title="Items">
              <table className={styles.mini}>
                <tbody>
                  {lines.map((line, index) => (
                    <tr key={index}>
                      <td className="wrap">{line.description}<span className={styles.rowSub}>{Number(line.quantity)} × {money(line.unit_price, invoice.currency)}</span></td>
                      <td className="num"><Amount value={Number(line.quantity) * Number(line.unit_price)} currency={invoice.currency} /></td>
                    </tr>
                  ))}
                  {Number(invoice.tax_amount) > 0 && (
                    <tr><td className="muted">Tax</td><td className="num"><Amount value={invoice.tax_amount} currency={invoice.currency} /></td></tr>
                  )}
                  <tr className="total"><td>Total</td><td className="num"><Amount value={invoice.amount} currency={invoice.currency} strong /></td></tr>
                </tbody>
              </table>
            </DrawerSection>
          )}

          {invoice.status !== 'draft' && (
            <DrawerSection title="Payments and credits">
              {detail === null ? (
                <div style={{ display: 'grid', gap: 8 }}><Skeleton height={14} /><Skeleton width="70%" height={14} /></div>
              ) : payments.length + credits.length === 0 ? (
                <p className="muted">Nothing received yet.</p>
              ) : (
                <table className={styles.mini}>
                  <tbody>
                    {payments.map((payment) => (
                      <tr key={payment.id}>
                        <td>
                          {formatDate(payment.payment_date)}
                          <span className={styles.rowSub}>{payment.is_write_off ? 'Written off' : `${payment.account?.code || ''} ${payment.account?.name || 'Payment'}`}{payment.reference ? ` · ${payment.reference}` : ''}</span>
                        </td>
                        <td className="num">{payment.voided_at ? <StatusPill status="void" /> : <Amount value={payment.amount} currency={invoice.currency} />}</td>
                      </tr>
                    ))}
                    {credits.map((credit) => (
                      <tr key={credit.id}>
                        <td>{formatDate(credit.credit_date)}<span className={styles.rowSub}>Credit note {credit.credit_number}</span></td>
                        <td className="num">{credit.voided_at ? <StatusPill status="void" /> : <Amount value={credit.amount} currency={invoice.currency} />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </DrawerSection>
          )}

          {canEdit && invoice.status !== 'void' && (
            <DrawerActions>
              {owing && <button onClick={onLink}>Get payment link</button>}
              {payable(invoice) && <button onClick={onCredit}>Credit note</button>}
              {payable(invoice) && <button onClick={onWriteOff}>Write off</button>}
              <button onClick={onEdit}>Edit</button>
              {invoice.status === 'draft' && <button className="danger" disabled={busy} onClick={onDelete}>Delete draft</button>}
              {invoice.status === 'sent' && <button className="danger" disabled={busy} onClick={onVoid}>Void</button>}
            </DrawerActions>
          )}
        </>
      )}
    </Drawer>
  );
}

function Stat({ label, value, onClick, href }: { label: string; value: number | string; onClick?: () => void; href?: string }) {
  const body = (
    <>
      <div className="stat-label">{label}</div>
      <div className="stat-value"><Amount value={value} /></div>
    </>
  );
  if (href) return <Link href={href} className="card stat-link">{body}</Link>;
  if (onClick) return <a href="#" className="card stat-link" onClick={(event) => { event.preventDefault(); onClick(); }}>{body}</a>;
  return <div className="card">{body}</div>;
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
        toast.success('Credit note issued', { detail: `${money(form.amount, invoice.currency)} taken off ${invoice.invoice_number}.` });
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
        const customer = customers.find(({ id }) => id === customer_id)?.name;
        if (form.id) toast.success('Invoice saved', { detail: `${form.invoice_number} is up to date.` });
        else toast.success('Draft invoice created', { detail: `${money(subtotal + tax, currency || undefined)} for ${customer || 'your customer'}. Mark it sent when it goes out.` });
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
        <FormTotals subtotal={subtotal} tax={tax} currency={form.currency || undefined} />
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
        toast.success(form.id ? 'Expense saved' : 'Expense added', { detail: `${money(amount)}${category ? ` for ${category}` : ''} is in the books.` });
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
        {!form.id && (
          <ReceiptReader onRead={(read) => setForm((current: any) => ({
            ...current,
            amount: read.total !== null ? String(read.total) : current.amount,
            expense_date: read.date || current.expense_date,
            description: current.description || (read.vendor ? `${read.vendor}${read.tax ? ` (includes ${read.tax} tax)` : ''}` : '')
          }))} />
        )}
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

// Subtotal, tax and total under the lines of an invoice form
function FormTotals({ subtotal, tax, currency }: { subtotal: number; tax: number; currency?: string }) {
  return (
    <div className="document-totals" style={{ margin: '12px 0 12px auto' }}>
      <div><span className="muted">Subtotal</span><Amount value={subtotal} currency={currency} /></div>
      <div><span className="muted">Tax</span><Amount value={tax} currency={currency} /></div>
      <div className="due"><span>Total</span><Amount value={subtotal + tax} currency={currency} strong /></div>
    </div>
  );
}
