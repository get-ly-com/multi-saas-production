import Link from 'next/link';
import { useRouter } from 'next/router';

const SECTIONS = [
  { name: 'Planner', path: '/saas/social' },
  { name: 'Results', path: '/saas/social/results' },
  { name: 'Accounts', path: '/saas/social/accounts' },
  { name: 'Settings', path: '/saas/social/settings' }
];

export default function SocialNav() {
  const { pathname } = useRouter();
  return (
    <nav className="subnav">
      {SECTIONS.map(({ name, path }) => (
        <Link key={path} href={path} className={pathname === path ? 'active' : ''}>{name}</Link>
      ))}
    </nav>
  );
}
