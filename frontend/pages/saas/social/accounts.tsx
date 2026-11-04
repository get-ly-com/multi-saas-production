import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import EmptyState from '@/components/EmptyState';
import Icon from '@/components/Icon';
import Modal from '@/components/Modal';
import { SkeletonTable } from '@/components/Skeleton';
import SocialNav from '@/components/SocialNav';
import { PLATFORMS, PlatformMark } from '@/components/SocialForms';
import { toast } from '@/components/Toast';
import { api } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';
import ss from '@/styles/social.module.css';

export default function SocialAccounts() {
  return <AppShell><Accounts /></AppShell>;
}

const EMPTY = { platform: 'x', handle: '', profile_url: '' };

function Accounts() {
  const [accounts, setAccounts] = useState<any[] | null>(null);
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
      setAccounts((current) => current || []);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const { busy, run: once } = useSubmit();
  // One action at a time, so a double click cannot repeat it
  const act = (work: () => Promise<any>, done?: string) => once(async () => {
    try {
      await work();
      await load();
      if (done) toast.success(done);
    } catch (err: any) {
      setError(err.message);
    }
  });

  return (
    <div className="stack">
      <SocialNav />
      <div className="page-head">
        <div>
          <h1>Accounts</h1>
          <p className="muted">The company&apos;s profiles you plan posts for. Only the name and profile link are kept here.</p>
        </div>
        {canEdit && <button className="primary" onClick={() => setEditing({ ...EMPTY })}><Icon name="plus" size={16} />Add account</button>}
      </div>
      <p className="notice" style={{ margin: 0 }}>Never enter passwords here. You sign in on each platform yourself when you post.</p>
      {error && <p className="error">{error}</p>}

      {accounts === null && <SkeletonTable rows={3} columns={5} />}
      {accounts?.length === 0 && (
        <div className="card">
          <EmptyState icon="social" title="No accounts yet"
            line="Add your company's X, LinkedIn, Facebook or Instagram profile to start planning posts."
            action={canEdit ? { label: 'Add account', onClick: () => setEditing({ ...EMPTY }) } : undefined} />
        </div>
      )}
      {accounts && accounts.length > 0 && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Account</th><th>Profile</th><th className="num">Text limit</th><th>Status</th><th /></tr></thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id}>
                  <td>
                    <span className={ss.accountRow}>
                      <PlatformMark platform={account.platform} large />
                      <span><strong>{account.handle}</strong><small>{PLATFORMS[account.platform].name}</small></span>
                    </span>
                  </td>
                  <td>{account.profile_url ? <a href={account.profile_url} target="_blank" rel="noopener noreferrer">Open profile <Icon name="external" size={13} /></a> : <span className="muted">No link</span>}</td>
                  <td className="num">{PLATFORMS[account.platform].limit.toLocaleString()}</td>
                  <td><span className={`badge ${account.is_active ? 'active' : 'inactive'}`}>{account.is_active ? 'On' : 'Off'}</span></td>
                  <td>
                    {canEdit && (
                      <div className="row-actions">
                        <button className="small" onClick={() => setEditing({ ...account, profile_url: account.profile_url || '' })}>Edit</button>
                        <button className="small" disabled={busy} onClick={() => act(() => api.put(`/api/social-media/accounts/${account.id}`, { ...account, is_active: !account.is_active }),
                          account.is_active ? 'Account turned off' : 'Account turned on')}>
                          {account.is_active ? 'Turn off' : 'Turn on'}
                        </button>
                        <button className="small danger" disabled={busy} onClick={() => window.confirm(`Remove ${account.handle} from the list?`) && act(() => api.delete(`/api/social-media/accounts/${account.id}`), 'Account removed')}>Delete</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && <AccountForm initial={editing} onClose={() => setEditing(null)} onSaved={async () => { await load(); toast.success(editing.id ? 'Account saved' : 'Account added'); }} />}
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
