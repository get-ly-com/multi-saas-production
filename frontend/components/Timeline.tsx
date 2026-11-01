import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { api, formatDate, today } from '@/lib/api';

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
  const [form, setForm] = useState({ kind: 'note', subject: '', body: '', due_on: '' });
  const [error, setError] = useState('');
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
  }, [query]);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post('/api/crm/activities', { ...links, ...form, due_on: form.kind === 'task' ? form.due_on || today() : '' });
      setForm({ ...form, subject: '', body: '', due_on: '' });
      await load();
      onChange?.();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await load();
      onChange?.();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const entries = [
    ...items.map((item) => ({ id: item.id, at: item.created_at, content: <Entry item={item} run={run} /> })),
    ...extra
  ].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <div className="card">
      <h2>Timeline</h2>
      <form onSubmit={add}>
        <div className="tabs">
          {KINDS.map(({ id, name }) => (
            <button type="button" key={id} className={form.kind === id ? 'active' : ''} onClick={() => setForm({ ...form, kind: id })}>{name}</button>
          ))}
        </div>
        <div className="form-grid" style={{ marginTop: 12 }}>
          <label>{form.kind === 'task' ? 'What needs doing' : 'Subject'}<input required value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></label>
          {form.kind === 'task' && (
            <label>Due<input type="date" value={form.due_on || today()} onChange={(e) => setForm({ ...form, due_on: e.target.value })} /></label>
          )}
        </div>
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
    </div>
  );
}

function Entry({ item, run }: { item: any; run: (action: () => Promise<unknown>) => void }) {
  const task = item.kind === 'task';
  const late = task && !item.done_at && item.due_on && item.due_on < today();

  return (
    <div className="timeline-item">
      <div>
        <span className={`badge ${late ? 'lost' : ''}`}>{task ? (item.done_at ? 'done' : late ? 'overdue' : 'task') : item.kind}</span>
        {' '}<strong>{item.subject}</strong>
        {task && item.due_on && <span className="muted"> · due {formatDate(item.due_on)}</span>}
        {item.body && <div className="wrap">{item.body}</div>}
        <div className="muted">{formatDate(item.created_at)}</div>
      </div>
      <div className="row-actions">
        {task && <button onClick={() => run(() => api.put(`/api/crm/activities/${item.id}/done`, { done: !item.done_at }))}>{item.done_at ? 'Reopen' : 'Done'}</button>}
        <button className="danger" onClick={() => window.confirm('Delete this entry?') && run(() => api.delete(`/api/crm/activities/${item.id}`))}>Delete</button>
      </div>
    </div>
  );
}
