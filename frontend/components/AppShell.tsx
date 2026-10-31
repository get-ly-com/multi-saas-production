import Link from 'next/link';
import { useRouter } from 'next/router';
import { ReactNode, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { getSupabase } from '@/lib/supabase';

const PRODUCTS = [
  { name: 'Accounting', path: '/saas/accounting' },
  { name: 'CRM', path: '/saas/crm' },
  { name: 'Inventory', path: '/saas/inventory' }
];

type Me = { user: { email: string }; tenant: { name: string } };

export default function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      const { data } = await getSupabase().auth.getSession();
      if (!data.session) return router.replace('/login');

      try {
        const account = await api.get('/api/me');
        if (!account.tenant) return router.replace('/onboarding');
        setMe(account);
      } catch (err: any) {
        if (err.status === 401) return router.replace('/login');
        setError(err.message);
      }
    };
    load();
  }, []);

  const signOut = async () => {
    await getSupabase().auth.signOut();
    router.replace('/login');
  };

  if (error) return <div className="auth"><p className="error">{error}</p></div>;
  if (!me) return <div className="auth">Loading…</div>;

  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand">Get-ly</Link>
        <nav className="nav">
          {PRODUCTS.map(({ name, path }) => (
            <Link key={path} href={path} className={router.pathname.startsWith(path) ? 'active' : ''}>
              {name}
            </Link>
          ))}
        </nav>
        <div className="account">
          <span>{me.tenant.name} · {me.user.email}</span>
          <button className="link" onClick={signOut}>Sign out</button>
        </div>
      </header>
      <main className="page">{children}</main>
    </>
  );
}
