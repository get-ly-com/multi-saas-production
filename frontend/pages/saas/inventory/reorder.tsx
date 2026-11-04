import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import EmptyState from '@/components/EmptyState';
import InventoryNav, { StockBar } from '@/components/InventoryNav';
import { SkeletonStats, SkeletonTable } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api, money } from '@/lib/api';
import styles from '@/styles/inventory.module.css';

export default function Reorder() {
  return <AppShell><ReorderApp /></AppShell>;
}

function ReorderApp() {
  const router = useRouter();
  const [rows, setRows] = useState<any[] | null>(null);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [expected, setExpected] = useState('');
  const [made, setMade] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [suggestions, supplierRows] = await Promise.all([
        api.get('/api/inventory/reorder'),
        api.get('/api/inventory/suppliers').catch(() => [])
      ]);
      setRows(suggestions.map((row: any) => ({
        ...row,
        chosen: Boolean(row.vendor_id),
        quantity: String(row.suggested),
        unit_price: Number(row.unit_cost) ? String(Number(row.unit_cost)) : '',
        vendor_id: row.vendor_id || ''
      })));
      setSuppliers(supplierRows);
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const set = (itemId: string, field: string, value: any) =>
    setRows((rows || []).map((row) => (row.item_id === itemId ? { ...row, [field]: value } : row)));

  const chosen = (rows || []).filter((row) => row.chosen);
  const total = chosen.reduce((sum, row) => sum + Number(row.quantity || 0) * Number(row.unit_price || 0), 0);
  const supplierCount = new Set(chosen.map((row) => row.vendor_id)).size;

  const create = async () => {
    setBusy(true);
    try {
      const result = await api.post('/api/inventory/reorder', {
        expected_date: expected || null,
        lines: chosen.map((row) => ({ item_id: row.item_id, quantity: row.quantity, unit_price: row.unit_price || 0, vendor_id: row.vendor_id }))
      });
      setMade(result);
      await load();
      toast.success(`${result.length} purchase ${result.length === 1 ? 'order' : 'orders'} drafted`, {
        detail: result.map((order: any) => `${order.po_number} for ${order.vendor}`).join(', '),
        action: { label: 'Open', onClick: () => router.push('/saas/accounting/purchase-orders') }
      });
    } catch (err: any) {
      toast.error('Could not draft the orders', { detail: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Reorder</h1>
          <p className="muted">What is running low, and one click to draft the orders.</p>
        </div>
      </div>
      <InventoryNav />

      {!rows ? <SkeletonStats count={4} /> : rows.length > 0 && (
        <div className="stats">
          <div className="card"><div className="stat-label">Items to reorder</div><div className="stat-value">{rows.length}</div></div>
          <div className="card"><div className="stat-label">Out of stock</div><div className="stat-value">{rows.filter((row) => Number(row.on_hand) <= 0).length}</div></div>
          <div className="card"><div className="stat-label">Chosen</div><div className="stat-value">{chosen.length}</div><div className="muted">{supplierCount} {supplierCount === 1 ? 'supplier' : 'suppliers'}</div></div>
          <div className="card"><div className="stat-label">Order total</div><div className="stat-value">{money(total)}</div><div className="muted">before tax</div></div>
        </div>
      )}

      <p className="muted small">
        Items at or below their reorder level, counting what's already on purchase orders and draft bills. Choose what to buy and
        draft purchase orders are made, one per supplier, in Accounting. When an order is approved and billed, the stock comes in
        at what you paid.
      </p>
      {error && <p className="error">{error}</p>}
      {made.length > 0 && (
        <p className="notice">
          Made {made.map((order) => `${order.po_number} for ${order.vendor}`).join(', ')}.{' '}
          <Link href="/saas/accounting/purchase-orders">Open purchase orders</Link> to submit {made.length === 1 ? 'it' : 'them'} for approval.
        </p>
      )}

      {!rows ? <SkeletonTable rows={5} columns={6} /> : rows.length === 0 ? (
        <div className="card">
          <EmptyState tone="done" icon="inventory" title="Nothing needs reordering" line="Every item is above its reorder level. Set a reorder level on items to see suggestions here."
            action={{ label: 'See items', href: '/saas/inventory' }} />
        </div>
      ) : (
      <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th aria-label="Choose" /><th>Item</th><th className="num">On hand</th><th className="num">On order</th>
                <th>Stock</th><th className="num">Order</th><th className="num">Cost each</th><th>Supplier</th><th className="num">Line total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.item_id} className={row.chosen ? styles.chosenRow : ''}>
                  <td><input type="checkbox" aria-label={`Order ${row.name}`} checked={row.chosen} onChange={(e) => set(row.item_id, 'chosen', e.target.checked)} style={{ width: 'auto' }} /></td>
                  <td className="wrap"><div className={styles.itemName}>{row.name}</div><span className={styles.sku}>{row.sku}</span></td>
                  <td className="num">{row.on_hand} <span className="muted">{row.unit}</span></td>
                  <td className="num">{Number(row.on_order) || <span className="muted">0</span>}</td>
                  <td>
                    <StockBar item={{ quantity: row.on_hand, reorder_level: row.reorder_level, reorder_to: row.reorder_to, unit: row.unit }} bare />
                    <div className="muted small" style={{ marginTop: 4 }}>Reorder at {row.reorder_level}{row.reorder_to > row.reorder_level ? `, up to ${row.reorder_to}` : ''}</div>
                  </td>
                  <td className="num">
                    <input aria-label={`Quantity of ${row.name}`} type="number" min="1" step="1" style={{ width: 80 }}
                      value={row.quantity} onChange={(e) => set(row.item_id, 'quantity', e.target.value)} />
                  </td>
                  <td className="num">
                    <input aria-label={`Cost of ${row.name}`} type="number" min="0" step="0.0001" style={{ width: 100 }}
                      value={row.unit_price} onChange={(e) => set(row.item_id, 'unit_price', e.target.value)} />
                  </td>
                  <td>
                    <select aria-label={`Supplier for ${row.name}`} value={row.vendor_id} onChange={(e) => set(row.item_id, 'vendor_id', e.target.value)}>
                      <option value="">Choose…</option>
                      {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
                    </select>
                  </td>
                  <td className="num">{money(Number(row.quantity || 0) * Number(row.unit_price || 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
      </div>
      )}

      {rows && rows.length > 0 && (
        <div className={styles.orderBar}>
          <div className={styles.orderTotal}>
            <span className="stat-label">{chosen.length} chosen</span>
            <strong>{money(total)}</strong>
          </div>
          <label>Expected by<input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></label>
          <div className="form-actions" style={{ margin: 0 }}>
            <button className="primary" onClick={create} disabled={busy || chosen.length === 0 || chosen.some((row) => !row.vendor_id)}>
              {chosen.length === 0 ? 'Choose items to order'
                : `Draft ${supplierCount} purchase ${supplierCount === 1 ? 'order' : 'orders'} (${money(total)} before tax)`}
            </button>
          </div>
          {chosen.some((row) => !row.vendor_id) && <p className="muted small" style={{ flexBasis: '100%', margin: 0 }}>Choose a supplier for every ticked item. You can set a usual supplier on each item.</p>}
          {suppliers.length === 0 && <p className="muted small" style={{ flexBasis: '100%', margin: 0 }}>Add suppliers under Vendors in Accounting first.</p>}
        </div>
      )}
    </div>
  );
}
