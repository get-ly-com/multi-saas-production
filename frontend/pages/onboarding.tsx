import Link from 'next/link';
import { useRouter } from 'next/router';
import { FormEvent, useEffect, useState } from 'react';
import { api, openCompany } from '@/lib/api';
import { getSupabase } from '@/lib/supabase';

export default function Onboarding() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [invites, setInvites] = useState<any[]>([]);
  const [hasCompany, setHasCompany] = useState(false);

  useEffect(() => {
    getSupabase().auth.getSession().then(({ data }) => {
      if (!data.session) return router.replace('/login');
      api.get('/api/invites').then(setInvites).catch((err) => setError(err.message));
      api.get('/api/me').then((me) => setHasCompany(Boolean(me.tenant))).catch((err) => setError(err.message));
    });
  }, []);

  const accept = async (invite: any) => {
    setBusy(true);
    setError('');
    try {
      openCompany(await api.post(`/api/invites/${invite.id}/accept`, {}));
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const company = await api.post('/api/tenants', { name });
      openCompany(company.id);
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      {invites.map((invite) => (
        <div className="card" key={invite.id} style={{ marginBottom: 16 }}>
          <p>You've been invited to <strong>{invite.company}</strong> as {invite.role}.</p>
          <button className="primary" disabled={busy} onClick={() => accept(invite)}>Join {invite.company}</button>
        </div>
      ))}
      <h1>{invites.length ? 'Or start your own company' : hasCompany ? 'Add a company' : 'Name your company'}</h1>
      <form onSubmit={submit}>
        <label>
          Company name
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button className="primary" disabled={busy}>Continue</button>
      </form>
      {error && <p className="error">{error}</p>}
      {hasCompany && <p><Link href="/saas/accounting">← Back to your books</Link></p>}
    </div>
  );
}
