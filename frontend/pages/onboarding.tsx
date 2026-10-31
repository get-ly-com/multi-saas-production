import { useRouter } from 'next/router';
import { FormEvent, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { getSupabase } from '@/lib/supabase';

export default function Onboarding() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getSupabase().auth.getSession().then(({ data }) => {
      if (!data.session) router.replace('/login');
    });
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/tenants', { name });
      router.push('/saas/accounting');
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <h1>Name your company</h1>
      <form onSubmit={submit}>
        <label>
          Company name
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button className="primary" disabled={busy}>Continue</button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
