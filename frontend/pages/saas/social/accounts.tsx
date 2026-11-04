import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import Modal from '@/components/Modal';
import SocialNav from '@/components/SocialNav';
import { PLATFORMS } from '@/components/SocialForms';
import { api } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

export default function SocialAccounts() {
  return <AppShell><Accounts /></AppShell>;
}

const EMPTY = { platform: 'x', handle: '', profile_url: '' };

function Accounts() {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [list, summary] = await Promise.all([api.get('/api/social-media/accounts'), api.get('/api/social-media/overview')]);
      setAccounts(list);
      setCanEdit(summary.can_edit);
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const { busy, run: once } = useSubmit();
  // One action at a time, so a double click cannot repeat it
  const act = (work: () => Promise<any>) => once(async () => {
    try {
      await work();
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  });

  return (
    <div className="stack">
      <SocialNav />
      <div className="page-head">
        <h1>Accounts</h1>
        {canEdit && <button className="primary" onClick={() => setEditing({ ...EMPTY })}>Add account</button>}
      </div>
      <p className="muted">List the company’s accounts so posts can be planned for them. Only the name and profile link are kept here. Never enter passwords: you sign in on each platform yourself when you post.</p>
      {error && <p className="error">{error}</p>}

      <div className="card table-wrap">
        <table>
          <thead><tr><th>Platform</th><th>Account</th><th>Profile</th><th className="num">Text limit</th><th>Status</th><th /></tr></thead>
          <tbody>
            {accounts.length === 0 && <tr><td colSpan={6} className="empty">No accounts yet</td></tr>}
            {accounts.map((account) => (
              <tr key={account.id}>
                <td>{PLATFORMS[account.platform].name}</td>
                <td>{account.handle}</td>
                <td>{account.profile_url ? <a href={account.profile_url} target="_blank" rel="noopener noreferrer">Open profile</a> : '—'}</td>
                <td className="num">{PLATFORMS[account.platform].limit.toLocaleString()}</td>
                <td><span className={`badge ${account.is_active ? 'paid' : ''}`}>{account.is_active ? 'On' : 'Off'}</span></td>
                <td>
                  {canEdit && (
                    <div className="row-actions">
                      <button onClick={() => setEditing({ ...account, profile_url: account.profile_url || '' })}>Edit</button>
                      <button onClick={() => act(() => api.put(`/api/social-media/accounts/${account.id}`, { ...account, is_active: !account.is_active }))}>
                        {account.is_active ? 'Turn off' : 'Turn on'}
                      </button>
                      <button className="danger" onClick={() => window.confirm(`Remove ${account.handle} from the list?`) && act(() => api.delete(`/api/social-media/accounts/${account.id}`))}>Delete</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && <AccountForm initial={editing} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}

function AccountForm({ initial, onClose, onSaved }: { initial: any; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm({ ...form, [field]: value });

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        const body = { platform: form.platform, handle: form.handle, profile_url: form.profile_url };
        if (form.id) await api.put(`/api/social-media/accounts/${form.id}`, body);
        else await api.post('/api/social-media/accounts', body);
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title={form.id ? 'Edit account' : 'Add account'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Platform
            <select value={form.platform} disabled={Boolean(form.id)} onChange={(e) => set('platform', e.target.value)}>
              {Object.entries(PLATFORMS).map(([key, { name }]) => <option key={key} value={key}>{name}</option>)}
            </select>
          </label>
          <label>Name or handle<input required maxLength={100} placeholder="@yourcompany" value={form.handle} onChange={(e) => set('handle', e.target.value)} /></label>
          <label>Profile link (optional)<input type="url" maxLength={500} placeholder="https://" value={form.profile_url} onChange={(e) => set('profile_url', e.target.value)} /></label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary" type="submit">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
