import Link from 'next/link';
import { useRouter } from 'next/router';

export const SECTIONS = [
  { name: 'People', path: '/saas/hr' },
  { name: 'Org chart', path: '/saas/hr/org-chart' },
  { name: 'Leave', path: '/saas/hr/leave' },
  { name: 'Attendance', path: '/saas/hr/attendance' },
  { name: 'Expenses', path: '/saas/hr/expenses' },
  { name: 'Payroll', path: '/saas/hr/payroll' },
  { name: 'Settings', path: '/saas/hr/settings' }
];

export default function HrNav() {
  const { pathname } = useRouter();
  return (
    <nav className="subnav">
      {SECTIONS.map(({ name, path }) => (
        <Link key={path} href={path} className={pathname === path ? 'active' : ''}>{name}</Link>
      ))}
    </nav>
  );
}
