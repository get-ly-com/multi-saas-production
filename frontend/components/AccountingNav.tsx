import Link from 'next/link';
import { useRouter } from 'next/router';

const GROUPS = [
  {
    name: 'Sales',
    sections: [
      { name: 'Invoices and expenses', path: '/saas/accounting' },
      { name: 'Customers', path: '/saas/accounting/customers' },
      { name: 'Recurring invoices', path: '/saas/accounting/recurring' },
      { name: 'Revenue schedules', path: '/saas/accounting/revenue' }
    ]
  },
  {
    name: 'Purchases',
    sections: [
      { name: 'Bills', path: '/saas/accounting/bills' },
      { name: 'Purchase orders', path: '/saas/accounting/purchase-orders' },
      { name: 'Vendors', path: '/saas/accounting/vendors' }
    ]
  },
  {
    name: 'Banking and tax',
    sections: [
      { name: 'Banking', path: '/saas/accounting/banking' },
      { name: 'Tax', path: '/saas/accounting/taxes' },
      { name: 'Currencies', path: '/saas/accounting/currencies' }
    ]
  },
  {
    name: 'Assets and planning',
    sections: [
      { name: 'Fixed assets', path: '/saas/accounting/assets' },
      { name: 'Budgets', path: '/saas/accounting/budgets' },
      { name: 'Cost centers', path: '/saas/accounting/cost-centers' }
    ]
  },
  {
    name: 'Ledger',
    sections: [
      { name: 'Chart of accounts', path: '/saas/accounting/accounts' },
      { name: 'Journal', path: '/saas/accounting/journal' },
      { name: 'General ledger', path: '/saas/accounting/ledger' },
      { name: 'Trial balance', path: '/saas/accounting/trial-balance' }
    ]
  },
  {
    name: 'Reports and controls',
    sections: [
      { name: 'Reports', path: '/saas/accounting/reports' },
      { name: 'Company group', path: '/saas/accounting/group' },
      { name: 'Controls', path: '/saas/accounting/controls' }
    ]
  }
];

export default function AccountingNav() {
  const { pathname } = useRouter();
  const current = GROUPS.find(({ sections }) => sections.some(({ path }) => path === pathname)) || GROUPS[0];

  return (
    <div>
      <nav className="subnav groups" aria-label="Accounting areas">
        {GROUPS.map((group) => (
          <Link key={group.name} href={group.sections[0].path} className={group === current ? 'active' : ''}>{group.name}</Link>
        ))}
      </nav>
      <nav className="subnav" aria-label={current.name}>
        {current.sections.map(({ name, path }) => (
          <Link key={path} href={path} className={pathname === path ? 'active' : ''}>{name}</Link>
        ))}
      </nav>
    </div>
  );
}
