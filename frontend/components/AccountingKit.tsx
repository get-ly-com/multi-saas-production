import Link from 'next/link';
import { MouseEvent, ReactNode, useRef, useState } from 'react';
import Icon from '@/components/Icon';
import { money, today } from '@/lib/api';
import { useDismiss } from '@/lib/ui';
import s from '@/styles/accounting.module.css';

// Small building blocks shared by the Accounting pages, so every list, drawer and report
// reads the same way: one pill per status, money that lines up, statements that look like statements.

export { s as styles };

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

// ---------- Money ----------

// A money value with tabular figures. Negatives turn red; strong is for totals.
export function Amount({ value, currency, strong, blankZero, dim }: {
  value: number | string | null | undefined;
  currency?: string;
  strong?: boolean;
  blankZero?: boolean;
  dim?: boolean;
}) {
  const number = Number(value || 0);
  if (blankZero && Math.round(number * 100) === 0) return null;
  return (
    <span className={cx(s.amount, number < -0.004 && s.negative, strong && s.strong, dim && s.dim)}>
      {money(number, currency || undefined)}
    </span>
  );
}

// ---------- Status ----------

const LABELS: Record<string, string> = {
  draft: 'Draft',
  sent: 'Sent',
  open: 'Open',
  partial: 'Partially paid',
  paid: 'Paid',
  overdue: 'Overdue',
  void: 'Void',
  approved: 'Approved',
  received: 'Received',
  closed: 'Closed',
  cancelled: 'Cancelled',
  matched: 'Matched',
  unmatched: 'To review',
  ignored: 'Ignored',
  reconciled: 'Reconciled',
  active: 'Active',
  paused: 'Paused',
  inactive: 'Inactive',
  posted: 'Posted',
  disposed: 'Disposed'
};

// Pill classes in globals.css that a status should borrow
const CLASSES: Record<string, string> = {
  unmatched: 'pending',
  ignored: 'inactive',
  reconciled: 'posted',
  received: 'delivered',
  paused: 'inactive',
  disposed: 'closed'
};

export const statusLabel = (status: string) =>
  LABELS[status] || (status ? status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ') : '');

export function StatusPill({ status, label }: { status: string; label?: string }) {
  return <span className={`badge ${CLASSES[status] || status}`}>{label || statusLabel(status)}</span>;
}

// An invoice or bill still owed after its due date reads as overdue, whatever its stored status
export const isOverdue = (row: any) =>
  ['sent', 'partial', 'open'].includes(row.status) && Boolean(row.due_date) && row.due_date < today();

export const shownStatus = (row: any) => (isOverdue(row) ? 'overdue' : row.status);

// ---------- Page header ----------

export function PageHead({ title, line, children, className }: { title: ReactNode; line?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cx('page-head', className)}>
      <div className={s.headText}>
        <h1>{title}</h1>
        {line && <p className="muted">{line}</p>}
      </div>
      {children && <div className={s.headActions}>{children}</div>}
    </div>
  );
}

type MenuItem = { label: string; icon?: string; hint?: string; href?: string; onClick?: () => void };

// The main "New ..." button with a chevron beside it for the other things you can create.
// The main button stays a plain button.primary starting with "New", so "?new=1" still finds it.
export function CreateMenu({ label, onClick, items, disabled }: { label: string; onClick: () => void; items: MenuItem[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, box, () => setOpen(false));

  return (
    <div className="popover-wrap" ref={box}>
      <div className={s.split}>
        <button type="button" className="primary" disabled={disabled} onClick={onClick}>{label}</button>
        <button
          type="button"
          className={cx('primary', s.splitToggle)}
          aria-label="More things to create"
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen(!open)}
        >
          <Icon name="chevron-down" size={14} />
        </button>
      </div>
      {open && (
        <div className="popover menu" role="menu">
          {items.map((item) => {
            const body = (
              <>
                {item.icon && <Icon name={item.icon} size={16} />}
                <span>{item.label}</span>
                {item.hint && <span className={s.menuHint}>{item.hint}</span>}
              </>
            );
            return item.href ? (
              <Link key={item.label} role="menuitem" className="menu-item" href={item.href} onClick={() => setOpen(false)}>{body}</Link>
            ) : (
              <button key={item.label} type="button" role="menuitem" className="menu-item" onClick={() => { setOpen(false); item.onClick?.(); }}>{body}</button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------- Filters ----------

export function FilterPills<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: { id: T; label: string; count?: number }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className={s.filters} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={cx(s.filter, option.id === value && s.filterActive, 'always')}
          aria-pressed={option.id === value}
          onClick={() => onChange(option.id)}
        >
          {option.label}
          {option.count !== undefined && <span className={s.filterCount}>{option.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------- Rows that open a drawer ----------

// Clicks on buttons and links inside the row keep their own job
export const rowOpener = (open: () => void) => ({
  className: s.rowLink,
  onClick: (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest('button, a, input, select, label')) return;
    open();
  }
});

// ---------- Drawer contents ----------

export function DrawerHero({ label, value, line, pill, paidShare }: {
  label: string;
  value: ReactNode;
  line?: ReactNode;
  pill?: ReactNode;
  paidShare?: number;
}) {
  return (
    <div className={s.hero}>
      <div className={s.heroTop}>
        <span className={s.heroLabel}>{label}</span>
        {pill}
      </div>
      <div className={s.heroValue}>{value}</div>
      {line && <div className={s.heroLine}>{line}</div>}
      {paidShare !== undefined && (
        <div className={s.progress} role="img" aria-label={`${Math.round(paidShare * 100)}% paid`}>
          <span style={{ width: `${Math.max(0, Math.min(1, paidShare)) * 100}%` }} />
        </div>
      )}
    </div>
  );
}

export function Facts({ items }: { items: [string, ReactNode][] }) {
  const shown = items.filter(([, value]) => value !== null && value !== undefined && value !== '' && value !== false);
  if (!shown.length) return null;
  return (
    <dl className={s.facts}>
      {shown.map(([label, value]) => (
        <div key={label} style={{ display: 'contents' }}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function DrawerSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={s.section}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function DrawerActions({ children }: { children: ReactNode }) {
  return <div className={s.actions}>{children}</div>;
}

// ---------- Financial statements ----------

export function Statement({ children, columns }: { children: ReactNode; columns?: string[] }) {
  return (
    <table className={s.statement}>
      {columns && (
        <thead><tr>{columns.map((column, index) => <th key={`${column}-${index}`}>{column}</th>)}</tr></thead>
      )}
      <tbody>{children}</tbody>
    </table>
  );
}

export function StatementHeading({ title, span = 2 }: { title: string; span?: number }) {
  return <tr className={s.heading}><td colSpan={span}>{title}</td></tr>;
}

// One indented account line. Values are money cells, in column order.
export function StatementLine({ label, code, href, values, currency, blankZero }: {
  label: ReactNode;
  code?: string;
  href?: string;
  values: (number | string | null | undefined)[];
  currency?: string;
  blankZero?: boolean;
}) {
  const name = <>{code && <span className={s.code}>{code}</span>}{label}</>;
  return (
    <tr className={s.account}>
      <td className="wrap">{href ? <Link href={href}>{name}</Link> : name}</td>
      {values.map((value, index) => <td key={index}><Amount value={value} currency={currency} blankZero={blankZero} /></td>)}
    </tr>
  );
}

export function StatementTotal({ label, values, currency, grand }: {
  label: string;
  values: (number | string | null | undefined)[];
  currency?: string;
  grand?: boolean;
}) {
  return (
    <tr className={grand ? s.grand : s.subtotal}>
      <td>{label}</td>
      {values.map((value, index) => <td key={index}><Amount value={value} currency={currency} /></td>)}
    </tr>
  );
}

export function StatementEmpty({ text = 'Nothing in this period', span = 2 }: { text?: string; span?: number }) {
  return <tr className={s.empty}><td colSpan={span}>{text}</td></tr>;
}

export function StatementSpacer({ span = 2 }: { span?: number }) {
  return <tr className={s.spacer} aria-hidden="true"><td colSpan={span} /></tr>;
}
