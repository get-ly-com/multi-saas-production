import Link from 'next/link';
import { ReactNode } from 'react';
import Icon from '@/components/Icon';

// What to show when a list has nothing in it. Warm, short, and always a way onward.
//   <EmptyState icon="invoice" title="No invoices yet" line="Send your first one in under a minute."
//     action={{ label: 'New invoice', onClick: openForm }} />
//   <EmptyState tone="done" icon="inbox" title="Inbox zero" line="Every chat has a reply. Time is yours again."
//     action={{ label: 'See tickets', href: '/saas/chat/tickets' }} />
// tone "done" is for a cleared list (a win); "plain" is for a list that is just empty.

type Action = { label: string; href?: string; onClick?: () => void };

export default function EmptyState({ icon = 'inbox', title, line, action, secondary, tone = 'plain', compact, children }: {
  icon?: string;
  title: string;
  line?: ReactNode;
  action?: Action;
  secondary?: Action;
  tone?: 'plain' | 'done';
  compact?: boolean;
  children?: ReactNode;
}) {
  const button = (item: Action, primary: boolean) => {
    const className = `button ${primary ? 'primary' : 'ghost'} always`;
    return item.href
      ? <Link key={item.label} href={item.href} className={className}>{item.label}</Link>
      : <button key={item.label} type="button" className={className} onClick={item.onClick}>{item.label}</button>;
  };

  return (
    <div className={`empty-state tone-${tone} ${compact ? 'is-compact' : ''}`}>
      <div className="empty-art" aria-hidden="true">
        <span className="empty-ring" />
        <Icon name={tone === 'done' && icon === 'inbox' ? 'paid' : icon} size={compact ? 20 : 24} />
      </div>
      <h3>{title}</h3>
      {line && <p>{line}</p>}
      {children}
      {(action || secondary) && (
        <div className="empty-actions">
          {action && button(action, true)}
          {secondary && button(secondary, false)}
        </div>
      )}
    </div>
  );
}
