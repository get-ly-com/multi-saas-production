# Get-ly design system

Read this before you polish a product. The goal is calm, fast and rewarding: lots of whitespace,
one accent, soft pills, tabular numbers, and no dark patterns (no fake urgency, nagging pop-ups,
guilt copy or hidden costs).

## Principles

- **Calm by default.** Near-white surfaces, quiet borders, one accent (indigo `--accent`). Colour means something: green good, amber needs attention, red wrong.
- **Numbers line up.** Every number uses tabular figures (`td`, `.num`, `.stat-value` already do). Right-align money columns with `.num`.
- **Fast feels instant.** No spinners for things under a second. Use skeletons shaped like the real content. Animations are 90 to 240ms, and everything respects reduced motion.
- **Celebrate real wins only.** An invoice paid, inbox zero, setup finished. Never a routine save.
- **Copy:** plain, friendly, active voice, no jargon, no em-dash asides. "Send invoice", not "Submit". Empty lists say what to do next.

## Tokens (styles/globals.css, section 1)

| Group | Tokens |
| --- | --- |
| Surfaces | `--bg` page, `--surface` cards, `--surface-2` raised/hover, `--sunken` wells, `--sidebar`, `--hover` |
| Lines | `--border`, `--border-strong` |
| Text | `--text`, `--text-2` secondary, `--muted` captions, `--faint` placeholders and group labels |
| Accent | `--accent` fills, `--accent-hover`, `--accent-press`, `--accent-text` on fills, `--accent-soft` / `--accent-soft-strong` tints, `--link` and `--link-hover` for accent text |
| Meaning | `--good` `--good-soft`, `--warn` `--warn-soft`, `--danger` `--danger-soft` |
| Charts | `--series-1`, `--series-2`; workflow stages `--stage-1` to `--stage-5` |
| Elevation | `--shadow-xs` cards, `--shadow-sm`, `--shadow-md` hover, `--shadow-lg` menus and toasts, `--shadow-xl` dialogs, `--scrim` |
| Focus | `--ring`, `--ring-danger` |
| Radius | `--r-xs` 4, `--r-sm` 6, `--r-md` 8 (controls), `--r-lg` 12 (cards), `--r-xl` 16 (dialogs), `--r-full` |
| Spacing | `--s-1` 4px to `--s-10` 64px on a 4px grid |
| Type | `--text-xs` 12 to `--text-4xl` 36; body is 14px Instrument Sans, `--font-mono` for code |
| Motion | `--dur-1` 90ms, `--dur-2` 160ms, `--dur-3` 240ms, `--dur-4` 380ms; `--ease-out`, `--ease-in-out`, `--ease-spring` |

Never hard-code a colour in a page. Dark mode comes free if you use tokens. Themes are light, dark or
system, chosen from the moon/sun button in the top bar; `lib/theme.ts` stores the choice and
`pages/_document.tsx` applies it before paint.

## Shared classes (unchanged names, new look)

- Layout: `.page`, `.page-head` (title left, actions right), `.stack`, `.card`, `.form-grid`, `.form-actions`, `.report-filters` (the light filter row above a table).
- Stats: `.stats` > `.card` > `.stat-label` + `.stat-value`. Make a tile a link with `a.card.stat-link`.
- Tables: wrap in `.card.table-wrap`. Headers stick (outside `.table-wrap`), rows highlight on hover. `.num` for numbers, `td.wrap` for long text, `.row-actions` for buttons.
- Buttons: plain `button` is secondary. Add `.primary`, `.danger`, `.ghost`, `.small`, or `.link`. `.button` makes a link look like a button. `.icon-button` for icon-only buttons (give it `aria-label`).
- Inputs: focus ring is automatic. Mark a bad field with `aria-invalid="true"` (or class `invalid`) to get the red state.
- Status pills: `<span className={`badge ${status}`}>`. Draft and unknown are grey; `sent open partial pending unpaid waiting low due` amber; `paid won accepted approved delivered posted active booked solved` green; `lost failed out overdue declined rejected` red; `new scheduled` accent; `void cancelled closed expired inactive` muted and dashed. Void is not struck through because the same class also means "inactive" and "not balanced" in places.
- Small helpers: `.chip` (neutral count or time), `.count-pill`, `.muted`, `.small`, `.kbd`, `.sr-only`.
- Feedback: `p.error` and `p.notice` render as soft boxes; `.empty` is still the quiet one-line empty row for tables.
- Tabs: `.tabs` with `button.active`. Section links from the `*Nav` components use `.subnav`.

## App shell (components/AppShell.tsx)

- Left sidebar: company switcher, setup progress (until done), products grouped under Sales, Money, People and Workspace, and the active product's sections. Help and Team and settings are pinned at the bottom. Collapses to an icon rail; becomes a drawer under 900px.
- The sidebar reads `lib/nav.ts`, which reads each product's `SECTIONS` (or `GROUPS` for Accounting) exported from its `*Nav` component. **Add a section in the Nav component and it appears in the sidebar, the palette and the breadcrumb.**
- On wide screens with the sidebar open, the in-page `.subnav` tabs are hidden by CSS because the sidebar shows them. Pages don't need to change.
- Top bar: menu toggle, breadcrumb, search (opens the palette), Assistant, alerts, theme, account menu.
- `useAccount()` from `components/AppShell` gives a page `{ me, tenantId, role, canEdit, isManager }`.
- `?new=1` on any page clicks that page's "New ..." or "Add ..." primary button in `.page-head`, then tidies the address. Quick actions use this. If a page opens its form some other way, read `router.query.new` yourself.

## Components

### Toast (`components/Toast.tsx`)
Mounted once in `_app`. Bottom right, stacked, auto-dismiss (4.5s, 7s with an action or error), pauses on hover.
```ts
import { toast } from '@/components/Toast';
toast.success('Invoice sent', { detail: 'Acme Ltd will get it in a minute' });
toast.error('Could not save', { detail: err.message });
toast.info('Moved to archive', { action: { label: 'Undo', onClick: restore } });
```
Use a short title ("Saved") and a detail line. Prefer a toast over the green `.notice` for actions that finish in place.

### EmptyState (`components/EmptyState.tsx`)
```tsx
<EmptyState icon="invoice" title="No invoices yet" line="Send your first one in under a minute."
  action={{ label: 'New invoice', onClick: open }} />
<EmptyState tone="done" icon="inbox" title="Inbox zero" line="Every chat has a reply. Time is yours again."
  action={{ label: 'See tickets', href: '/saas/chat/tickets' }} />
```
`tone="done"` is for a cleared list (a win, green); `compact` for inside cards. Tone of voice: warm and short, for example "You've approved them all. Time is yours again." or "No overdue invoices. Everyone paid on time."

### Skeleton (`components/Skeleton.tsx`)
`<Skeleton width height radius />`, `<SkeletonText lines />`, `<SkeletonStats count />`, `<SkeletonTable rows columns />`, `<SkeletonPage />`. Replace "Loading…" text with the shape of what is coming.

### Celebrate (`components/Celebrate.tsx`)
```ts
import { celebrate } from '@/components/Celebrate';
celebrate({ from: buttonElement });   // or <Celebrate when={allDone} />
```
One short confetti burst, skipped for reduced motion, never overlaps itself. Use for: invoice marked paid, last ticket solved, all leave decided, setup complete.

### Drawer (`components/Drawer.tsx`)
A right-side panel over a list, so a record opens without losing your place.
```tsx
<Drawer open={!!row} title={row?.invoice_number} subtitle={row?.customer_name} onClose={() => setRow(null)}
  footer={<button className="primary">Record payment</button>}>…</Drawer>
```
Escape, the close button or a click on the dimmed list close it. Focus is trapped and returned.

### CommandPalette (`components/CommandPalette.tsx`)
Ctrl/Cmd+K or `/`. Groups: Recent (localStorage), Quick actions (with shortcut chips), Go to (every page from `lib/nav.ts`) and Records (CRM search plus invoices, customers and items, debounced and capped at 12). Open it from code with `openPalette('text')`. Add quick actions to `QUICK_ACTIONS` in `lib/nav.ts`.

### Shortcuts (`components/Shortcuts.tsx`)
`?` shows the sheet. `g` then a letter goes to a product (t Today, q Assistant, a Accounting, c CRM, i Inventory, h HR, s Scheduler, m Meetings, l Chat, p Social, n Analytics, x Integrations, u Team). `n` then a letter creates (i invoice, c contact, e employee, b booking, l lead, d deal, t item). Shortcuts never fire while typing or while a dialog is open.

### Icon (`components/Icon.tsx`)
`<Icon name="invoice" size={16} />`. One stroke set, `currentColor`. Add new shapes to the map there.

### Helpers
- `lib/format.ts`: `count`, `compactMoney` ($12.4K), `change` (percent vs before), `plural`, `monthRange`.
- `lib/cache.ts`: `cachedGet(path)` shares one GET between components for 30 seconds.
- `lib/setup.ts`: `useSetup(tenantId)` for the getting-started checklist; steps come from real data and a 403 leaves a step out.
- `lib/ui.ts`: `store` (safe localStorage), `useDismiss`, `trapTab`, `useScrollLock`, `isTyping`.

## Patterns for phase 2

- **Page header:** title (and one muted line) on the left; the primary action on the right ("New invoice"). Secondary actions are plain buttons beside it.
- **Filters:** a `.report-filters` row directly above the table, inside or just above the card.
- **Lists:** dense, clean tables with soft pills for status. Open a record in a `Drawer` when the user will come straight back to the list.
- **Home:** `/saas/today` is the landing page. Its workflow strip (Leads, Deals, Quotes, Invoices awaiting payment, Paid this month) is the signature view of the suite as one flow; keep its deep links working when lists change.
- **Permissions:** if an API answers 403, hide the tile or step quietly. Viewers get `.read-only` on `<main>`, which hides primary buttons; add `always` to buttons a viewer may still use.
- **Wins:** after a real win call `celebrate()` and show a success toast. Once per win.
