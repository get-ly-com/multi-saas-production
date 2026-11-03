import Link from 'next/link';
import { useRouter } from 'next/router';

const SECTIONS = [
  { name: 'Inbox', path: '/saas/chat' },
  { name: 'Tickets', path: '/saas/chat/tickets' },
  { name: 'Answers', path: '/saas/chat/answers' },
  { name: 'Saved replies', path: '/saas/chat/replies' },
  { name: 'Ratings', path: '/saas/chat/ratings' },
  { name: 'Settings', path: '/saas/chat/settings' }
];

export const TICKET_STATUS: Record<string, string> = { new: 'New', in_progress: 'In progress', waiting: 'Waiting on customer', solved: 'Solved' };
export const TICKET_STATUS_STYLES: Record<string, string> = { new: 'open', in_progress: 'sent', waiting: '', solved: 'paid' };
export const PRIORITY: Record<string, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };

// "Due in 3 h", "2 h late"
export const dueText = (due: string | null | undefined, status: string) => {
  if (!due || status === 'solved') return '';
  const minutes = Math.round((Date.parse(due) - Date.now()) / 60000);
  const span = Math.abs(minutes) < 60 ? `${Math.abs(minutes)} min` : Math.abs(minutes) < 48 * 60
    ? `${Math.round(Math.abs(minutes) / 60)} h` : `${Math.round(Math.abs(minutes) / 1440)} days`;
  return minutes < 0 ? `${span} late` : `due in ${span}`;
};

export const stars = (rating: number | null | undefined) => (rating ? '★'.repeat(rating) + '☆'.repeat(5 - rating) : '');

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
