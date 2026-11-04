import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import ChatNav from '@/components/ChatNav';
import EmptyState from '@/components/EmptyState';
import Icon from '@/components/Icon';
import Modal from '@/components/Modal';
import { SkeletonTable } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

export default function ChatReplies() {
  return <AppShell><Replies /></AppShell>;
}

type Reply = { id?: string; shortcut: string; body: string };

// Prepared answers the team inserts by typing / and the shortcut in a chat reply
function Replies() {
  const [rows, setRows] = useState<Reply[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [editing, setEditing] = useState<Reply | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const [list, overview] = await Promise.all([api.get('/api/chatbot/canned'), api.get('/api/chatbot/overview')]);
      setRows(list);
      setCanEdit(Boolean(overview.can_reply));
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
  const remove = (row: Reply) => once(async () => {
    if (!window.confirm(`Delete the saved reply /${row.shortcut}?`)) return;
    try {
      await api.delete(`/api/chatbot/canned/${row.id}`);
      toast.success(`/${row.shortcut} deleted`);
      load();
    } catch (err: any) {
      setError(err.message);
    }
  });

  const query = search.trim().toLowerCase();
  const shown = rows.filter((row) => `${row.shortcut} ${row.body}`.toLowerCase().includes(query));

  return (
    <div className="stack">
      <ChatNav />
      <div className="page-head">
        <div>
          <h1>Saved replies</h1>
          <p className="muted">Answers you write once and drop into any chat.</p>
        </div>
        {canEdit && <button className="primary" onClick={() => setEditing({ shortcut: '', body: '' })} disabled={rows.length >= 200}><Icon name="plus" size={16} />New saved reply</button>}
      </div>
      <p className="muted small">In a chat, type <span className="kbd">/</span> and the shortcut (for example /refund), then press <span className="kbd">Tab</span> or <span className="kbd">Enter</span> to put the reply in. Write {'{name}'} for the visitor's first name. Up to 200.</p>
      {error && <p className="error">{error}</p>}
      {loading ? <SkeletonTable rows={4} columns={3} /> : rows.length === 0 ? (
        <div className="card">
          <EmptyState icon="chat" title="No saved replies yet" line="Save the answers you type most, like refunds or delivery times, and reply in a keystroke."
            action={canEdit ? { label: 'New saved reply', onClick: () => setEditing({ shortcut: '', body: '' }) } : undefined} />
        </div>
      ) : (<>
      <div className="report-filters"><input type="search" aria-label="Search saved replies" placeholder="Search saved replies" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Shortcut</th><th>Reply</th><th /></tr></thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={3} className="empty">No saved replies match your search</td></tr>}
            {shown.map((row) => (
              <tr key={row.id}>
                <td><span className="chip" style={{ fontFamily: 'var(--font-mono)' }}>/{row.shortcut}</span></td>
                <td className="wrap">{row.body}</td>
                <td>{canEdit && (
                  <div className="row-actions">
                    <button className="small" onClick={() => setEditing(row)}>Edit</button>
                    <button disabled={busy} className="small ghost danger" onClick={() => remove(row)}>Delete</button>
                  </div>
                )}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </>)}
      {editing && <ReplyForm row={editing} onClose={() => setEditing(null)} onSaved={() => { toast.success(editing.id ? 'Saved reply updated' : 'Saved reply added'); setEditing(null); load(); }} />}
    </div>
  );
}

function ReplyForm({ row, onClose, onSaved }: { row: Reply; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState(row);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (row.id) await api.put(`/api/chatbot/canned/${row.id}`, form);
      else await api.post('/api/chatbot/canned', form);
      onSaved();
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title={row.id ? 'Edit saved reply' : 'New saved reply'} onClose={onClose}>
      <form onSubmit={submit}>
        <label>Shortcut (letters, numbers, - or _)
          <input required maxLength={31} pattern="/?[A-Za-z0-9][A-Za-z0-9_-]{0,29}" placeholder="refund" value={form.shortcut}
            onChange={(e) => setForm({ ...form, shortcut: e.target.value })} />
        </label>
        <label>Reply<textarea required rows={5} maxLength={2000} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
