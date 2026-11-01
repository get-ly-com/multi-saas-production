import Link from 'next/link';
import { useRouter } from 'next/router';

const SECTIONS = [
  { name: 'Invoices and expenses', path: '/saas/accounting' },
  { name: 'Customers', path: '/saas/accounting/customers' },
  { name: 'Recurring invoices', path: '/saas/accounting/recurring' },
  { name: 'Revenue schedules', path: '/saas/accounting/revenue' },
  { name: 'Purchase orders', path: '/saas/accounting/purchase-orders' },
  { name: 'Bills', path: '/saas/accounting/bills' },
  { name: 'Vendors', path: '/saas/accounting/vendors' },
  { name: 'Banking', path: '/saas/accounting/banking' },
  { name: 'Tax', path: '/saas/accounting/taxes' },
  { name: 'Currencies', path: '/saas/accounting/currencies' },
  { name: 'Fixed assets', path: '/saas/accounting/assets' },
  { name: 'Budgets', path: '/saas/accounting/budgets' },
  { name: 'Cost centers', path: '/saas/accounting/cost-centers' },
  { name: 'Chart of accounts', path: '/saas/accounting/accounts' },
  { name: 'Journal', path: '/saas/accounting/journal' },
  { name: 'General ledger', path: '/saas/accounting/ledger' },
  { name: 'Trial balance', path: '/saas/accounting/trial-balance' },
  { name: 'Reports', path: '/saas/accounting/reports' },
  { name: 'Controls', path: '/saas/accounting/controls' }
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
