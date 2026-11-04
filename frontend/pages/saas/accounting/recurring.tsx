import { FormEvent, useEffect, useState } from 'react';
import AccountingNav from '@/components/AccountingNav';
import AppShell from '@/components/AppShell';
import CurrencyFields from '@/components/CurrencyFields';
import Modal from '@/components/Modal';
import { api, formatDate, money, today } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

const blankLine = { description: '', quantity: '1', unit_price: '', tax_rate_id: '' };
const blankPlan = {
  name: '', customer_id: '', frequency: 'monthly', start_date: '', end_date: '', due_days: '30',
  currency: '', exchange_rate: '1', cost_center_id: '', auto_send: false, line_items: [blankLine]
};

export default function Recurring() {
  return <AppShell><RecurringApp /></AppShell>;
}

function RecurringApp() {
  const [plans, setPlans] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [taxRates, setTaxRates] = useState<any[]>([]);
  const [costCenters, setCostCenters] = useState<any[]>([]);
  const [through, setThrough] = useState(today());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState<any>(null);

  const load = async () => {
    try {
      const [planRows, customerRows, rateRows, centerRows] = await Promise.all([
        api.get('/api/accounting/recurring'),
        api.get('/api/accounting/customers'),
        api.get('/api/accounting/tax-rates'),
        api.get('/api/accounting/cost-centers')
      ]);
      setPlans(planRows);
      setCustomers(customerRows);
      setTaxRates(rateRows);
      setCostCenters(centerRows);
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
  const generate = () => once(async () => {
    try {
      const created = await api.post('/api/accounting/recurring/run', { through });
      setNotice(created ? `Created ${created} invoice(s).` : 'Nothing is due yet.');
      await load();
    } catch (err: any) {
      setNotice('');
      setError(err.message);
    }
  });

  const setActive = (plan: any, is_active: boolean) => once(async () => {
    try {
      await api.put(`/api/accounting/recurring/${plan.id}/active`, { is_active });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  });

  return (
    <div className="stack">
      <AccountingNav />
      <div className="page-head">
        <h1>Recurring invoices</h1>
        <button className="primary" onClick={() => setForm({ ...blankPlan, start_date: today() })}>New recurring invoice</button>
      </div>

      <p className="muted">Invoices are created when you run this. Nothing goes out by itself, and no email is sent.</p>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="card">
        <div className="report-filters">
          <label>Create invoices due through<input type="date" value={through} onChange={(e) => setThrough(e.target.value)} /></label>
        </div>
        <div className="form-actions"><button className="primary" disabled={!through} onClick={generate}>Create due invoices</button></div>
      </div>

      <div className="card table-wrap">
        {loading ? <p className="empty">Loading…</p> : (
          <table>
            <thead><tr><th>Name</th><th>Customer</th><th>Every</th><th>From</th><th>Created</th><th>Status</th><th /></tr></thead>
            <tbody>
              {plans.length === 0 && <tr><td colSpan={7} className="empty">No recurring invoices yet</td></tr>}
              {plans.map((plan) => (
                <tr key={plan.id}>
                  <td className="wrap">{plan.name}</td>
                  <td className="wrap">{plan.customer?.name}</td>
                  <td>{plan.frequency}</td>
                  <td>{formatDate(plan.start_date)}</td>
                  <td>{plan.runs_done}</td>
                  <td><span className="badge">{plan.is_active ? 'active' : 'paused'}</span></td>
                  <td>
                    <div className="row-actions">
                      <button onClick={() => setForm({ ...plan, end_date: plan.end_date || '', cost_center_id: plan.cost_center_id || '' })}>Edit</button>
                      <button disabled={busy} onClick={() => setActive(plan, !plan.is_active)}>{plan.is_active ? 'Pause' : 'Resume'}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {form && <PlanForm initial={form} customers={customers} taxRates={taxRates} costCenters={costCenters} onClose={() => setForm(null)} onSaved={load} />}
    </div>
  );
}

function PlanForm({ initial, customers, taxRates, costCenters, onClose, onSaved }: { initial: any; customers: any[]; taxRates: any[]; costCenters: any[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<any>(initial);
  const [error, setError] = useState('');
  const set = (field: string, value: unknown) => setForm({ ...form, [field]: value });

  const setLine = (index: number, field: string, value: string) =>
    set('line_items', form.line_items.map((line: any, i: number) => (i === index ? { ...line, [field]: value } : line)));

  const total = form.line_items.reduce((sum: number, line: any) => sum + Number(line.quantity || 0) * Number(line.unit_price || 0), 0);

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api.post('/api/accounting/recurring', form);
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title={form.id ? `Edit ${form.name}` : 'New recurring invoice'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Name<input required value={form.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label>Customer
            <select required value={form.customer_id} onChange={(e) => set('customer_id', e.target.value)}>
              <option value="">Choose a customer</option>
              {customers.filter((customer) => customer.is_active || customer.id === form.customer_id).map((customer) => (
                <option key={customer.id} value={customer.id}>{customer.name}</option>
              ))}
            </select>
          </label>
          <label>Every
            <select value={form.frequency} onChange={(e) => set('frequency', e.target.value)}>
              <option value="monthly">Month</option>
              <option value="quarterly">Quarter</option>
              <option value="yearly">Year</option>
            </select>
          </label>
          <label>First invoice<input required disabled={form.runs_done > 0} type="date" value={form.start_date} onChange={(e) => set('start_date', e.target.value)} /></label>
          <label>Last date<input type="date" value={form.end_date} onChange={(e) => set('end_date', e.target.value)} /></label>
          <label>Due after (days)<input type="number" min="0" value={form.due_days} onChange={(e) => set('due_days', e.target.value)} /></label>
          <label>Cost center
            <select value={form.cost_center_id} onChange={(e) => set('cost_center_id', e.target.value)}>
              <option value="">None</option>
              {costCenters.filter((center) => center.is_active || center.id === form.cost_center_id).map((center) => (
                <option key={center.id} value={center.id}>{center.code} {center.name}</option>
              ))}
            </select>
          </label>
          <CurrencyFields
            currency={form.currency}
            rate={form.exchange_rate}
            locked={false}
            onChange={(currency, exchange_rate) => setForm((current: any) => ({ ...current, currency, exchange_rate }))}
          />
        </div>
        <div className="lines">
          {form.line_items.map((line: any, index: number) => (
            <div className="line" key={index}>
              <input required aria-label="Description" placeholder="Description" value={line.description} onChange={(e) => setLine(index, 'description', e.target.value)} />
              <input required aria-label="Quantity" type="number" min="0.01" step="0.01" value={line.quantity} onChange={(e) => setLine(index, 'quantity', e.target.value)} />
              <input required aria-label="Unit price" placeholder="Price" type="number" min="0" step="0.01" value={line.unit_price} onChange={(e) => setLine(index, 'unit_price', e.target.value)} />
              <select aria-label="Tax" value={line.tax_rate_id || ''} onChange={(e) => setLine(index, 'tax_rate_id', e.target.value)}>
                <option value="">No tax</option>
                {taxRates.filter((rate) => rate.is_active || rate.id === line.tax_rate_id).map((rate) => <option key={rate.id} value={rate.id}>{rate.name}</option>)}
              </select>
              <button type="button" aria-label="Remove line" disabled={form.line_items.length === 1} onClick={() => set('line_items', form.line_items.filter((_: any, i: number) => i !== index))}>×</button>
            </div>
          ))}
        </div>
        <button type="button" onClick={() => set('line_items', [...form.line_items, blankLine])}>Add line</button>
        <p>Before tax: <strong>{money(total, form.currency || undefined)}</strong></p>
        <label className="check">
          <input type="checkbox" checked={form.auto_send} onChange={(e) => set('auto_send', e.target.checked)} />
          Mark invoices as sent straight away, which posts them to the ledger
        </label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
