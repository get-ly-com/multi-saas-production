import { FormEvent, useEffect, useState } from 'react';
import AccountingNav from '@/components/AccountingNav';
import AppShell from '@/components/AppShell';
import Modal from '@/components/Modal';
import { api, formatDate, money, today } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

export default function Revenue() {
  return <AppShell><RevenueApp /></AppShell>;
}

function RevenueApp() {
  const [schedules, setSchedules] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [through, setThrough] = useState(today());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(false);

  const load = async () => {
    try {
      const [scheduleRows, invoiceRows] = await Promise.all([
        api.get('/api/accounting/revenue'),
        api.get('/api/accounting/invoices')
      ]);
      setSchedules(scheduleRows);
      const taken = new Set(scheduleRows.filter((row: any) => row.status !== 'cancelled').map((row: any) => row.invoice_id));
      setInvoices(invoiceRows.filter((invoice: any) => ['sent', 'partial', 'paid'].includes(invoice.status) && !taken.has(invoice.id)));
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
  const recognize = () => once(async () => {
    try {
      const posted = await api.post('/api/accounting/revenue/run', { through });
      setNotice(posted ? `Posted ${posted} month(s) of revenue.` : 'Nothing new to post. Only finished months are earned.');
      await load();
    } catch (err: any) {
      setNotice('');
      setError(err.message);
    }
  });

  const cancel = (schedule: any) => once(async () => {
    if (!window.confirm(`Cancel the schedule for ${schedule.invoice_number}? Whatever is left is earned today.`)) return;
    try {
      await api.post(`/api/accounting/revenue/${schedule.id}/cancel`, {});
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  });

  return (
    <div className="stack">
      <AccountingNav />
      <div className="page-head">
        <h1>Revenue schedules</h1>
        <button className="primary" onClick={() => setAdding(true)}>New schedule</button>
      </div>

      <p className="muted">For work delivered over time, such as a yearly subscription. The sale moves to Deferred Revenue, then is earned evenly month by month.</p>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="card">
        <div className="report-filters">
          <label>Recognize through<input type="date" value={through} onChange={(e) => setThrough(e.target.value)} /></label>
        </div>
        <div className="form-actions"><button className="primary" disabled={!through} onClick={recognize}>Recognize revenue</button></div>
      </div>

      <div className="card table-wrap">
        {loading ? <p className="empty">Loading…</p> : (
          <table>
            <thead>
              <tr><th>Invoice</th><th>Customer</th><th>From</th><th>Months</th><th className="num">Total</th><th className="num">Earned</th><th className="num">Deferred</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {schedules.length === 0 && <tr><td colSpan={9} className="empty">No revenue schedules yet</td></tr>}
              {schedules.map((schedule) => (
                <tr key={schedule.id}>
                  <td>{schedule.invoice_number}</td>
                  <td className="wrap">{schedule.customer_name}</td>
                  <td>{formatDate(schedule.start_date)}</td>
                  <td>{schedule.months}</td>
                  <td className="num">{money(schedule.total)}</td>
                  <td className="num">{money(schedule.earned)}</td>
                  <td className="num">{money(schedule.deferred)}</td>
                  <td><span className="badge">{schedule.status}</span></td>
                  <td>
                    {schedule.status === 'active' && (
                      <div className="row-actions"><button disabled={busy} className="danger" onClick={() => cancel(schedule)}>Cancel</button></div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {adding && <ScheduleForm invoices={invoices} onClose={() => setAdding(false)} onSaved={load} />}
    </div>
  );
}

function ScheduleForm({ invoices, onClose, onSaved }: { invoices: any[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ invoice_id: '', start_date: today(), months: '12' });
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm({ ...form, [field]: value });

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api.post('/api/accounting/revenue', form);
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title="New revenue schedule" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Invoice
            <select required value={form.invoice_id} onChange={(e) => set('invoice_id', e.target.value)}>
              <option value="">Choose an invoice</option>
              {invoices.map((invoice) => (
                <option key={invoice.id} value={invoice.id}>{invoice.invoice_number} · {invoice.customer_name}</option>
              ))}
            </select>
          </label>
          <label>First month<input required type="date" value={form.start_date} onChange={(e) => set('start_date', e.target.value)} /></label>
          <label>Months<input required type="number" min="1" value={form.months} onChange={(e) => set('months', e.target.value)} /></label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
