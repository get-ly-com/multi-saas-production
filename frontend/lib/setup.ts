import { useEffect, useState } from 'react';
import { cachedGet } from '@/lib/cache';
import { store } from '@/lib/ui';

// The "Getting started" checklist. Every step is worked out from the company's real data,
// so it ticks itself the moment the thing is done anywhere in the app. A step the person
// can't see (the API says 403) is left out rather than shown as undone.

export type Step = { key: string; title: string; line: string; href: string; minutes: number; done: boolean };

const STEPS: (Omit<Step, 'done'> & { path: string; check: (data: any) => boolean })[] = [
  {
    key: 'customer', title: 'Add your first customer', line: 'Keep the people you sell to in one place.',
    href: '/saas/accounting/customers?new=1', minutes: 1, path: '/api/accounting/customers',
    check: (rows) => Array.isArray(rows) && rows.length > 0
  },
  {
    key: 'invoice', title: 'Send an invoice', line: 'Customers can pay it online from a link.',
    href: '/saas/accounting?new=1', minutes: 2, path: '/api/accounting/invoices',
    check: (rows) => Array.isArray(rows) && rows.some((row: any) => row.status && row.status !== 'draft')
  },
  {
    key: 'item', title: 'Add a product or service', line: 'Reuse it on invoices and track stock.',
    href: '/saas/inventory?new=1', minutes: 1, path: '/api/inventory/items',
    check: (rows) => Array.isArray(rows) && rows.length > 0
  },
  {
    key: 'employee', title: 'Add an employee', line: 'Leave, expenses and payroll start here.',
    href: '/saas/hr?new=1', minutes: 2, path: '/api/hr/employees',
    check: (rows) => Array.isArray(rows) && rows.length > 0
  },
  {
    key: 'booking', title: 'Set up your booking page', line: 'Add a service so customers can book you.',
    href: '/saas/scheduler/services', minutes: 3, path: '/api/scheduler/services',
    check: (rows) => Array.isArray(rows) && rows.length > 0
  },
  {
    key: 'chat', title: 'Turn on website chat', line: 'Answer visitors while they are still looking.',
    href: '/saas/chat/settings', minutes: 2, path: '/api/chatbot/settings',
    check: (settings) => Boolean(settings?.enabled)
  },
  {
    key: 'invite', title: 'Invite a teammate', line: 'Work together with the right access for each person.',
    href: '/saas/team', minutes: 1, path: '/api/team',
    check: (team) => (team?.members?.length || 0) > 1 || (team?.invites?.length || 0) > 0
  }
];

const doneKey = (tenant: string) => `getly:setup-done:${tenant}`;
const hiddenKey = (tenant: string) => `getly:setup-hidden:${tenant}`;
const MAX_AGE = 60_000;

type State = { steps: Step[]; loading: boolean };
let kept: { tenant: string; at: number; steps: Step[] } | null = null;
const listeners = new Set<() => void>();

const load = async (tenant: string, fresh = false) => {
  if (!fresh && kept?.tenant === tenant && Date.now() - kept.at < MAX_AGE) return kept.steps;
  const results = await Promise.all(STEPS.map(async (step) => {
    try {
      const data = await cachedGet(step.path, fresh ? 0 : 30_000);
      return { key: step.key, title: step.title, line: step.line, href: step.href, minutes: step.minutes, done: step.check(data) };
    } catch {
      // No access, or the app is unavailable: leave the step out
      return null;
    }
  }));
  const steps = results.filter(Boolean) as Step[];
  kept = { tenant, at: Date.now(), steps };
  listeners.forEach((listener) => listener());
  return steps;
};

// finished: every step is done and the celebration has already been shown once
export const setupFinished = (tenant: string) => store.get(doneKey(tenant), false);

// True for the rest of this visit after setup was finished, so the "all set" state
// shows once and is gone on the next visit
let justFinished = false;

// Returns true the first time only, which is when to celebrate
export const finishSetup = (tenant: string) => {
  if (setupFinished(tenant)) return false;
  store.set(doneKey(tenant), true);
  justFinished = true;
  listeners.forEach((listener) => listener());
  return true;
};
export const setupHidden = (tenant: string) => store.get(hiddenKey(tenant), false);
export const hideSetup = (tenant: string) => {
  store.set(hiddenKey(tenant), true);
  listeners.forEach((listener) => listener());
};
export const showSetup = (tenant: string) => {
  store.remove(hiddenKey(tenant));
  listeners.forEach((listener) => listener());
};

export const useSetup = (tenant: string | undefined, { fresh = false } = {}) => {
  const [state, setState] = useState<State>(() => ({
    steps: kept && kept.tenant === tenant ? kept.steps : [],
    loading: !(kept && kept.tenant === tenant)
  }));
  const [, redraw] = useState(0);

  useEffect(() => {
    if (!tenant) return;
    const update = () => {
      if (kept?.tenant === tenant) setState({ steps: kept.steps, loading: false });
      redraw((n) => n + 1);
    };
    listeners.add(update);
    if (!setupFinished(tenant)) {
      load(tenant, fresh).then(update).catch(() => setState((old) => ({ ...old, loading: false })));
    } else setState({ steps: [], loading: false });
    return () => { listeners.delete(update); };
  }, [tenant]);

  const done = state.steps.filter((step) => step.done).length;
  const total = state.steps.length;
  return {
    ...state,
    done,
    total,
    complete: total > 0 && done === total,
    finished: tenant ? setupFinished(tenant) : false,
    justFinished,
    hidden: tenant ? setupHidden(tenant) : false
  };
};
