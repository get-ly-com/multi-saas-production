import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import EmptyState from '@/components/EmptyState';
import Icon from '@/components/Icon';
import Modal from '@/components/Modal';
import Skeleton from '@/components/Skeleton';
import SocialNav from '@/components/SocialNav';
import { toast } from '@/components/Toast';
import { api } from '@/lib/api';
import ss from '@/styles/social.module.css';

export default function SocialLibrary() {
  return <AppShell><Library /></AppShell>;
}

type Snippet = { id?: string; kind: 'text' | 'hashtags'; name: string; body: string };

const KINDS = { text: 'Text', hashtags: 'Hashtag set' };

// Text and hashtag sets the team reuses. In a post, "Add from library" puts one into the text.
function Library() {
  const [rows, setRows] = useState<Snippet[] | null>(null);
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
      setRows((current) => current || []);
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
      toast.success('Removed from the library');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const full = (rows?.length || 0) >= 300;

  return (
    <div className="stack">
      <SocialNav />
      <div className="page-head">
        <div>
          <h1>Content library</h1>
          <p className="muted">Save sign-offs, calls to action and hashtag sets once, then add them to any post. Up to 300 items.</p>
        </div>
        {canEdit && (
          <div className="row-actions">
            <button onClick={() => setEditing({ kind: 'hashtags', name: '', body: '' })} disabled={full}>New hashtag set</button>
            <button className="primary" onClick={() => setEditing({ kind: 'text', name: '', body: '' })} disabled={full}><Icon name="plus" size={16} />New text</button>
          </div>
        )}
      </div>
      {error && <p className="error">{error}</p>}

      {rows === null && (
        <div className={ss.library} aria-busy="true">
          {[0, 1, 2].map((n) => <div key={n} className={ss.snippet}><Skeleton width="50%" height={14} /><Skeleton height={48} /></div>)}
        </div>
      )}
      {rows?.length === 0 && (
        <div className="card">
          <EmptyState icon="copy" title="Nothing saved yet"
            line="Save text you use often, like a sign-off or your usual hashtags. Then add it to a post in one click."
            action={canEdit ? { label: 'New text', onClick: () => setEditing({ kind: 'text', name: '', body: '' }) } : undefined}
            secondary={canEdit ? { label: 'New hashtag set', onClick: () => setEditing({ kind: 'hashtags', name: '', body: '' }) } : undefined} />
        </div>
      )}
      {rows && rows.length > 0 && (
        <div className={ss.library}>
          {rows.map((row) => (
            <article key={row.id} className={ss.snippet}>
              <header>
                <strong>{row.name}</strong>
                <span className={`badge ${row.kind === 'hashtags' ? 'new' : ''}`}>{KINDS[row.kind]}</span>
              </header>
              <p>{row.body}</p>
              {canEdit && (
                <footer>
                  <button className="small" onClick={() => setEditing(row)}>Edit</button>
                  <button className="small ghost danger" onClick={() => remove(row)}>Delete</button>
                </footer>
              )}
            </article>
          ))}
        </div>
      )}
      {editing && <SnippetForm row={editing} onClose={() => setEditing(null)} onSaved={() => { toast.success(editing.id ? 'Saved' : 'Added to the library'); setEditing(null); load(); }} />}
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
