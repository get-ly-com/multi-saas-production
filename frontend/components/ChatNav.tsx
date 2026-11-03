import Link from 'next/link';
import { useRouter } from 'next/router';

const SECTIONS = [
  { name: 'Inbox', path: '/saas/chat' },
  { name: 'Answers', path: '/saas/chat/answers' },
  { name: 'Settings', path: '/saas/chat/settings' }
];

export default function ChatNav() {
  const { pathname } = useRouter();
  return (
    <nav className="subnav">
      {SECTIONS.map(({ name, path }) => (
        <Link key={path} href={path} className={pathname === path ? 'active' : ''}>{name}</Link>
      ))}
    </nav>
  );
}

export type ChatMessage = { id: number; sender?: string; from?: string; body: string; created_at?: string; at?: string; author_id?: string | null };

export const timeText = (value: string | undefined) => {
  if (!value) return '';
  const when = new Date(value);
  const sameDay = when.toDateString() === new Date().toDateString();
  return sameDay
    ? when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export const STATUS_LABELS: Record<string, string> = { waiting: 'waiting for reply', open: 'open', closed: 'closed' };
export const STATUS_STYLES: Record<string, string> = { waiting: 'open', open: 'paid', closed: '' };
