import Link from 'next/link';
import { useRouter } from 'next/router';
import { ReactNode, createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { celebrate } from '@/components/Celebrate';
import CommandPalette, { openPalette, rememberRecent } from '@/components/CommandPalette';
import Icon from '@/components/Icon';
import InstallAppButton from '@/components/InstallAppButton';
import NotificationBell from '@/components/NotificationBell';
import { ShortcutsSheet, useShortcuts } from '@/components/Shortcuts';
import Skeleton, { SkeletonPage } from '@/components/Skeleton';
import { api, openCompany, rememberCompany, savedCompanyId, setBaseCurrency } from '@/lib/api';
import { NAV_FOOT, NAV_GROUPS, NavProduct, PAGE_INDEX, groupFor, productFor, sectionFor } from '@/lib/nav';
import { finishSetup, useSetup } from '@/lib/setup';
import { getSupabase } from '@/lib/supabase';
import { ThemePref, getThemePref, onThemeChange, resolveTheme, setThemePref } from '@/lib/theme';
import { isMac, store, useDismiss } from '@/lib/ui';

type Company = { id: string; name: string; role: string };
type Me = { user: { email: string }; tenant: Company; tenants: Company[] };

// What a page inside the shell knows about who is signed in. useAccount() returns null
// on pages outside the shell.
type Account = { me: Me; tenantId: string; role: string; canEdit: boolean; isManager: boolean };
const AccountContext = createContext<Account | null>(null);
export const useAccount = () => useContext(AccountContext);

// Each page wraps itself in the shell, so the account is kept here between pages.
// A page shown after the first then draws at once and checks the account again quietly.
// Switching company reloads the page, which clears this.
let cached: { userId: string; me: Me } | null = null;

// The sidebar is drawn again on every page, so where it was scrolled is kept here
let sidebarScroll = 0;
const COLLAPSED_KEY = 'getly:sidebar-collapsed';

const initials = (text: string) =>
  text.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?';

const ROLE_NAMES: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' };

export default function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(() => cached?.me || null);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [help, setHelp] = useState(false);

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

  // Read before paint so a collapsed sidebar doesn't flash open
  useIsoLayoutEffect(() => {
    setCollapsed(store.get(COLLAPSED_KEY, false));
  }, []);

  const toggleSidebar = () => {
    if (window.matchMedia('(max-width: 900px)').matches) return setDrawer((open) => !open);
    setCollapsed((now) => {
      store.set(COLLAPSED_KEY, !now);
      return !now;
    });
  };

  // Escape closes the phone menu
  useEffect(() => {
    if (!drawer) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawer(false);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [drawer]);

  const showHelp = useCallback(() => setHelp(true), []);
  useShortcuts({ onHelp: showHelp });

  // Remember pages for the palette's "Recent" group
  useEffect(() => {
    const page = PAGE_INDEX.find(({ path }) => path === router.pathname);
    if (page && me) rememberRecent({ id: page.id, title: page.title, hint: page.hint === 'App' ? undefined : page.hint, icon: page.icon, path: page.path });
  }, [router.pathname, Boolean(me)]);

  // "?new=1" opens the page's own "New ..." form, then tidies the address
  useEffect(() => {
    if (!me || router.query.new !== '1') return;
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>('#main .page-head button.primary'))
        .find((item) => !item.disabled && /^(New|Add)\b/.test(item.textContent?.trim() || ''));
      if (button || tries > 50) {
        clearInterval(timer);
        button?.click();
        const url = new URL(window.location.href);
        url.searchParams.delete('new');
        router.replace(`${url.pathname}${url.search}${url.hash}`, undefined, { shallow: true, scroll: false });
      }
    }, 100);
    return () => clearInterval(timer);
  }, [Boolean(me), router.query.new]);

  const signOut = async () => {
    cached = null;
    await getSupabase().auth.signOut();
    router.replace('/login');
  };

  if (error) {
    return (
      <div className="auth">
        <div className="card auth-card">
          <h1>We couldn&apos;t open your account</h1>
          <p className="error">{error}</p>
          <div className="form-actions"><button className="primary" onClick={() => window.location.reload()}>Try again</button></div>
        </div>
      </div>
    );
  }

  if (!me) return <ShellSkeleton collapsed={collapsed} />;

  const role = me.tenant.role;
  const account: Account = {
    me,
    tenantId: me.tenant.id,
    role,
    canEdit: role !== 'viewer',
    isManager: role === 'owner' || role === 'admin'
  };

  return (
    <AccountContext.Provider value={account}>
      <a href="#main" className="skip-link">Skip to content</a>
      <div className={`shell ${collapsed ? 'is-collapsed' : ''} ${drawer ? 'drawer-open' : ''}`}>
        <Sidebar me={me} collapsed={collapsed} onNavigate={() => setDrawer(false)} onHelp={showHelp} />
        <div className="sidebar-scrim" onClick={() => setDrawer(false)} aria-hidden="true" />
        <div className="shell-body">
          <TopBar me={me} onToggle={toggleSidebar} drawer={drawer} onHelp={showHelp} onSignOut={signOut} />
          <div className="shell-scroll">
            <main id="main" tabIndex={-1} className={`page ${role === 'viewer' ? 'read-only' : ''}`}>{children}</main>
          </div>
        </div>
      </div>
      <CommandPalette onShortcuts={showHelp} />
      {help && <ShortcutsSheet onClose={() => setHelp(false)} />}
    </AccountContext.Provider>
  );
}

// useLayoutEffect warns during the server render, where it can't run anyway
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function Sidebar({ me, collapsed, onNavigate, onHelp }: { me: Me; collapsed: boolean; onNavigate: () => void; onHelp: () => void }) {
  const router = useRouter();
  const { pathname } = router;
  const scroller = useRef<HTMLElement>(null);
  const current = productFor(pathname);
  const section = sectionFor(pathname, current);

  useIsoLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = sidebarScroll;
  }, []);

  const chooseCompany = (id: string) => {
    if (id === 'new') router.push('/onboarding');
    else openCompany(id);
  };

  const link = (product: NavProduct) => {
    const active = current?.key === product.key;
    return (
      <li key={product.key}>
        <Link
          href={product.path}
          className={`side-link ${active ? 'is-active' : ''}`}
          aria-current={active && pathname === product.path ? 'page' : undefined}
          data-tip={product.name}
          onClick={onNavigate}
        >
          <Icon name={product.icon} />
          <span className="side-label">{product.name}</span>
        </Link>
        {active && !collapsed && <Sections product={product} section={section?.path} onNavigate={onNavigate} />}
      </li>
    );
  };

  return (
    <aside className="sidebar" id="sidebar" aria-label="Main menu">
      <div className="sidebar-top">
        <div className="company-switch" title="Switch company">
          <span className="company-avatar" aria-hidden="true">{initials(me.tenant.name)}</span>
          <span className="company-text">
            <strong>{me.tenant.name}</strong>
            <small>{ROLE_NAMES[me.tenant.role] || me.tenant.role}</small>
          </span>
          <Icon name="chevrons-up-down" size={16} className="company-caret" />
          <select aria-label="Company" value={me.tenant.id} onChange={(e) => chooseCompany(e.target.value)}>
            {me.tenants.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
            <option value="new">Add a company…</option>
          </select>
        </div>
      </div>

      <SetupBar tenantId={me.tenant.id} onNavigate={onNavigate} />

      <nav className="sidebar-nav" ref={scroller} onScroll={(e) => { sidebarScroll = e.currentTarget.scrollTop; }}>
        {NAV_GROUPS.map((group) => (
          <div className="side-group" key={group.label || 'top'}>
            {group.label && <div className="side-group-label">{group.label}</div>}
            <ul>{group.items.map(link)}</ul>
          </div>
        ))}
      </nav>

      <div className="sidebar-foot">
        <ul>
          <li>
            <button type="button" className="side-link always" data-tip="Help and shortcuts" onClick={onHelp}>
              <Icon name="help" />
              <span className="side-label">Help and shortcuts</span>
            </button>
          </li>
          {NAV_FOOT.map(link)}
        </ul>
      </div>
    </aside>
  );
}

function Sections({ product, section, onNavigate }: { product: NavProduct; section?: string; onNavigate: () => void }) {
  if (product.groups) {
    const open = groupFor(product, section ? { name: '', path: section } : undefined);
    return (
      <ul className="side-sections">
        {product.groups.map((group) => (
          <li key={group.name}>
            <Link href={group.sections[0].path} className={`side-sub is-group ${group === open ? 'is-open' : ''}`} onClick={onNavigate}>
              {group.name}
            </Link>
            {group === open && (
              <ul className="side-sections nested">
                {group.sections.map(({ name, path }) => (
                  <li key={path}>
                    <Link href={path} className={`side-sub ${section === path ? 'is-active' : ''}`} aria-current={section === path ? 'page' : undefined} onClick={onNavigate}>{name}</Link>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    );
  }
  if (!product.sections?.length) return null;
  return (
    <ul className="side-sections">
      {product.sections.map(({ name, path }) => (
        <li key={path}>
          <Link href={path} className={`side-sub ${section === path ? 'is-active' : ''}`} aria-current={section === path ? 'page' : undefined} onClick={onNavigate}>{name}</Link>
        </li>
      ))}
    </ul>
  );
}

// "Set up your account, 4/7 completed", until everything is done. Then it shows once
// with a small celebration and is gone on the next visit.
function SetupBar({ tenantId, onNavigate }: { tenantId: string; onNavigate: () => void }) {
  const setup = useSetup(tenantId);
  const box = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (setup.complete && !setup.finished && finishSetup(tenantId)) {
      // Wait a beat so it lands after the page has drawn
      setTimeout(() => celebrate({ from: box.current }), 300);
    }
  }, [setup.complete]);

  const showing = setup.total > 0 && !setup.hidden && (!setup.finished || setup.justFinished);
  if (!showing) return null;
  const percent = Math.round((setup.done / setup.total) * 100);

  return (
    <Link href="/saas/today#setup" className={`setup-bar ${setup.complete ? 'is-complete' : ''}`} ref={box} onClick={onNavigate} data-tip={`Setup ${setup.done}/${setup.total}`}>
      <span className="setup-bar-text">
        <strong>{setup.complete ? 'You’re all set' : 'Set up your account'}</strong>
        <small>{setup.done}/{setup.total} completed</small>
      </span>
      <span className="setup-line" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={setup.total} aria-valuenow={setup.done}>
        <span style={{ width: `${percent}%` }} />
      </span>
    </Link>
  );
}

function TopBar({ me, onToggle, drawer, onHelp, onSignOut }: {
  me: Me;
  onToggle: () => void;
  drawer: boolean;
  onHelp: () => void;
  onSignOut: () => void;
}) {
  const { pathname } = useRouter();
  const product = productFor(pathname);
  const section = sectionFor(pathname, product);
  const [mod, setMod] = useState('Ctrl');
  useEffect(() => setMod(isMac() ? '⌘' : 'Ctrl'), []);

  return (
    <header className="topbar app-topbar">
      <button type="button" className="icon-button sidebar-toggle always" aria-label="Show or hide the menu" aria-controls="sidebar" aria-expanded={drawer} onClick={onToggle}>
        <Icon name="sidebar" />
      </button>
      <div className="crumbs" aria-label="You are here">
        {product && (
          <Link href={product.path} className="crumb">
            <Icon name={product.icon} size={16} />
            <span>{product.name}</span>
          </Link>
        )}
        {section && section.path !== product?.path && (
          <>
            <Icon name="chevron-right" size={14} className="crumb-sep" />
            <span className="crumb is-current">{section.name}</span>
          </>
        )}
      </div>
      <button type="button" className="search-trigger always" onClick={() => openPalette()}>
        <Icon name="search" size={16} />
        <span className="search-label">Search or jump to…</span>
        <kbd className="kbd">{mod} K</kbd>
      </button>
      <div className="topbar-actions">
        <Link href="/saas/assistant" className={`button ghost assistant-button ${pathname === '/saas/assistant' ? 'is-active' : ''}`} title="Assistant">
          <Icon name="assistant" size={16} />
          <span className="assistant-label">Assistant</span>
        </Link>
        <NotificationBell />
        <ThemeMenu />
        <AccountMenu me={me} onHelp={onHelp} onSignOut={onSignOut} />
      </div>
    </header>
  );
}

const THEMES: { pref: ThemePref; label: string; icon: string }[] = [
  { pref: 'light', label: 'Light', icon: 'sun' },
  { pref: 'dark', label: 'Dark', icon: 'moon' },
  { pref: 'system', label: 'System', icon: 'monitor' }
];

function useThemePref() {
  const [pref, setPref] = useState<ThemePref>('system');
  useEffect(() => {
    setPref(getThemePref());
    return onThemeChange(setPref);
  }, []);
  return pref;
}

function ThemeMenu() {
  const pref = useThemePref();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, box, () => setOpen(false));
  const shown = pref === 'system' ? 'monitor' : resolveTheme(pref) === 'dark' ? 'moon' : 'sun';

  return (
    <div className="popover-wrap" ref={box}>
      <button type="button" className="icon-button always" aria-label={`Theme: ${pref}`} aria-expanded={open} title="Theme" onClick={() => setOpen(!open)}>
        <Icon name={shown} />
      </button>
      {open && (
        <div className="popover menu" role="group" aria-label="Theme">
          {THEMES.map(({ pref: value, label, icon }) => (
            <button
              key={value}
              type="button"
              className={`menu-item always ${pref === value ? 'is-selected' : ''}`}
              aria-pressed={pref === value}
              onClick={() => { setThemePref(value); setOpen(false); }}
            >
              <Icon name={icon} size={16} />
              <span>{label}</span>
              {pref === value && <Icon name="check" size={16} className="menu-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AccountMenu({ me, onHelp, onSignOut }: { me: Me; onHelp: () => void; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, box, () => setOpen(false));

  return (
    <div className="popover-wrap" ref={box}>
      <button type="button" className="avatar-button always" aria-label="Your account" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="avatar">{initials(me.user.email)}</span>
      </button>
      {open && (
        <div className="popover menu account-menu">
          <div className="menu-head">
            <span className="avatar is-large">{initials(me.user.email)}</span>
            <div>
              <strong>{me.user.email}</strong>
              <small>{me.tenant.name} · {ROLE_NAMES[me.tenant.role] || me.tenant.role}</small>
            </div>
          </div>
          <div className="menu-sep" />
          <Link href="/saas/team" className="menu-item" onClick={() => setOpen(false)}><Icon name="settings" size={16} /><span>Team and settings</span></Link>
          <button type="button" className="menu-item always" onClick={() => { setOpen(false); onHelp(); }}><Icon name="keyboard" size={16} /><span>Keyboard shortcuts</span></button>
          <div className="menu-install"><InstallAppButton /></div>
          <div className="menu-sep" />
          <button type="button" className="menu-item always" onClick={onSignOut}><Icon name="logout" size={16} /><span>Sign out</span></button>
        </div>
      )}
    </div>
  );
}

function ShellSkeleton({ collapsed }: { collapsed: boolean }) {
  return (
    <div className={`shell is-loading ${collapsed ? 'is-collapsed' : ''}`} aria-busy="true">
      <aside className="sidebar" aria-hidden="true">
        <div className="sidebar-top">
          <div className="company-switch">
            <Skeleton width={32} height={32} radius={8} />
            <span className="company-text"><Skeleton width={110} height={12} /><Skeleton width={60} height={10} style={{ marginTop: 6 }} /></span>
          </div>
        </div>
        <div className="sidebar-nav">
          {Array.from({ length: 10 }, (_, n) => (
            <div className="side-link" key={n}><Skeleton width={18} height={18} radius={5} /><span className="side-label"><Skeleton width={`${50 + ((n * 37) % 40)}%`} height={11} /></span></div>
          ))}
        </div>
      </aside>
      <div className="shell-body">
        <header className="topbar app-topbar" aria-hidden="true">
          <Skeleton width={28} height={28} radius={8} />
          <Skeleton width={140} height={12} />
          <div className="search-trigger is-skeleton"><Skeleton width="60%" height={12} /></div>
        </header>
        <div className="shell-scroll">
          <main className="page"><SkeletonPage /></main>
        </div>
      </div>
    </div>
  );
}
