import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';
import EmptyState from '@/components/EmptyState';
import Icon from '@/components/Icon';
import Modal from '@/components/Modal';
import Skeleton, { SkeletonTable } from '@/components/Skeleton';
import { toast } from '@/components/Toast';

export const SECTIONS = [
  { name: 'Webhooks', path: '/saas/integrations' },
  { name: 'Incoming webhooks', path: '/saas/integrations/inbound' },
  { name: 'API keys', path: '/saas/integrations/keys' },
  { name: 'API guide', path: '/saas/integrations/api' },
  { name: 'Background jobs', path: '/saas/integrations/jobs' }
];

export const EVENTS = [
  { name: 'invoice.created', label: 'Invoice created' },
  { name: 'invoice.paid', label: 'Invoice paid' },
  { name: 'contact.created', label: 'Contact created' },
  { name: 'lead.created', label: 'Lead created' },
  { name: 'deal.won', label: 'Deal won' },
  { name: 'deal.lost', label: 'Deal lost' },
  { name: 'leave.approved', label: 'Leave approved' },
  { name: 'payrun.approved', label: 'Pay run approved' },
  { name: 'booking.created', label: 'Booking made' },
  { name: 'booking.cancelled', label: 'Booking cancelled' },
  { name: 'chat.started', label: 'Chat started' },
  { name: 'chat.handed_over', label: 'Chat asked for a person' },
  { name: 'social.posted', label: 'Social post posted' }
];

export const eventLabel = (name: string) => EVENTS.find((event) => event.name === name)?.label || (name === 'test' ? 'Test' : name);

export const dateTime = (value: string | null | undefined) => (value ? new Date(value.endsWith('Z') || value.includes('+') ? value : `${value}Z`).toLocaleString() : '—');

export function OnlyManagers() {
  return (
    <div className="card">
      <EmptyState icon="integrations" title="Only owners and admins can set this up"
        line="Ask one of them if you need a webhook or an API key." />
    </div>
  );
}

// While a page first loads: the header and a list, greyed
export function IntegrationsLoading() {
  return (
    <div className="stack" role="status" aria-label="Loading">
      <div className="page-head"><Skeleton width={180} height={28} /><Skeleton width={130} height={34} /></div>
      <SkeletonTable rows={4} columns={4} />
    </div>
  );
}

export default function IntegrationsNav() {
  const { pathname } = useRouter();
  return (
    <nav className="subnav">
      {SECTIONS.map(({ name, path }) => (
        <Link key={path} href={path} className={pathname === path ? 'active' : ''}>{name}</Link>
      ))}
    </nav>
  );
}

const copyText = async (value: string, what = 'Copied') => {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(what, { detail: 'It is on your clipboard.' });
    return true;
  } catch {
    toast.error('Could not copy', { detail: 'Select the text and copy it by hand.' });
    return false;
  }
};

// A code sample or snippet with a copy button in its corner
export function CodeBlock({ value, label = 'Copied' }: { value: string; label?: string }) {
  return (
    <div style={{ position: 'relative' }}>
      <pre className="code-block" style={{ paddingRight: 84 }}>{value}</pre>
      <button type="button" className="small always" style={{ position: 'absolute', top: 6, right: 6 }} onClick={() => copyText(value, label)}>
        <Icon name="copy" size={14} />Copy
      </button>
    </div>
  );
}

export function ShowOnce({ title, value, onClose, note }: { title: string; value: string; onClose: () => void; note?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => setCopied(await copyText(value, 'Copied to your clipboard'));
  return (
    <Modal title={title}>
      <p className="notice">Copy it now. It won&apos;t be shown again. If you lose it, make a new one.</p>
      <pre className="code-block">{value}</pre>
      {note && <p className="muted">{note}</p>}
      <div className="form-actions">
        <button onClick={copy}><Icon name={copied ? 'check' : 'copy'} size={15} />{copied ? 'Copied' : 'Copy'}</button>
        <button className="primary" onClick={onClose}>I&apos;ve saved it</button>
      </div>
    </Modal>
  );
}
