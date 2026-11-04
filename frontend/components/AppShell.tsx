import Link from 'next/link';
import { useRouter } from 'next/router';
import { ReactNode, useEffect, useState } from 'react';
import NotificationBell from '@/components/NotificationBell';
import { api, openCompany, rememberCompany, savedCompanyId, setBaseCurrency } from '@/lib/api';
import { PRODUCTS } from '@/lib/products';
import { getSupabase } from '@/lib/supabase';

type Company = { id: string; name: string; role: string };
type Me = { user: { email: string }; tenant: Company; tenants: Company[] };

// Each page wraps itself in the shell, so the account is kept here between pages.
// A page shown after the first then draws at once and checks the account again quietly.
// Switching company reloads the page, which clears this.
let cached: { userId: string; me: Me } | null = null;

export default function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(() => cached?.me || null);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      const { data } = await getSupabase().auth.getSession();
      if (!data.session) {
        cached = null;
        return router.replace('/login');
      }
      // Never show one person's account to another who signed in on the same tab
      if (cached && cached.userId !== data.session.user.id) {
        cached = null;
        setMe(null);
      }

      try {
        // Both start at once; the currency is only kept if it was for the company shown
        const asked = savedCompanyId();
        const [account, early] = await Promise.all([
          api.get('/api/me'),
          asked ? api.get('/api/accounting/currencies').catch(() => null) : Promise.resolve(null)
        ]);
        if (!account.tenant) {
          cached = null;
          return router.replace('/onboarding');
        }
        rememberCompany(account.tenant.id);
        const currencies = early && asked === account.tenant.id
          ? early
          : await api.get('/api/accounting/currencies').catch(() => null);
        if (currencies) setBaseCurrency(currencies.base);
        cached = { userId: data.session.user.id, me: account };
        setMe(account);
      } catch (err: any) {
        if (err.status === 401) {
          cached = null;
          return router.replace('/login');
        }
        // A failed quiet check leaves the page that is already shown
        if (!cached) setError(err.message);
      }
    };
    load();
  }, []);

  const signOut = async () => {
    cached = null;
    await getSupabase().auth.signOut();
    router.replace('/login');
  };

  const chooseCompany = (id: string) => {
    if (id === 'new') router.push('/onboarding');
    else openCompany(id);
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
          <Link href="/saas/team" className={router.pathname === '/saas/team' ? 'active' : ''}>Team</Link>
        </nav>
        <div className="account">
          <select aria-label="Company" value={me.tenant.id} onChange={(e) => chooseCompany(e.target.value)}>
            {me.tenants.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
            <option value="new">Add a company…</option>
          </select>
          <NotificationBell />
          <span>{me.user.email}</span>
          <button className="link" onClick={signOut}>Sign out</button>
        </div>
      </header>
      <main className={`page ${me.tenant.role === 'viewer' ? 'read-only' : ''}`}>{children}</main>
    </>
  );
}
