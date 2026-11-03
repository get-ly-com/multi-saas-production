import Link from 'next/link';
import { useRouter } from 'next/router';

const SECTIONS = [
  { name: 'People', path: '/saas/hr' },
  { name: 'Leave', path: '/saas/hr/leave' },
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
