import Link from 'next/link';
import { useRouter } from 'next/router';
import styles from '@/styles/inventory.module.css';

export const SECTIONS = [
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

// Stock level for an item: out (none left), low (at or under its reorder level) or good
export const stockLevel = (item: any): 'good' | 'low' | 'out' => {
  const quantity = Number(item.quantity || 0);
  if (quantity <= 0) return 'out';
  if (quantity <= Number(item.reorder_level || 0)) return 'low';
  return 'good';
};

// A small bar that shows how full the shelf is, with a tick at the reorder level.
// Full is the "order up to" amount, or twice the reorder level when that isn't set.
export function StockBar({ item, quantity, bare }: { item: any; quantity?: number; bare?: boolean }) {
  const held = Number(quantity ?? item.quantity ?? 0);
  const reorder = Number(item.reorder_level || 0);
  const full = Math.max(Number(item.reorder_to || 0), reorder * 2, held, 1);
  const level = quantity === undefined ? stockLevel(item) : held <= 0 ? 'out' : held <= reorder ? 'low' : 'good';
  const width = Math.max(held > 0 ? 4 : 0, Math.min(100, Math.round((held / full) * 100)));
  const bar = (
    <span className={`${styles.bar} ${level === 'good' ? '' : styles[level]}`} role="img"
      aria-label={`${held} ${item.unit || ''} on hand${reorder ? `, reorder at ${reorder}` : ''}`}>
      <span style={{ width: `${width}%` }} />
      {reorder > 0 && <i style={{ left: `${Math.min(100, Math.round((reorder / full) * 100))}%` }} />}
    </span>
  );
  if (bare) return bar;
  return (
    <span className={styles.level}>
      <span className={styles.levelTop}>
        <span className={styles.levelQty}>{held} <span className="muted small">{item.unit}</span></span>
        {level !== 'good' && <span className={`badge ${level}`}>{level === 'out' ? 'Out' : 'Low'}</span>}
      </span>
      {bar}
    </span>
  );
}
