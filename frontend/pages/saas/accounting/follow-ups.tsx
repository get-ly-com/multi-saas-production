import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import { Amount, PageHead } from '@/components/AccountingKit';
import AccountingNav from '@/components/AccountingNav';
import AppShell from '@/components/AppShell';
import EmptyState from '@/components/EmptyState';
import Modal from '@/components/Modal';
import { SkeletonStats, SkeletonTable } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api, formatDate, money, today } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

const addDays = (days: number) => {
  const date = new Date(`${today()}T00:00:00`);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

// Fills in a step's message for one customer
const fillMessage = (template: string, row: any, company: string, currency: string) => {
  const invoices = row.invoices.map((invoice: any) =>
    `- ${invoice.invoice_number}, due ${formatDate(invoice.due_date || invoice.invoice_date)}: ${money(invoice.balance, invoice.currency)} (${invoice.days} days overdue)`
  ).join('\n');
  const values: Record<string, string> = {
    customer: row.name,
    company,
    total: money(row.overdue_total, currency),
    invoices,
    days: String(row.oldest_days)
  };
  return template.replace(/\{(customer|company|total|invoices|days)\}/g, (_, key) => values[key]);
};

const subjectFor = (row: any, company: string) => `${row.level_name || 'Payment reminder'}: overdue invoices from ${company}`;

export default function FollowUps() {
  return <AppShell><FollowUpsApp /></AppShell>;
}

function FollowUpsApp() {
  const [data, setData] = useState<any>(null);
  const [company, setCompany] = useState('');
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState('');
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [editingSteps, setEditingSteps] = useState(false);

  const load = async () => {
    try {
      setData(await api.get('/api/accounting/follow-ups'));
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
    api.get('/api/me').then((me) => setCompany(me.tenant.name)).catch((err) => setError(err.message));
  }, []);

  if (!data) return <div className="stack"><AccountingNav />{error ? <p className="error">{error}</p> : <><SkeletonStats count={3} /><SkeletonTable rows={5} columns={5} /></>}</div>;

  const rows = data.rows.filter((row: any) => showSnoozed || !row.snoozed);
  const open = data.rows.find((row: any) => row.customer_id === openId);

  return (
    <div className="stack">
      <AccountingNav />
      <PageHead title="Follow-ups" line="Customers with overdue invoices, oldest first. Copy the reminder into your own email, then log what you did.">
        <button onClick={() => setEditingSteps(true)}>Reminder steps</button>
      </PageHead>

      {error && <p className="error">{error}</p>}

      <div className="stats">
        <div className="card"><div className="stat-label">To chase today</div><div className="stat-value">{data.totals.to_chase}</div></div>
        <div className="card"><div className="stat-label">Customers overdue</div><div className="stat-value">{data.totals.customers}</div></div>
        <div className="card"><div className="stat-label">Overdue in total</div><div className="stat-value"><Amount value={data.totals.overdue} currency={data.currency} /></div></div>
      </div>

      <label className="check">
        <input type="checkbox" checked={showSnoozed} onChange={(e) => setShowSnoozed(e.target.checked)} />
        Show customers waiting for a later follow-up date
      </label>

      {rows.length === 0 ? (
        <div className="card">
          {data.rows.length ? (
            <EmptyState
              tone="done"
              icon="clock"
              title="Nobody to chase today"
              line="Everyone overdue is waiting for a later follow-up date."
              secondary={{ label: 'Show them anyway', onClick: () => setShowSnoozed(true) }}
            />
          ) : (
            <EmptyState
              tone="done"
              icon="paid"
              title="No overdue invoices. Nice work."
              line="Everyone has paid on time. Time is yours again."
              action={{ label: 'See invoices', href: '/saas/accounting' }}
            />
          )}
        </div>
      ) : (
      <div className="card table-wrap">
        <table>
          <thead>
            <tr><th>Customer</th><th className="num">Overdue</th><th className="num">Oldest</th><th>Suggested step</th><th>Last follow-up</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((row: any) => (
              <tr key={row.customer_id}>
                <td className="wrap">{row.name}<div className="muted">{row.overdue_count} overdue {row.overdue_count === 1 ? 'invoice' : 'invoices'}</div></td>
                <td className="num"><Amount value={row.overdue_total} currency={data.currency} strong /></td>
                <td className="num">{row.oldest_days} days</td>
                <td>{row.level_name ? <span className="badge overdue">{row.level_name}</span> : <span className="muted">None yet</span>}</td>
                <td className="wrap">
                  {row.last_at ? (
                    <>
                      {formatDate(row.last_at)}{row.last_level && ` · ${row.last_level}`}
                      {row.next_date && <div className="muted">{row.snoozed ? 'Next on' : 'Was due'} {formatDate(row.next_date)}</div>}
                    </>
                  ) : <span className="muted">Not chased yet</span>}
                </td>
                <td className="num"><button className="always" onClick={() => setOpenId(row.customer_id)}>Follow up</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}

      {open && <FollowUpPanel row={open} company={company} currency={data.currency} onClose={() => setOpenId('')} onSaved={load} />}
      {editingSteps && <StepsForm levels={data.levels} usingDefaults={data.using_defaults} onClose={() => setEditingSteps(false)} onSaved={load} />}
    </div>
  );
}

function FollowUpPanel({ row, company, currency, onClose, onSaved }: { row: any; company: string; currency: string; onClose: () => void; onSaved: () => void }) {
  const [message, setMessage] = useState(fillMessage(row.message || '', row, company, currency));
  const [note, setNote] = useState('');
  const [nextDate, setNextDate] = useState(addDays(7));
  const [history, setHistory] = useState<any[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/api/accounting/follow-ups/${row.customer_id}/history`).then(setHistory).catch((err) => setError(err.message));
  }, [row.customer_id]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      toast.success('Reminder copied', { detail: `Paste it into your email to ${row.name}.` });
    } catch {
      setError('Your browser did not allow copying. Select the text and copy it yourself.');
    }
  };

  const mailto = row.email
    ? `mailto:${encodeURIComponent(row.email)}?subject=${encodeURIComponent(subjectFor(row, company))}&body=${encodeURIComponent(message)}`
    : '';

  const { busy, run } = useSubmit();
  const save = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api.post('/api/accounting/follow-ups', { customer_id: row.customer_id, level_name: row.level_name, note, next_date: nextDate || null });
        toast.success('Follow-up logged', { detail: nextDate ? `We will bring ${row.name} back up on ${formatDate(nextDate)}.` : `Saved on ${row.name}'s history.` });
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title={`Follow up with ${row.name}`} onClose={onClose}>
      <div className="stack">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Invoice</th><th>Due</th><th className="num">Owed</th><th className="num">Days overdue</th></tr></thead>
            <tbody>
              {row.invoices.map((invoice: any) => (
                <tr key={invoice.id}>
                  <td><Link href={`/saas/accounting/invoice/${invoice.id}`}>{invoice.invoice_number}</Link></td>
                  <td>{formatDate(invoice.due_date || invoice.invoice_date)}</td>
                  <td className="num"><Amount value={invoice.balance} currency={invoice.currency} /></td>
                  <td className="num">{invoice.days}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <label>Suggested message ({row.level_name || 'reminder'})
          <textarea rows={10} value={message} onChange={(e) => setMessage(e.target.value)} />
        </label>
        <div className="row-actions">
          <button type="button" className="always" onClick={copy}>Copy message</button>
          {mailto ? <a href={mailto}>Open in email app</a> : <span className="muted">No email saved for this customer</span>}
          <Link href={`/saas/accounting/statements?customer=${row.customer_id}`}>Statement</Link>
        </div>

        <form onSubmit={save}>
          <h2>Log this follow-up</h2>
          <label>What happened<textarea rows={2} maxLength={2000} placeholder="For example: emailed reminder, they promised to pay Friday" value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <label>Check again on<input type="date" min={today()} value={nextDate} onChange={(e) => setNextDate(e.target.value)} /></label>
          </div>
          <div className="row-actions" style={{ marginTop: 8 }}>
            {[3, 7, 14].map((days) => (
              <button key={days} type="button" onClick={() => setNextDate(addDays(days))}>In {days} days</button>
            ))}
          </div>
          {error && <p className="error">{error}</p>}
          <div className="form-actions">
            <button disabled={busy} className="primary">Save follow-up</button>
            <button type="button" onClick={onClose}>Close</button>
          </div>
        </form>

        {history.length > 0 && (
          <div className="table-wrap">
            <h2>Earlier follow-ups</h2>
            <table>
              <thead><tr><th>Date</th><th>Step</th><th>Note</th><th>By</th></tr></thead>
              <tbody>
                {history.map((item) => (
                  <tr key={item.id}>
                    <td>{formatDate(item.created_at)}</td>
                    <td>{item.level_name || '—'}</td>
                    <td className="wrap">{item.note || '—'}{item.next_date && <div className="muted">Next: {formatDate(item.next_date)}</div>}</td>
                    <td>{item.created_by_email || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}

function StepsForm({ levels, usingDefaults, onClose, onSaved }: { levels: any[]; usingDefaults: boolean; onClose: () => void; onSaved: () => void }) {
  const [steps, setSteps] = useState<any[]>(levels.map(({ days_overdue, name, message }) => ({ days_overdue: String(days_overdue), name, message })));
  const [error, setError] = useState('');

  const set = (index: number, field: string, value: string) =>
    setSteps(steps.map((step, position) => (position === index ? { ...step, [field]: value } : step)));

  const { busy, run } = useSubmit();
  const save = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api.put('/api/accounting/follow-ups/levels', { levels: steps });
        toast.success('Reminder steps saved', { detail: `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}, used from the next follow-up on.` });
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title="Reminder steps" onClose={onClose}>
      <form onSubmit={save}>
        <p className="muted">
          Each step starts once a customer's oldest invoice is that many days overdue.
          {usingDefaults && ' These are the starting steps; saving makes them your own.'}
          {' '}In messages, {'{customer}'}, {'{company}'}, {'{total}'}, {'{invoices}'} and {'{days}'} are filled in for you.
        </p>
        <div className="stack">
          {steps.map((step, index) => (
            <div key={index} className="card stack">
              <div className="form-grid">
                <label>Name<input required maxLength={80} value={step.name} onChange={(e) => set(index, 'name', e.target.value)} /></label>
                <label>Days overdue<input required type="number" min="1" max="3650" step="1" value={step.days_overdue} onChange={(e) => set(index, 'days_overdue', e.target.value)} /></label>
              </div>
              <label>Message<textarea required rows={6} maxLength={4000} value={step.message} onChange={(e) => set(index, 'message', e.target.value)} /></label>
              {steps.length > 1 && (
                <div><button type="button" className="danger" onClick={() => setSteps(steps.filter((_, position) => position !== index))}>Remove step</button></div>
              )}
            </div>
          ))}
        </div>
        {steps.length < 10 && (
          <div className="form-actions">
            <button type="button" onClick={() => setSteps([...steps, { days_overdue: '', name: '', message: 'Hello {customer},\n\n{invoices}\n\nTotal overdue: {total}\n\n{company}' }])}>Add step</button>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">Save steps</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
