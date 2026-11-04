import { useRouter } from 'next/router';
import { FormEvent, useState } from 'react';
import { getSupabase } from '@/lib/supabase';

export default function ResetPassword() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const { error } = await getSupabase().auth.updateUser({ password });
    if (error) setError(error.message);
    else router.push('/saas/today');
  };

  return (
    <div className="auth">
      <h1>Choose a new password</h1>
      <form onSubmit={submit}>
        <label>
          New password
          <input type="password" required minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="primary">Save password</button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
