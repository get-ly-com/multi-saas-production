import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import Icon from '@/components/Icon';
import Skeleton from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api, formatDate } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';
import s from '@/styles/settings.module.css';

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

  const { busy, run: once } = useSubmit();
  // One action at a time, so a double click cannot repeat it
  const run = (action: () => Promise<unknown>) => once(async () => {
    try {
      await action();
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  });

  const invite = (event: FormEvent) => {
    event.preventDefault();
    run(async () => {
      await api.post('/api/team/invites', form);
      toast.success('Invite saved', { detail: `Ask ${form.email} to sign up with that address. No email is sent.` });
      setForm({ ...form, email: '' });
    });
  };

  const remove = (member: any) => {
    if (window.confirm(`Remove ${member.email} from the company?`)) {
      run(() => api.delete(`/api/team/members/${member.user_id}`));
    }
  };


  if (!team) {
    return error ? <p className="error">{error}</p> : (
      <div className="stack" role="status" aria-label="Loading team">
        <div className="page-head"><Skeleton width={120} height={28} /><Skeleton width={150} height={34} /></div>
        <div className="card">
          {[0, 1, 2].map((n) => (
            <div key={n} className={s.row}>
              <Skeleton width={34} height={34} radius={999} />
              <div style={{ flex: 1, display: 'grid', gap: 6 }}><Skeleton width="45%" height={13} /><Skeleton width="25%" height={11} /></div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const manager = ['owner', 'admin'].includes(team.role);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Team</h1>
          <p className="muted">Who can use {team.members.length === 1 ? 'your company' : `your company, ${team.members.length} people`}, and what each person can do.</p>
        </div>
        <Link className="button" href="/saas/import"><Icon name="import" size={16} />Move your data in</Link>
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="card">
        <div className={s.section}>
          <div className={s.sectionText}>
            <h2>Members</h2>
            <p>{manager ? 'Change a role or remove someone. The owner always keeps full access.' : 'Only owners and admins can change the team.'}</p>
          </div>
          <ul className={s.list}>
            {team.members.map((member: any) => {
              const editable = manager && !member.is_me && member.role !== 'owner';
              return (
                <li key={member.user_id} className={s.row}>
                  <span className={`${s.avatar} ${s[`tone${toneOf(member.email)}`] || ''}`} aria-hidden="true">{initials(member.email)}</span>
                  <span className={s.rowText}>
                    <strong>{member.email}{member.is_me && <span className="muted" style={{ fontWeight: 400 }}> (you)</span>}</strong>
                  </span>
                  <span className={s.rowActions}>
                    {editable ? (
                      <select
                        aria-label={`Role for ${member.email}`}
                        value={member.role}
                        onChange={(e) => run(() => api.put(`/api/team/members/${member.user_id}`, { role: e.target.value }))}
                      >
                        {ROLES.map((role) => <option key={role} value={role}>{label(role)}</option>)}
                      </select>
                    ) : <span className={`${s.role} ${s[member.role] || ''}`}>{member.role}</span>}
                    {editable && (
                      <button className="ghost small danger" onClick={() => remove(member)} aria-label={`Remove ${member.email}`}>Remove</button>
                    )}
                  </span>
                </li>
              );
            })}
            {team.invites.map((item: any) => (
              <li key={item.id} className={s.row}>
                <span className={`${s.avatar} ${s.pending}`} aria-hidden="true"><Icon name="clock" size={15} /></span>
                <span className={s.rowText}>
                  <strong>{item.email}</strong>
                  <span>Invited, waiting to sign up · expires {formatDate(item.expires_at)}</span>
                </span>
                <span className={s.rowActions}>
                  <span className="badge pending">invited</span>
                  <span className={s.role}>{item.role}</span>
                  {manager && <button className="ghost small danger" onClick={() => run(() => api.delete(`/api/team/invites/${item.id}`))}>Cancel invite</button>}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {manager && (
          <div className={s.section}>
            <div className={s.sectionText}>
              <h2>Invite someone</h2>
              <p>No email is sent yet. Tell them to sign up with this address, and they&apos;ll be offered your company. Invites last 14 days.</p>
            </div>
            <form onSubmit={invite} className={s.inline}>
              <label>Email<input required type="email" placeholder="name@company.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
              <label style={{ flex: '0 0 auto' }}>Role
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  {ROLES.map((role) => <option key={role} value={role}>{label(role)}</option>)}
                </select>
              </label>
              <button disabled={busy} className="primary"><Icon name="plus" size={16} />Save invite</button>
            </form>
          </div>
        )}

        <div className={s.section}>
          <div className={s.sectionText}>
            <h2>What each role can do</h2>
            <p>Pick the smallest role that lets someone do their job.</p>
          </div>
          <div className={s.helpGrid}>
            {ROLE_HELP.map(([role, help]) => (
              <div key={role} className={s.help}>
                <strong><span className={`${s.role} ${s[role.toLowerCase()] || ''}`}>{role}</span></strong>
                <span>{help}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const label = (role: string) => role.charAt(0).toUpperCase() + role.slice(1);

// "sam.jones@x.com" becomes "SJ"
const initials = (email: string) => {
  const parts = String(email || '?').split('@')[0].split(/[._+-]/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
};

// The same person always gets the same soft colour
const toneOf = (text: string) => {
  let sum = 0;
  for (const char of String(text)) sum = (sum + char.charCodeAt(0)) % 997;
  return (sum % 4) + 1;
};
