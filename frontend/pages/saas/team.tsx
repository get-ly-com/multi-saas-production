import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { api, formatDate } from '@/lib/api';

const ROLES = ['admin', 'accountant', 'viewer'];
const ROLE_HELP = [
  ['Owner', 'Everything, including reopening locked periods'],
  ['Admin', 'Everything except reopening periods and managing other admins'],
  ['Accountant', 'Enters and changes records, but no team or controls'],
  ['Viewer', 'Reads everything, changes nothing']
];

export default function Team() {
  return <AppShell><TeamApp /></AppShell>;
}

function TeamApp() {
  const [team, setTeam] = useState<any>(null);
  const [form, setForm] = useState({ email: '', role: 'accountant' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    try {
      setTeam(await api.get('/api/team'));
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const invite = (event: FormEvent) => {
    event.preventDefault();
    run(async () => {
      await api.post('/api/team/invites', form);
      setNotice(`Invite saved. Ask ${form.email} to sign up with that address. No email is sent.`);
      setForm({ ...form, email: '' });
    });
  };

  const remove = (member: any) => {
    if (window.confirm(`Remove ${member.email} from the company?`)) {
      run(() => api.delete(`/api/team/members/${member.user_id}`));
    }
  };

  if (!team) return error ? <p className="error">{error}</p> : <p className="empty">Loading…</p>;

  const manager = ['owner', 'admin'].includes(team.role);

  return (
    <div className="stack">
      <div className="page-head"><h1>Team</h1></div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="card table-wrap">
        <table>
          <thead><tr><th>Email</th><th>Role</th><th /></tr></thead>
          <tbody>
            {team.members.map((member: any) => (
              <tr key={member.user_id}>
                <td className="wrap">{member.email}{member.is_me && <span className="muted"> (you)</span>}</td>
                <td>
                  {manager && !member.is_me && member.role !== 'owner' ? (
                    <select
                      aria-label={`Role for ${member.email}`}
                      value={member.role}
                      onChange={(e) => run(() => api.put(`/api/team/members/${member.user_id}`, { role: e.target.value }))}
                    >
                      {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                    </select>
                  ) : member.role}
                </td>
                <td>
                  {manager && !member.is_me && member.role !== 'owner' && (
                    <div className="row-actions"><button className="danger" onClick={() => remove(member)}>Remove</button></div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {manager && (
        <div className="card">
          <h2>Invite someone</h2>
          <form onSubmit={invite}>
            <div className="form-grid">
              <label>Email<input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
              <label>Role
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                </select>
              </label>
            </div>
            <div className="form-actions"><button className="primary">Save invite</button></div>
          </form>
          <p className="muted">No email is sent yet. Tell them to sign up with this address, and they'll be offered your company. Invites last 14 days.</p>
        </div>
      )}

      {team.invites.length > 0 && (
        <div className="card table-wrap">
          <h2>Pending invites</h2>
          <table>
            <thead><tr><th>Email</th><th>Role</th><th>Expires</th><th /></tr></thead>
            <tbody>
              {team.invites.map((item: any) => (
                <tr key={item.id}>
                  <td className="wrap">{item.email}</td>
                  <td>{item.role}</td>
                  <td>{formatDate(item.expires_at)}</td>
                  <td><div className="row-actions"><button className="danger" onClick={() => run(() => api.delete(`/api/team/invites/${item.id}`))}>Cancel</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card table-wrap">
        <h2>What each role can do</h2>
        <table>
          <tbody>
            {ROLE_HELP.map(([role, help]) => <tr key={role}><td>{role}</td><td className="wrap">{help}</td></tr>)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
