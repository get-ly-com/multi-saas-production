import Link from 'next/link';
import { useRouter } from 'next/router';
import { ReactNode, useEffect, useState } from 'react';
import NotificationBell from '@/components/NotificationBell';
import { api, openCompany, rememberCompany, savedCompanyId, setBaseCurrency } from '@/lib/api';
import { getSupabase } from '@/lib/supabase';

const PRODUCTS = [
  { name: 'Accounting', path: '/saas/accounting' },
  { name: 'CRM', path: '/saas/crm' },
  { name: 'Inventory', path: '/saas/inventory' },
  { name: 'HR', path: '/saas/hr' },
  { name: 'Scheduler', path: '/saas/scheduler' },
  { name: 'Meetings', path: '/saas/video' },
  { name: 'Chat', path: '/saas/chat' },
  { name: 'Social', path: '/saas/social' },
  { name: 'Analytics', path: '/saas/analytics' },
  { name: 'Integrations', path: '/saas/integrations' }
];

type Company = { id: string; name: string; role: string };
type Me = { user: { email: string }; tenant: Company; tenants: Company[] };

export default function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      const { data } = await getSupabase().auth.getSession();
      if (!data.session) return router.replace('/login');

      try {
        // Both start at once; the currency is only kept if it was for the company shown
        const asked = savedCompanyId();
        const [account, early] = await Promise.all([
          api.get('/api/me'),
          asked ? api.get('/api/accounting/currencies').catch(() => null) : Promise.resolve(null)
        ]);
        if (!account.tenant) return router.replace('/onboarding');
        rememberCompany(account.tenant.id);
        const currencies = early && asked === account.tenant.id
          ? early
          : await api.get('/api/accounting/currencies').catch(() => null);
        if (currencies) setBaseCurrency(currencies.base);
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
