import { useRouter } from 'next/router';
import { Fragment, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from '@/components/Icon';
import { api, money } from '@/lib/api';
import { cachedGet } from '@/lib/cache';
import { PAGE_INDEX, QUICK_ACTIONS } from '@/lib/nav';
import { ThemePref, setThemePref } from '@/lib/theme';
import { isMac, store, trapTab, useReturnFocus, useScrollLock } from '@/lib/ui';

// Ctrl+K or Cmd+K anywhere in the app. Jump to any page, run a quick action, or find a
// record. Other code can open it with openPalette(), optionally with text already typed.

const OPEN_EVENT = 'getly:palette';
const RECENT_KEY = 'getly:recent';
const MAX_RECENT = 5;
const MAX_RECORDS = 12;

export const openPalette = (query = '') => window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: query }));

type Item = {
  id: string;
  group: string;
  title: string;
  hint?: string;
  icon: string;
  keys?: string[];
  path?: string;
  run?: () => void;
};

type Recent = { id: string; title: string; hint?: string; icon: string; path: string };

// Remember a page or record for the "Recent" group
export const rememberRecent = (entry: Recent) => {
  const list = store.get<Recent[]>(RECENT_KEY, []).filter((item) => item.path !== entry.path);
  store.set(RECENT_KEY, [entry, ...list].slice(0, 12));
};

// Substring matches first. Otherwise each letter must either follow the one before it or
// start a word, so "gl" finds "General ledger" but "acme" doesn't find "Match the theme".
// 0 means no match.
const WORD_START = /[\s/·()-]/;
export const fuzzyScore = (query: string, text: string) => {
  const q = query.toLowerCase().trim().replace(/\s+/g, ' ');
  const t = text.toLowerCase();
  if (!q) return 1;
  const at = t.indexOf(q);
  if (at === 0) return 1000 - t.length;
  if (at > 0) return (WORD_START.test(t[at - 1]) ? 800 : 500) - at;
  let score = 0;
  let from = 0;
  for (const char of q.replace(/ /g, '')) {
    let found = -1;
    if (t[from] === char && from > 0) found = from;
    else {
      for (let n = from; n < t.length; n++) {
        if (t[n] === char && (n === 0 || WORD_START.test(t[n - 1]))) { found = n; break; }
      }
    }
    if (found < 0) return 0;
    score += found === from ? 20 : 12;
    from = found + 1;
  }
  return score;
};

const THEME_ACTIONS: { pref: ThemePref; title: string; icon: string }[] = [
  { pref: 'light', title: 'Use the light theme', icon: 'sun' },
  { pref: 'dark', title: 'Use the dark theme', icon: 'moon' },
  { pref: 'system', title: 'Match the system theme', icon: 'monitor' }
];

const searchRecords = async (text: string): Promise<Item[]> => {
  const needle = text.toLowerCase();
  const has = (...values: (string | null | undefined)[]) => values.some((value) => value && String(value).toLowerCase().includes(needle));
  // Each source is on its own: one that fails or is off limits is just left out
  const safe = <T,>(work: Promise<T>) => work.catch(() => null);

  const [crm, invoices, customers, items] = await Promise.all([
    safe(api.get(`/api/crm/search?q=${encodeURIComponent(text)}`)),
    safe(cachedGet('/api/accounting/invoices', 60_000)),
    safe(cachedGet('/api/accounting/customers', 60_000)),
    safe(cachedGet('/api/inventory/items', 60_000))
  ]);

  const found: Item[] = [];
  if (crm) {
    for (const row of crm.contacts || []) found.push({ id: `contact:${row.id}`, group: 'Records', title: row.name, hint: 'Contact', icon: 'contact', path: `/saas/crm/contact/${row.id}` });
    for (const row of crm.leads || []) found.push({ id: `lead:${row.id}`, group: 'Records', title: row.name, hint: 'Lead', icon: 'lead', path: `/saas/crm/lead/${row.id}` });
    for (const row of crm.companies || []) found.push({ id: `company:${row.id}`, group: 'Records', title: row.name, hint: 'Company', icon: 'company', path: `/saas/crm/company/${row.id}` });
    for (const row of crm.deals || []) found.push({ id: `deal:${row.id}`, group: 'Records', title: row.title, hint: 'Deal', icon: 'deal', path: `/saas/crm/deal/${row.id}` });
  }
  if (Array.isArray(invoices)) {
    invoices.filter((row: any) => has(row.invoice_number, row.customer_name)).slice(0, 4).forEach((row: any) => found.push({
      id: `invoice:${row.id}`, group: 'Records', title: `${row.invoice_number}${row.customer_name ? ` · ${row.customer_name}` : ''}`,
      hint: `Invoice · ${money(row.amount, row.currency)}`, icon: 'invoice', path: `/saas/accounting/invoice/${row.id}`
    }));
  }
  if (Array.isArray(customers)) {
    customers.filter((row: any) => has(row.name, row.email)).slice(0, 3).forEach((row: any) => found.push({
      id: `customer:${row.id}`, group: 'Records', title: row.name, hint: 'Customer', icon: 'crm', path: '/saas/accounting/customers'
    }));
  }
  if (Array.isArray(items)) {
    items.filter((row: any) => has(row.name, row.sku, row.barcode)).slice(0, 3).forEach((row: any) => found.push({
      id: `item:${row.id}`, group: 'Records', title: row.name, hint: `Item${row.sku ? ` · ${row.sku}` : ''}`, icon: 'item', path: '/saas/inventory'
    }));
  }
  return found.slice(0, MAX_RECORDS);
};

export default function CommandPalette({ onShortcuts }: { onShortcuts: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [records, setRecords] = useState<Item[]>([]);
  const [searching, setSearching] = useState(false);
  const [recent, setRecent] = useState<Recent[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);
  openRef.current = open;

  useReturnFocus(open, box, input);
  useScrollLock(open);

  useEffect(() => {
    const show = (event: Event) => {
      setQuery((event as CustomEvent).detail || '');
      setActive(0);
      setRecent(store.get<Recent[]>(RECENT_KEY, []));
      setOpen(true);
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (openRef.current) return setOpen(false);
        setQuery('');
        setActive(0);
        setRecent(store.get<Recent[]>(RECENT_KEY, []));
        setOpen(true);
      }
    };
    window.addEventListener(OPEN_EVENT, show);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener(OPEN_EVENT, show);
      window.removeEventListener('keydown', key);
    };
  }, []);

  // Records come from the server, a moment after typing stops
  useEffect(() => {
    const text = query.trim();
    if (!open || text.length < 2) {
      setRecords([]);
      setSearching(false);
      return;
    }
    let current = true;
    setSearching(true);
    const timer = setTimeout(() => {
      searchRecords(text)
        .then((found) => current && setRecords(found))
        .finally(() => current && setSearching(false));
    }, 220);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, open]);

  const close = () => setOpen(false);

  const items = useMemo<Item[]>(() => {
    const text = query.trim();
    const actions: Item[] = [
      ...QUICK_ACTIONS.map((action) => ({ id: action.id, group: 'Quick actions', title: action.title, icon: action.icon, keys: action.keys, path: action.path })),
      { id: 'ask', group: 'Quick actions', title: 'Ask the assistant', icon: 'assistant', path: '/saas/assistant' },
      { id: 'shortcuts', group: 'Quick actions', title: 'Keyboard shortcuts', icon: 'keyboard', keys: ['?'], run: onShortcuts },
      ...THEME_ACTIONS.map(({ pref, title, icon }) => ({ id: `theme:${pref}`, group: 'Quick actions', title, icon, run: () => setThemePref(pref) }))
    ];
    const pages: Item[] = PAGE_INDEX.map((page) => ({ id: page.id, group: 'Go to', title: page.title, hint: page.hint === 'App' ? undefined : page.hint, icon: page.icon, path: page.path, words: page.words } as Item & { words: string }));

    if (!text) {
      const recents: Item[] = recent
        .filter((item) => item.path !== router.asPath)
        .slice(0, MAX_RECENT)
        .map((item) => ({ ...item, id: `recent:${item.id}`, group: 'Recent' }));
      return [
        ...recents,
        ...actions.filter(({ id }) => id.startsWith('new:')).slice(0, 4),
        ...pages.filter(({ hint }) => !hint)
      ];
    }

    const rank = (list: (Item & { words?: string })[], limit: number) => list
      .map((item) => ({
        item,
        score: Math.max(fuzzyScore(text, item.title), fuzzyScore(text, `${item.hint || ''} ${item.title}`) * 0.8, fuzzyScore(text, item.words || '') * 0.5)
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ item }) => item);

    return [...rank(actions, 4), ...rank(pages, 8), ...records];
  }, [query, records, recent, open]);

  useEffect(() => {
    if (active >= items.length) setActive(Math.max(0, items.length - 1));
  }, [items.length]);

  // Keep the highlighted row in view
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    close();
    if (item.run) return item.run();
    if (item.path) {
      if (!item.id.startsWith('new:') && item.id !== 'ask') {
        rememberRecent({ id: item.id.replace(/^recent:/, ''), title: item.title, hint: item.hint, icon: item.icon, path: item.path });
      }
      router.push(item.path);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      return close();
    }
    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
      event.preventDefault();
      setActive((n) => (items.length ? (n + 1) % items.length : 0));
    } else if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      event.preventDefault();
      setActive((n) => (items.length ? (n - 1 + items.length) % items.length : 0));
    } else if (event.key === 'Home' && event.ctrlKey) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End' && event.ctrlKey) {
      event.preventDefault();
      setActive(items.length - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(items[active]);
    } else trapTab(event, box.current);
  };

  if (!open) return null;

  const groups: { name: string; rows: { item: Item; index: number }[] }[] = [];
  items.forEach((item, index) => {
    const last = groups[groups.length - 1];
    if (last && last.name === item.group) last.rows.push({ item, index });
    else groups.push({ name: item.group, rows: [{ item, index }] });
  });
  const showRecordsNote = query.trim().length >= 2 && (searching || !records.length);
  const activeId = items[active] ? `palette-${active}` : undefined;
  const mod = isMac() ? '⌘' : 'Ctrl';

  return createPortal(
    <div className="palette-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search or jump to" ref={box} onKeyDown={onKeyDown}>
        <div className="palette-search">
          <Icon name="search" size={18} />
          <input
            ref={input}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActive(0); }}
            placeholder="Search or jump to…"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label="Search or jump to"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="kbd">{mod} K</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" aria-label="Results" ref={list}>
          {groups.map((group) => (
            <div role="group" aria-labelledby={`palette-group-${group.name}`} key={group.name}>
              <div className="palette-group" id={`palette-group-${group.name}`} role="presentation">{group.name}</div>
              {group.rows.map(({ item, index }) => (
                <div
                  key={item.id}
                  id={`palette-${index}`}
                  data-index={index}
                  role="option"
                  aria-selected={index === active}
                  className={`palette-item ${index === active ? 'is-active' : ''}`}
                  onMouseMove={() => index !== active && setActive(index)}
                  onClick={() => choose(item)}
                >
                  <span className="palette-icon"><Icon name={item.icon} size={16} /></span>
                  <span className="palette-title">{item.title}</span>
                  {item.hint && <span className="palette-hint">{item.hint}</span>}
                  {item.keys && (
                    <span className="palette-keys" aria-label={`Shortcut ${item.keys.join(' then ')}`}>
                      {item.keys.map((key, n) => <Fragment key={n}><kbd className="kbd">{key.toUpperCase()}</kbd></Fragment>)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))}
          {showRecordsNote && (
            <div className="palette-note" role="presentation">
              {searching ? 'Searching your records…' : 'No records match. Try a name, an invoice number or a SKU.'}
            </div>
          )}
          {!items.length && !showRecordsNote && <div className="palette-note">Nothing matches “{query}”.</div>}
        </div>
        <div className="palette-foot" aria-hidden="true">
          <span><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> Navigate</span>
          <span><kbd className="kbd">↵</kbd> Open</span>
          <span><kbd className="kbd">Esc</kbd> Close</span>
        </div>
        <div className="sr-only" aria-live="polite">{items.length} {items.length === 1 ? 'result' : 'results'}</div>
      </div>
    </div>,
    document.body
  );
}
