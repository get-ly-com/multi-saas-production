import Link from 'next/link';
import { useRouter } from 'next/router';

const SECTIONS = [
  { name: 'Invoices and expenses', path: '/saas/accounting' },
  { name: 'Chart of accounts', path: '/saas/accounting/accounts' },
  { name: 'Journal', path: '/saas/accounting/journal' },
  { name: 'General ledger', path: '/saas/accounting/ledger' },
  { name: 'Trial balance', path: '/saas/accounting/trial-balance' }
];

export default function AccountingNav() {
  const { pathname } = useRouter();

  return (
    <nav className="subnav">
      {SECTIONS.map(({ name, path }) => (
        <Link key={path} href={path} className={pathname === path ? 'active' : ''}>{name}</Link>
      ))}
    </nav>
  );
}
