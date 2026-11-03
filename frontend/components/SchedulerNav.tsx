import Link from 'next/link';
import { useRouter } from 'next/router';

const SECTIONS = [
  { name: 'Bookings', path: '/saas/scheduler' },
  { name: 'Services', path: '/saas/scheduler/services' },
  { name: 'Hours', path: '/saas/scheduler/hours' },
  { name: 'Settings', path: '/saas/scheduler/settings' }
];

export default function SchedulerNav() {
  const { pathname } = useRouter();
  return (
    <nav className="subnav">
      {SECTIONS.map(({ name, path }) => (
        <Link key={path} href={path} className={pathname === path ? 'active' : ''}>{name}</Link>
      ))}
    </nav>
  );
}

export const LOCATIONS: Record<string, string> = { in_person: 'In person', phone: 'Phone call', video: 'Video call' };

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Dates here are plain YYYY-MM-DD days in the company's time zone, so the maths is done in UTC
export const addDays = (day: string, days: number) => {
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
};

export const weekStart = (day: string) => {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, weekday === 0 ? -6 : 1 - weekday);
};

export const dayLabel = (day: string, long = false) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: 'UTC', weekday: long ? 'long' : 'short', day: 'numeric', month: long ? 'long' : 'short'
  });

export const timeZones = (): string[] => {
  try {
    const zones = (Intl as any).supportedValuesOf('timeZone') as string[];
    return zones.includes('UTC') ? zones : ['UTC', ...zones];
  } catch {
    return ['UTC', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Karachi', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Australia/Sydney'];
  }
};
