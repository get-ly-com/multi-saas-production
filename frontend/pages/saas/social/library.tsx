import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import Modal from '@/components/Modal';
import SocialNav from '@/components/SocialNav';
import { api } from '@/lib/api';

export default function SocialLibrary() {
  return <AppShell><Library /></AppShell>;
}

type Snippet = { id?: string; kind: 'text' | 'hashtags'; name: string; body: string };

const KINDS = { text: 'Text', hashtags: 'Hashtag set' };

// Text and hashtag sets the team reuses. In a post, "Add from library" puts one into the text.
function Library() {
  const [rows, setRows] = useState<Snippet[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [editing, setEditing] = useState<Snippet | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [list, overview] = await Promise.all([api.get('/api/social-media/snippets'), api.get('/api/social-media/overview')]);
      setRows(list);
      setCanEdit(Boolean(overview.can_edit));
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const remove = async (row: Snippet) => {
    if (!window.confirm(`Delete “${row.name}” from the library? Posts that already use it keep their text.`)) return;
    try {
      await api.delete(`/api/social-media/snippets/${row.id}`);
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="stack">
      <SocialNav />
      <div className="page-head">
        <h1>Content library</h1>
        {canEdit && (
          <div className="row-actions">
            <button onClick={() => setEditing({ kind: 'hashtags', name: '', body: '' })} disabled={rows.length >= 300}>New hashtag set</button>
            <button className="primary" onClick={() => setEditing({ kind: 'text', name: '', body: '' })} disabled={rows.length >= 300}>New text</button>
          </div>
        )}
      </div>
      <p className="muted">Save sign-offs, disclaimers, calls to action and hashtag sets once, then add them to any post. Up to 300 items.</p>
      {error && <p className="error">{error}</p>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Kind</th><th>Content</th><th /></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={4} className="empty">Nothing saved yet</td></tr>}
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.name}</td>
                <td>{KINDS[row.kind]}</td>
                <td className="wrap">{row.body}</td>
                <td>{canEdit && (
                  <div className="row-actions">
                    <button onClick={() => setEditing(row)}>Edit</button>
                    <button className="danger" onClick={() => remove(row)}>Delete</button>
                  </div>
                )}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <SnippetForm row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function SnippetForm({ row, onClose, onSaved }: { row: Snippet; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState(row);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (row.id) await api.put(`/api/social-media/snippets/${row.id}`, form);
      else await api.post('/api/social-media/snippets', form);
      onSaved();
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title={row.id ? `Edit ${KINDS[row.kind].toLowerCase()}` : `New ${KINDS[row.kind].toLowerCase()}`} onClose={onClose}>
      <form onSubmit={submit}>
        <label>Name (only your team sees this)<input required maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>{form.kind === 'hashtags' ? 'Hashtags, separated by spaces or commas (up to 30)' : 'Text'}
          <textarea required rows={form.kind === 'hashtags' ? 3 : 6} maxLength={3000} value={form.body}
            placeholder={form.kind === 'hashtags' ? '#spring #sale #offers' : ''}
            onChange={(e) => setForm({ ...form, body: e.target.value })} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
