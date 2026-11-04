import { FormEvent, useEffect, useState } from 'react';
import Modal from '@/components/Modal';
import { fullName } from '@/components/HrForms';
import { api, formatDate, today } from '@/lib/api';
import { getSupabase } from '@/lib/supabase';
import useSubmit from '@/lib/useSubmit';

// Shared pieces for attendance, expense claims and onboarding/offboarding checklists

export const timeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export const hoursText = (value: number | string | null | undefined) => {
  const hours = Number(value || 0);
  const whole = Math.floor(hours);
  const minutes = Math.round((hours - whole) * 60);
  return minutes ? `${whole}h ${String(minutes).padStart(2, '0')}m` : `${whole}h`;
};

export const timeOf = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—';

// A datetime-local input works in local time without a zone
const localInput = (value: string | null | undefined) => {
  if (!value) return '';
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

// Monday of the week a date falls in
export const weekStart = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

export const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

export function TimeEntryForm({ entry, employeeId, onClose, onSaved }: {
  entry: any; employeeId: string; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({
    check_in: localInput(entry?.check_in) || `${today()}T09:00`,
    check_out: entry ? localInput(entry.check_out) : `${today()}T17:00`,
    break_minutes: String(entry?.break_minutes ?? 30),
    note: entry?.note || ''
  });
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm({ ...form, [field]: value });

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      const body = {
        employee_id: employeeId,
        check_in: new Date(form.check_in).toISOString(),
        check_out: form.check_out ? new Date(form.check_out).toISOString() : null,
        break_minutes: form.break_minutes || 0,
        work_date: form.check_in.slice(0, 10),
        note: form.note,
        tz: timeZone()
      };
      try {
        if (entry?.id) await api.put(`/api/hr/attendance/${entry.id}`, body);
        else await api.post('/api/hr/attendance', body);
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  const minutes = form.check_out ? (Date.parse(form.check_out) - Date.parse(form.check_in)) / 60000 - Number(form.break_minutes || 0) : 0;

  return (
    <Modal title={entry?.id ? 'Change time' : 'Add time'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>In<input type="datetime-local" required value={form.check_in} onChange={(e) => set('check_in', e.target.value)} /></label>
          <label>Out<input type="datetime-local" value={form.check_out} onChange={(e) => set('check_out', e.target.value)} /></label>
          <label>Break (minutes)<input type="number" min="0" max="600" step="5" value={form.break_minutes} onChange={(e) => set('break_minutes', e.target.value)} /></label>
          <label>Note<input maxLength={300} value={form.note} onChange={(e) => set('note', e.target.value)} placeholder="Forgot to clock out" /></label>
        </div>
        {minutes > 0 && <p className="muted">{hoursText(minutes / 60)} worked.</p>}
        <p className="muted">Leave Out empty if they're still at work. Approved time can only be changed by an owner or admin.</p>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary always">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

// Receipts go straight to the private 'hr-receipts' bucket; the claim records where
export const RECEIPT_BUCKET = 'hr-receipts';
const RECEIPT_TYPES: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const extensionOf = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');
const safeFileName = (name: string) =>
  name.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+/, '').slice(-100) || 'receipt';

// Call straight from a click: the tab opens before the wait for the link, so the browser doesn't block it
export const openReceipt = async (path: string) => {
  const tab = window.open('', '_blank');
  if (tab) tab.opener = null;
  try {
    const { data, error } = await getSupabase().storage.from(RECEIPT_BUCKET).createSignedUrl(path, 60);
    if (error || !data?.signedUrl) throw new Error('That receipt couldn’t be opened. Please try again.');
    if (tab) tab.location.href = data.signedUrl;
    else window.open(data.signedUrl, '_blank', 'noopener');
  } catch (err) {
    tab?.close();
    throw err;
  }
};

export function ExpenseForm({ people, me, categories, tenantId, onClose, onSaved }: {
  people: any[]; me: any; categories: any[]; tenantId: string; onClose: () => void; onSaved: () => void;
}) {
  const active = categories.filter((row) => row.is_active);
  const [form, setForm] = useState({
    employee_id: me?.id || people[0]?.id || '', expense_date: today(), category_id: active[0]?.id || '', description: '', amount: ''
  });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm({ ...form, [field]: value });

  const choose = (chosen: File | null) => {
    setError('');
    setFile(null);
    if (!chosen) return;
    if (!RECEIPT_TYPES[extensionOf(chosen.name)]) return setError('Add the receipt as a PDF, JPEG, PNG or WebP file.');
    if (chosen.size > 5 * 1024 * 1024) return setError('Receipts can be up to 5 MB.');
    if (chosen.size === 0) return setError('That file is empty.');
    setFile(chosen);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const storage = getSupabase().storage.from(RECEIPT_BUCKET);
    let path: string | null = null;
    try {
      if (file) {
        path = `${tenantId}/${form.employee_id}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
        const { error: uploadError } = await storage.upload(path, file, { upsert: false, contentType: RECEIPT_TYPES[extensionOf(file.name)] });
        if (uploadError) {
          path = null;
          throw new Error('The receipt couldn’t be uploaded. Check it’s a PDF or picture up to 5 MB, or your company may be out of receipt space.');
        }
      }
      await api.post('/api/hr/expenses', { ...form, receipt_path: path });
      await onSaved();
      onClose();
    } catch (err: any) {
      // Don't leave a receipt behind that no claim points to
      if (path) await storage.remove([path]).catch(() => null);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New expense claim" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          {people.length > 1 && (
            <label>Person
              <select required value={form.employee_id} onChange={(e) => set('employee_id', e.target.value)}>
                {people.map((row) => <option key={row.id} value={row.id}>{fullName(row)}</option>)}
              </select>
            </label>
          )}
          <label>Date spent<input type="date" required max={today()} value={form.expense_date} onChange={(e) => set('expense_date', e.target.value)} /></label>
          <label>Category
            <select required value={form.category_id} onChange={(e) => set('category_id', e.target.value)}>
              {active.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </select>
          </label>
          <label>Amount<input type="number" required min="0.01" step="0.01" value={form.amount} onChange={(e) => set('amount', e.target.value)} /></label>
          <label>What it was for<input required maxLength={300} value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="Train to the client meeting" /></label>
          <label>Receipt<input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" onChange={(e) => choose(e.target.files?.[0] || null)} /></label>
        </div>
        <p className="muted">Your manager, or an owner or admin, approves it. Once approved it&apos;s booked in Accounting and paid back to you. Receipts are private to you, your manager, owners, admins and accountants.</p>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary always" disabled={busy || !active.length}>{busy ? 'Sending…' : 'Send claim'}</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

const WHO: Record<string, string> = { hr: 'HR', manager: 'Manager', employee: 'Them' };
const KINDS: Record<string, string> = { onboarding: 'Onboarding', offboarding: 'Offboarding' };

// Onboarding and offboarding steps on someone's record
export function EmployeeChecklists({ employee, manager, isMe, isTheirManager }: {
  employee: any; manager: boolean; isMe: boolean; isTheirManager: boolean;
}) {
  const [tasks, setTasks] = useState<any[] | null>(null);
  const [templates, setTemplates] = useState<any[]>([]);
  const [template, setTemplate] = useState('');
  const [adding, setAdding] = useState({ kind: 'onboarding', title: '', due_date: '', who: 'hr' });
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setTasks(await api.get(`/api/hr/employees/${employee.id}/tasks`));
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
    if (manager) api.get('/api/hr/checklists').then((rows) => {
      setTemplates(rows);
      setTemplate(rows[0]?.id || '');
    }).catch(() => setTemplates([]));
  }, [employee.id, manager]);

  const { busy, run: once } = useSubmit();
  // One action at a time, so a double click cannot repeat it
  const run = (work: () => Promise<unknown>) => once(async () => {
    setError('');
    try {
      await work();
      await load();
      return true;
    } catch (err: any) {
      setError(err.message);
      return false;
    }
  });

  const canTick = (task: any) => manager || (task.who === 'employee' && isMe) || (task.who === 'manager' && isTheirManager);
  if (tasks === null && !error) return null;
  if (!manager && !tasks?.length) return null;

  const addStep = async (event: FormEvent) => {
    event.preventDefault();
    if (await run(() => api.post(`/api/hr/employees/${employee.id}/tasks`, adding))) setAdding({ ...adding, title: '', due_date: '' });
  };

  const now = today();
  return (
    <div className="card table-wrap">
      <h2>Onboarding and offboarding</h2>
      {error && <p className="error">{error}</p>}
      {(['onboarding', 'offboarding'] as const).map((kind) => {
        const list = (tasks || []).filter((task) => task.kind === kind);
        if (!list.length) return null;
        const done = list.filter((task) => task.done_at).length;
        return (
          <div key={kind} style={{ marginBottom: 12 }}>
            <h3>{KINDS[kind]} · {done} of {list.length} done</h3>
            <table>
              <thead><tr><th>Done</th><th>Step</th><th>Who</th><th>Due</th><th /></tr></thead>
              <tbody>
                {list.map((task) => (
                  <tr key={task.id}>
                    <td>
                      <input type="checkbox" aria-label={`Done: ${task.title}`} checked={Boolean(task.done_at)} disabled={!canTick(task)}
                        onChange={(e) => run(() => api.put(`/api/hr/tasks/${task.id}`, { done: e.target.checked }))} />
                    </td>
                    <td className="wrap" style={task.done_at ? { textDecoration: 'line-through' } : undefined}>{task.title}</td>
                    <td>{WHO[task.who]}</td>
                    <td className={!task.done_at && task.due_date && task.due_date < now ? 'late' : ''}>{formatDate(task.due_date)}</td>
                    <td>{manager && <div className="row-actions"><button className="danger" onClick={() => run(() => api.delete(`/api/hr/tasks/${task.id}`))}>Remove</button></div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      {!tasks?.length && <p className="empty">No checklist yet.</p>}
      {manager && (
        <>
          {templates.length > 0 && (
            <div className="row-actions" style={{ justifyContent: 'flex-start', marginTop: 12 }}>
              <select aria-label="Checklist" value={template} onChange={(e) => setTemplate(e.target.value)}>
                {templates.map((row) => <option key={row.id} value={row.id}>{row.name} ({KINDS[row.kind].toLowerCase()})</option>)}
              </select>
              <button onClick={() => run(() => api.post(`/api/hr/employees/${employee.id}/checklists`, { template_id: template }))}>Start checklist</button>
            </div>
          )}
          <form className="row-actions" style={{ justifyContent: 'flex-start', marginTop: 12 }} onSubmit={addStep}>
            <select aria-label="Kind" value={adding.kind} onChange={(e) => setAdding({ ...adding, kind: e.target.value })}>
              <option value="onboarding">Onboarding</option>
              <option value="offboarding">Offboarding</option>
            </select>
            <input aria-label="Step" placeholder="Add a step" required maxLength={200} value={adding.title} onChange={(e) => setAdding({ ...adding, title: e.target.value })} />
            <input aria-label="Due" type="date" value={adding.due_date} onChange={(e) => setAdding({ ...adding, due_date: e.target.value })} />
            <select aria-label="Who" value={adding.who} onChange={(e) => setAdding({ ...adding, who: e.target.value })}>
              {Object.entries(WHO).map(([value, label]) => <option key={value} value={value}>{label === 'Them' ? 'The person' : label}</option>)}
            </select>
            <button disabled={busy}>Add</button>
          </form>
          <p className="muted">Steps are due counting from the start date (onboarding) or the last day (offboarding). Whoever does a step gets an alert on the day it&apos;s due.</p>
        </>
      )}
    </div>
  );
}
