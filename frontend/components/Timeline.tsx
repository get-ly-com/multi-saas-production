import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { FinishForm, dueState, dueText } from '@/components/ActivityForms';
import EmailForm from '@/components/EmailForm';
import { CRM_SAVED, api, formatDate, today } from '@/lib/api';

const KINDS = [
  { id: 'note', name: 'Note' },
  { id: 'call', name: 'Call' },
  { id: 'meeting', name: 'Meeting' },
  { id: 'email', name: 'Email' },
  { id: 'task', name: 'Task' }
];

type Links = { contact_id?: string; company_id?: string; deal_id?: string; lead_id?: string };

export default function Timeline({ links, extra = [], onChange }: { links: Links; extra?: { id: string; at: string; content: ReactNode }[]; onChange?: () => void }) {
  const [items, setItems] = useState<any[]>([]);
  const [form, setForm] = useState({ kind: 'note', subject: '', body: '', due_on: '', due_time: '', later: false });
  const [finishing, setFinishing] = useState<any>(null);
  const [error, setError] = useState('');
  const [emailing, setEmailing] = useState(false);
  const query = new URLSearchParams(links as Record<string, string>).toString();

  const load = async () => {
    try {
      setItems(await api.get(`/api/crm/activities?${query}`));
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
    // Any CRM save reloads the list, which also shows tasks automation just made
    window.addEventListener(CRM_SAVED, load);
    return () => window.removeEventListener(CRM_SAVED, load);
  }, [query]);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    try {
      // A call, meeting or email can be planned for a date; otherwise it is logged as done now
      const planned = form.kind === 'task' || (form.later && form.kind !== 'note');
      const { later, ...fields } = form;
      await api.post('/api/crm/activities', {
        ...links,
        ...fields,
        due_on: planned ? form.due_on || today() : '',
        due_time: planned ? form.due_time : ''
      });
      setForm({ ...form, subject: '', body: '', due_on: '', due_time: '', later: false });
      onChange?.();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      onChange?.();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const entries = [
    ...items.map((item) => ({ id: item.id, at: item.created_at, content: <Entry item={item} run={run} onFinish={setFinishing} /> })),
    ...extra
  ].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <div className="card">
      <div className="page-head">
        <h2>Timeline</h2>
        {(links.contact_id || links.lead_id || links.deal_id) && <button onClick={() => setEmailing(true)}>Send email</button>}
      </div>
      <form onSubmit={add}>
        <div className="tabs">
          {KINDS.map(({ id, name }) => (
            <button type="button" key={id} className={form.kind === id ? 'active' : ''} onClick={() => setForm({ ...form, kind: id })}>{name}</button>
          ))}
        </div>
        <div className="form-grid" style={{ marginTop: 12 }}>
          <label>{form.kind === 'task' ? 'What needs doing' : 'Subject'}<input required value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></label>
          {(form.kind === 'task' || (form.later && form.kind !== 'note')) && (
            <>
              <label>{form.kind === 'task' ? 'Due' : 'When'}<input type="date" value={form.due_on || today()} onChange={(e) => setForm({ ...form, due_on: e.target.value })} /></label>
              <label>Time (optional)<input type="time" value={form.due_time} onChange={(e) => setForm({ ...form, due_time: e.target.value })} /></label>
            </>
          )}
        </div>
        {['call', 'meeting', 'email'].includes(form.kind) && (
          <label className="check" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={form.later} onChange={(e) => setForm({ ...form, later: e.target.checked })} />Plan this for later instead of logging it as done
          </label>
        )}
        {form.kind !== 'task' && (
          <label style={{ marginTop: 12 }}>Details<textarea rows={2} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></label>
        )}
        {error && <p className="error">{error}</p>}
        <div className="form-actions"><button className="primary">Save</button></div>
      </form>

      <div className="timeline">
        {entries.length === 0 && <p className="empty">Nothing logged yet</p>}
        {entries.map(({ id, content }) => <div key={id}>{content}</div>)}
      </div>
      {finishing && <FinishForm activity={finishing} onClose={() => setFinishing(null)} onSaved={() => onChange?.()} />}
      {emailing && <EmailForm links={{ contact_id: links.contact_id, lead_id: links.lead_id, deal_id: links.deal_id }} onClose={() => setEmailing(false)} />}
    </div>
  );
}

function Entry({ item, run, onFinish }: { item: any; run: (action: () => Promise<unknown>) => void; onFinish: (item: any) => void }) {
  const task = item.kind === 'task';
  const open = !item.done_at && item.kind !== 'note';
  const late = open && dueState(item) === 'overdue';
  const planned = open && !task;

  return (
    <div className="timeline-item">
      <div>
        <span className={`badge ${late ? 'lost' : planned ? 'sent' : ''}`}>{task ? (item.done_at ? 'done' : late ? 'overdue' : 'task') : late ? `${item.kind} overdue` : planned ? `planned ${item.kind}` : item.kind}</span>
        {' '}<strong>{item.subject}</strong>
        {(task || planned) && item.due_on && <span className="muted"> · {open ? 'due' : 'was due'} {dueText(item)}</span>}
        {item.automation_id && <span className="muted"> · automated</span>}
        {item.body && <div className="wrap">{item.body}</div>}
        <div className="muted">{formatDate(item.created_at)}</div>
      </div>
      <div className="row-actions">
        {open && <button onClick={() => onFinish(item)}>Done</button>}
        {item.done_at && item.due_on && item.kind !== 'note' && <button onClick={() => run(() => api.put(`/api/crm/activities/${item.id}/done`, { done: false }))}>Reopen</button>}
        <button className="danger" onClick={() => window.confirm('Delete this entry?') && run(() => api.delete(`/api/crm/activities/${item.id}`))}>Delete</button>
      </div>
    </div>
  );
}
