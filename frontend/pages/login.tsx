import { useRouter } from 'next/router';
import { FormEvent, useState } from 'react';
import { getSupabase } from '@/lib/supabase';

type Mode = 'signin' | 'signup' | 'reset';

const TITLES = { signin: 'Sign in', signup: 'Create your account', reset: 'Reset your password' };

export default function Login() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');

    const auth = getSupabase().auth;
    const origin = window.location.origin;

    if (mode === 'reset') {
      const { error } = await auth.resetPasswordForEmail(email, { redirectTo: `${origin}/reset-password` });
      if (error) setError(error.message);
      else setNotice('If that email has an account, a reset link is on its way.');
    } else if (mode === 'signup') {
      const { data, error } = await auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${origin}/onboarding` }
      });
      if (error) setError(error.message);
      else if (data.session) router.push('/onboarding');
      else setNotice('Check your email to confirm your account, then sign in.');
    } else {
      const { error } = await auth.signInWithPassword({ email, password });
      if (error) setError(error.message);
      else router.push('/saas/accounting');
    }

    setBusy(false);
  };

  const switchTo = (next: Mode) => {
    setMode(next);
    setError('');
    setNotice('');
  };

  return (
    <div className="auth">
      <h1>{TITLES[mode]}</h1>
      <form onSubmit={submit}>
        <label>
          Email
          <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {mode !== 'reset' && (
          <label>
            Password
            <input
              type="password"
              required
              minLength={8}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        )}
        <button className="primary" disabled={busy}>{TITLES[mode]}</button>
      </form>
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}
      <p>
        {mode === 'signin'
          ? <button className="link" onClick={() => switchTo('signup')}>Create an account</button>
          : <button className="link" onClick={() => switchTo('signin')}>Back to sign in</button>}
      </p>
      {mode === 'signin' && (
        <p><button className="link" onClick={() => switchTo('reset')}>Forgot your password?</button></p>
      )}
    </div>
  );
}
