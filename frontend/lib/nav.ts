// Where everything lives: the sidebar, the breadcrumb, the command palette and the
// "g" shortcuts all read from here. Each product's sections come from its own Nav
// component, so a section added there shows up everywhere.
import { GROUPS as ACCOUNTING } from '@/components/AccountingNav';
import { SECTIONS as ANALYTICS } from '@/components/AnalyticsNav';
import { SECTIONS as CHAT } from '@/components/ChatNav';
import { SECTIONS as CRM } from '@/components/CrmNav';
import { SECTIONS as HR } from '@/components/HrNav';
import { SECTIONS as INTEGRATIONS } from '@/components/IntegrationsNav';
import { SECTIONS as INVENTORY } from '@/components/InventoryNav';
import { SECTIONS as SCHEDULER } from '@/components/SchedulerNav';
import { SECTIONS as SOCIAL } from '@/components/SocialNav';

export type Section = { name: string; path: string };
export type SectionGroup = { name: string; sections: Section[] };
export type NavProduct = {
  key: string;
  name: string;
  path: string;
  icon: string;
  // The second key of the "g" shortcut, so "g a" opens Accounting
  key2?: string;
  groups?: SectionGroup[];
  sections?: Section[];
  // Extra words the command palette matches
  words?: string;
};

export const TODAY: NavProduct = { key: 'today', name: 'Today', path: '/saas/today', icon: 'today', key2: 't', words: 'home start dashboard' };

const P = {
  assistant: { key: 'assistant', name: 'Assistant', path: '/saas/assistant', icon: 'assistant', key2: 'q', words: 'ai ask help to do' },
  brain: { key: 'brain', name: 'Brain', path: '/saas/brain', icon: 'brain', key2: 'b', words: 'ai ideas advice suggestions approve forecast what if mcp' },
  crm: { key: 'crm', name: 'CRM', path: '/saas/crm', icon: 'crm', key2: 'c', sections: CRM, words: 'sales customers contacts deals' },
  chat: { key: 'chat', name: 'Chat', path: '/saas/chat', icon: 'chat', key2: 'l', sections: CHAT, words: 'live chat inbox support tickets' },
  social: { key: 'social', name: 'Social', path: '/saas/social', icon: 'social', key2: 'p', sections: SOCIAL, words: 'posts marketing' },
  accounting: { key: 'accounting', name: 'Accounting', path: '/saas/accounting', icon: 'accounting', key2: 'a', groups: ACCOUNTING, words: 'money books invoices finance' },
  inventory: { key: 'inventory', name: 'Inventory', path: '/saas/inventory', icon: 'inventory', key2: 'i', sections: INVENTORY, words: 'stock items products' },
  hr: { key: 'hr', name: 'HR', path: '/saas/hr', icon: 'hr', key2: 'h', sections: HR, words: 'people staff employees' },
  scheduler: { key: 'scheduler', name: 'Scheduler', path: '/saas/scheduler', icon: 'scheduler', key2: 's', sections: SCHEDULER, words: 'bookings calendar appointments' },
  meetings: { key: 'meetings', name: 'Meetings', path: '/saas/video', icon: 'meetings', key2: 'm', words: 'video calls' },
  analytics: { key: 'analytics', name: 'Analytics', path: '/saas/analytics', icon: 'analytics', key2: 'n', sections: ANALYTICS, words: 'numbers reports insights' },
  integrations: { key: 'integrations', name: 'Integrations', path: '/saas/integrations', icon: 'integrations', key2: 'x', sections: INTEGRATIONS, words: 'api webhooks keys connect' },
  import: { key: 'import', name: 'Import', path: '/saas/import', icon: 'import', words: 'csv upload spreadsheet' },
  team: { key: 'team', name: 'Team and settings', path: '/saas/team', icon: 'settings', key2: 'u', words: 'members invite roles company' }
} satisfies Record<string, NavProduct>;

// The sidebar, top to bottom. A group with no label sits at the top.
export const NAV_GROUPS: { label: string; items: NavProduct[] }[] = [
  { label: '', items: [TODAY, P.assistant, P.brain] },
  { label: 'Sales', items: [P.crm, P.chat, P.social] },
  { label: 'Money', items: [P.accounting, P.inventory] },
  { label: 'People', items: [P.hr, P.scheduler, P.meetings] },
  { label: 'Workspace', items: [P.analytics, P.integrations, P.import] }
];

// Pinned to the bottom of the sidebar
export const NAV_FOOT: NavProduct[] = [P.team];

export const ALL_PRODUCTS: NavProduct[] = [...NAV_GROUPS.flatMap(({ items }) => items), ...NAV_FOOT];

export const sectionsOf = (product: NavProduct): Section[] =>
  product.groups ? product.groups.flatMap(({ sections }) => sections) : product.sections || [];

export const productFor = (pathname: string): NavProduct | undefined =>
  ALL_PRODUCTS
    .filter(({ path }) => pathname === path || pathname.startsWith(`${path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];

// Record pages belong to the list they were opened from
const DETAIL: [string, string][] = [
  ['/saas/crm/contact/', '/saas/crm/contacts'],
  ['/saas/crm/company/', '/saas/crm/companies'],
  ['/saas/crm/deal/', '/saas/crm/pipeline'],
  ['/saas/crm/lead/', '/saas/crm/leads'],
  ['/saas/crm/quote/', '/saas/crm/quotes'],
  ['/saas/accounting/invoice/', '/saas/accounting'],
  ['/saas/hr/employee/', '/saas/hr'],
  ['/saas/hr/payroll/', '/saas/hr/payroll'],
  ['/saas/hr/payslip/', '/saas/hr/payroll'],
  ['/saas/inventory/counts/', '/saas/inventory/counts']
];

export const sectionFor = (pathname: string, product?: NavProduct): Section | undefined => {
  if (!product) return undefined;
  const sections = sectionsOf(product);
  const exact = sections.find(({ path }) => path === pathname);
  if (exact) return exact;
  const detail = DETAIL.find(([prefix]) => pathname.startsWith(prefix));
  if (detail) return sections.find(({ path }) => path === detail[1]);
  return sections
    .filter(({ path }) => path !== product.path && pathname.startsWith(`${path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
};

export const groupFor = (product: NavProduct, section?: Section) =>
  product.groups?.find(({ sections }) => sections.some(({ path }) => path === section?.path)) || product.groups?.[0];

// Every page, for the command palette
export type PageEntry = { id: string; title: string; hint: string; path: string; icon: string; words: string };

export const PAGE_INDEX: PageEntry[] = ALL_PRODUCTS.flatMap((product) => {
  const own: PageEntry = { id: `page:${product.path}`, title: product.name, hint: 'App', path: product.path, icon: product.icon, words: product.words || '' };
  const sections = sectionsOf(product)
    .filter(({ path }) => path !== product.path)
    .map(({ name, path }) => ({
      id: `page:${path}`,
      title: name,
      hint: product.name,
      path,
      icon: product.icon,
      words: `${product.name} ${product.groups?.find(({ sections: list }) => list.some((s) => s.path === path))?.name || ''}`
    }));
  // The first section shares the product's address, so its name is worth finding too
  const first = sectionsOf(product).find(({ path }) => path === product.path);
  if (first) own.words = `${own.words} ${first.name}`;
  return [own, ...sections];
});

// Quick actions. "?new=1" asks the page to open its "New ..." form (see AppShell).
// keys is the shortcut: press n, then the letter.
export type QuickAction = { id: string; title: string; path: string; icon: string; keys: string[] };

export const QUICK_ACTIONS: QuickAction[] = [
  { id: 'new:invoice', title: 'New invoice', path: '/saas/accounting?new=1', icon: 'invoice', keys: ['n', 'i'] },
  { id: 'new:contact', title: 'New contact', path: '/saas/crm/contacts?new=1', icon: 'contact', keys: ['n', 'c'] },
  { id: 'new:employee', title: 'New employee', path: '/saas/hr?new=1', icon: 'hr', keys: ['n', 'e'] },
  { id: 'new:booking', title: 'New booking', path: '/saas/scheduler?new=1', icon: 'scheduler', keys: ['n', 'b'] },
  { id: 'new:lead', title: 'New lead', path: '/saas/crm/leads?new=1', icon: 'lead', keys: ['n', 'l'] },
  { id: 'new:deal', title: 'New deal', path: '/saas/crm/pipeline?new=1', icon: 'deal', keys: ['n', 'd'] },
  { id: 'new:item', title: 'New item', path: '/saas/inventory?new=1', icon: 'item', keys: ['n', 't'] }
];

export const titleFor = (pathname: string) => {
  const product = productFor(pathname);
  const section = sectionFor(pathname, product);
  return { product, section };
};
