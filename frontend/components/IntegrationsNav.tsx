import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';
import Modal from '@/components/Modal';

const SECTIONS = [
  { name: 'Webhooks', path: '/saas/integrations' },
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
  { name: 'payrun.approved', label: 'Pay run approved' }
];

export const eventLabel = (name: string) => EVENTS.find((event) => event.name === name)?.label || (name === 'test' ? 'Test' : name);

export const dateTime = (value: string | null | undefined) => (value ? new Date(value.endsWith('Z') || value.includes('+') ? value : `${value}Z`).toLocaleString() : '—');

export function OnlyManagers() {
  return <p className="muted">Only owners and admins can set up integrations. Ask one of them if you need a webhook or an API key.</p>;
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

export function ShowOnce({ title, value, onClose, note }: { title: string; value: string; onClose: () => void; note?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Modal title={title}>
      <p className="notice">Copy it now. It won't be shown again; if you lose it, make a new one.</p>
      <pre className="code-block">{value}</pre>
      {note && <p className="muted">{note}</p>}
      <div className="form-actions">
        <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        <button className="primary" onClick={onClose}>I've saved it</button>
      </div>
    </Modal>
  );
}
