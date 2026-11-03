import Link from 'next/link';
import { useRouter } from 'next/router';

const SECTIONS = [
  { name: 'Items', path: '/saas/inventory' },
  { name: 'Warehouses', path: '/saas/inventory/locations' },
  { name: 'Stock counts', path: '/saas/inventory/counts' },
  { name: 'Reorder', path: '/saas/inventory/reorder' },
  { name: 'Stock value', path: '/saas/inventory/valuation' },
  { name: 'Profit by product', path: '/saas/inventory/profit' }
];

export default function InventoryNav() {
  const { pathname } = useRouter();
  return (
    <nav className="subnav">
      {SECTIONS.map(({ name, path }) => (
        <Link
          key={path}
          href={path}
          className={pathname === path || (path !== '/saas/inventory' && pathname.startsWith(`${path}/`)) ? 'active' : ''}
        >
          {name}
        </Link>
      ))}
    </nav>
  );
}
