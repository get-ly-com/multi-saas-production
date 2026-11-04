import { useRouter } from 'next/router';
import { FormEvent, useEffect, useRef, useState } from 'react';
import AppShell from '@/components/AppShell';
import { ScanWithCamera } from '@/components/BarcodeScanner';
import { celebrate } from '@/components/Celebrate';
import EmptyState from '@/components/EmptyState';
import Icon from '@/components/Icon';
import InventoryNav from '@/components/InventoryNav';
import Skeleton, { SkeletonStats, SkeletonTable } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api, formatDate, money, queryId } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import styles from '@/styles/inventory.module.css';

export default function CountSheet() {
  return <AppShell><CountSheetApp /></AppShell>;
}

const blankOrWhole = (value: string) => value === '' || /^\d{1,9}$/.test(value);

const STATUS_STYLE: Record<string, string> = { open: 'pending', applied: 'applied', cancelled: 'cancelled' };
const STATUS_TEXT: Record<string, string> = { open: 'Counting', applied: 'Applied', cancelled: 'Cancelled' };

function CountSheetApp() {
  const router = useRouter();
  const id = queryId(router.query.id) || '';
  const [sheet, setSheet] = useState<any>(null);
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState('');
  const [scan, setScan] = useState('');
  const [onlyDifferent, setOnlyDifferent] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The last scan: which row lit up, what it now reads, or the code that wasn't found
  const [hit, setHit] = useState<{ id: string; name: string; count: number; key: number } | null>(null);
  const [miss, setMiss] = useState<{ code: string; key: number } | null>(null);
  const scanBox = useRef<HTMLInputElement>(null);
  const applyButton = useRef<HTMLButtonElement>(null);
  const scans = useRef(0);

  const load = async () => {
    try {
      const data = await api.get(`/api/inventory/counts/${id}`);
      setSheet(data);
      setCounted(Object.fromEntries(data.lines.map((line: any) => [line.item_id, line.counted === null ? '' : String(line.counted)])));
      setDirty(false);
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    if (id) load();
  }, [id]);

  // Bring the row that was just scanned into view
  useEffect(() => {
    if (hit) document.getElementById(`count-row-${hit.id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [hit?.key]);

  if (!sheet) {
    return (
      <div className="stack">
        <InventoryNav />
        {error ? <p className="error">{error}</p> : (
          <div className="stack" role="status" aria-label="Loading">
            <Skeleton width={280} height={26} />
            <SkeletonStats count={4} />
            <Skeleton height={120} radius={12} />
            <SkeletonTable rows={6} columns={5} />
          </div>
        )}
      </div>
    );
  }

  const open = sheet.status === 'open';
  const setCount = (itemId: string, value: string) => {
    if (!blankOrWhole(value)) return;
    setCounted({ ...counted, [itemId]: value });
    setDirty(true);
  };

  // Each scan adds one of that item to the count
  const scanned = (event: FormEvent) => {
    event.preventDefault();
    addOne(scan);
  };
  // The camera fills the box and adds the item at once
  const scannedWithCamera = (code: string) => {
    setScan(code);
    addOne(code);
    setTimeout(() => scanBox.current?.focus(), 0);
  };
  const addOne = (typed: string) => {
    const code = typed.trim();
    if (!code) return;
    const line = sheet.lines.find((row: any) => row.barcode === code || row.sku === code);
    if (!line) {
      setMiss({ code, key: ++scans.current });
      setHit(null);
      setScan('');
      return;
    }
    const next = Number(counted[line.item_id] || 0) + 1;
    setCount(line.item_id, String(next));
    setHit({ id: line.item_id, name: line.name, count: next, key: ++scans.current });
    setMiss(null);
    setError('');
    setScan('');
  };

  const save = async () => {
    await api.put(`/api/inventory/counts/${id}`, {
      lines: sheet.lines.map((line: any) => ({ item_id: line.item_id, counted: counted[line.item_id] ?? '' }))
    });
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      setError('');
    } catch (err: any) {
      toast.error('That did not go through', { detail: err.message });
    } finally {
      setBusy(false);
    }
  };

  const differenceOf = (line: any) => {
    if (!open) return line.difference;
    return counted[line.item_id] === '' || counted[line.item_id] === undefined ? null : Number(counted[line.item_id]) - line.on_hand;
  };
  const isCounted = (line: any) => (open ? counted[line.item_id] !== '' && counted[line.item_id] !== undefined : line.counted !== null && line.counted !== undefined);
  const changes = sheet.lines.filter((line: any) => (differenceOf(line) || 0) !== 0);
  const estimate = changes.reduce((sum: number, line: any) => sum + differenceOf(line) * Number(line.avg_cost || 0), 0);
  const countedLines = sheet.lines.filter((line: any) => counted[line.item_id] !== '' && counted[line.item_id] !== undefined).length;
  const total = sheet.lines.length;
  const progress = total ? Math.round((countedLines / total) * 100) : 0;

  const apply = () => run(async () => {
    if (!window.confirm(
      `Apply count ${sheet.number}? ${changes.length} ${changes.length === 1 ? 'item changes' : 'items change'}, about ${money(estimate)} in value. This can't be undone, but a new count can correct it.`
    )) return;
    await save();
    const result = await api.post(`/api/inventory/counts/${id}/apply`, {});
    toast.success('Count applied', { detail: `${result.adjusted} ${result.adjusted === 1 ? 'item' : 'items'} adjusted, ${money(result.value_change)} in value. Shelves and books agree.` });
    celebrate({ from: applyButton.current });
    await load();
  });

  const cancel = () => run(async () => {
    if (!window.confirm(`Cancel count ${sheet.number}? Nothing will change.`)) return;
    await api.post(`/api/inventory/counts/${id}/cancel`, {});
    toast.info('Count cancelled', { detail: 'Nothing was changed.' });
    await load();
  });

  const download = () => downloadCsv(`stock-count-${sheet.number}.csv`, [
    ['SKU', 'Item', 'Barcode', 'Unit', 'Expected', 'On hand now', 'Counted', 'Difference'],
    ...sheet.lines.map((line: any) => [line.sku, line.name, line.barcode, line.unit, line.expected, line.on_hand,
      counted[line.item_id] ?? '', differenceOf(line) ?? ''])
  ]);

  const query = filter.trim().toLowerCase();
  const shown = sheet.lines.filter((line: any) =>
    `${line.name} ${line.sku} ${line.barcode || ''}`.toLowerCase().includes(query)
    && (!onlyDifferent || (differenceOf(line) || 0) !== 0));

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Count {sheet.number} · {sheet.location?.name}</h1>
          <div className="muted">
            <span className={`badge ${STATUS_STYLE[sheet.status] || ''}`}>{STATUS_TEXT[sheet.status] || sheet.status}</span>{' '}
            {sheet.category?.name || 'All items'} · started {formatDate(sheet.created_at)}
            {sheet.applied_at && ` · applied ${formatDate(sheet.applied_at)}`}{sheet.note && ` · ${sheet.note}`}
          </div>
        </div>
        <div className="row-actions">
          <button onClick={download}>Download CSV</button>
          {open && <button className="danger" onClick={cancel} disabled={busy}>Cancel count</button>}
          {open && <button onClick={() => run(async () => { await save(); toast.success('Count saved', { detail: `${countedLines} of ${total} counted so far.` }); await load(); })} disabled={busy || !dirty}>Save</button>}
          {open && <button ref={applyButton} className="primary" onClick={apply} disabled={busy || countedLines === 0}><Icon name="check" size={15} /> Apply count</button>}
        </div>
      </div>
      <InventoryNav />

      <div className="stats">
        <div className="card"><div className="stat-label">Counted</div><div className="stat-value">{countedLines} of {total}</div></div>
        <div className="card"><div className="stat-label">Items that differ</div><div className="stat-value">{changes.length}</div></div>
        <div className="card">
          <div className="stat-label">{open ? 'Value change (estimate)' : 'Value change'}</div>
          <div className="stat-value">{money(open ? estimate : sheet.value_change)}</div>
        </div>
        <div className="card"><div className="stat-label">Where</div><div className="stat-value">{sheet.location?.name || '—'}</div></div>
      </div>

      {error && <p className="error">{error}</p>}

      {open ? (
        <section className={styles.scanHero} aria-label="Scan items">
          <form onSubmit={scanned}>
            <label htmlFor="count-scan" className="stat-label">Scan to add one</label>
            <div className={`${styles.scanRow} ${hit ? (hit.key % 2 ? styles.hit : styles.hit2) : ''} ${miss ? styles.miss : ''}`} key={miss?.key} style={{ marginTop: 6 }}>
              <input id="count-scan" ref={scanBox} autoFocus autoComplete="off" aria-label="Scan barcode" placeholder="Scan or type a barcode or SKU, then Enter"
                value={scan} onChange={(e) => setScan(e.target.value)} />
              <ScanWithCamera onCode={scannedWithCamera} label="Camera" />
            </div>
          </form>
          <div className={styles.scanLast} aria-live="polite">
            {hit && <span className={styles.scanPop} key={hit.key}><Icon name="check" size={14} strokeWidth={2.5} />{hit.name}: <strong>{hit.count}</strong></span>}
            {miss && <span className={styles.scanMiss} key={miss.key}><Icon name="x" size={14} strokeWidth={2.5} />No item on this sheet with code {miss.code}</span>}
            {!hit && !miss && <span className="muted">Each scan adds one. Type a number in a row to set it directly.</span>}
          </div>
          <div className={styles.progress}>
            <div className={styles.progressTop}>
              <span>{countedLines === total && total > 0 ? 'Every item counted' : `${countedLines} of ${total} items counted`}</span>
              <span className="muted">{progress}%</span>
            </div>
            <div className={styles.progressTrack} role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Items counted">
              <span className={countedLines === total && total > 0 ? styles.full : ''} style={{ width: `${progress}%` }} />
            </div>
          </div>
          <p className="muted small" style={{ margin: 0 }}>Leave an item blank if you didn&apos;t count it. Differences are against what&apos;s there now, so sales made while you count are allowed for.</p>
        </section>
      ) : sheet.status === 'applied' ? (
        <div className="card">
          <EmptyState compact tone="done" icon="inventory" title="Count applied"
            line={`Every counted item was set to what you found${sheet.applied_at ? ` on ${formatDate(sheet.applied_at)}` : ''}.`}
            action={{ label: 'Back to items', href: '/saas/inventory' }} secondary={{ label: 'All counts', href: '/saas/inventory/counts' }} />
        </div>
      ) : null}

      <div className="report-filters">
        <label>Find<input type="search" aria-label="Find item" placeholder="Name, SKU or barcode" value={filter} onChange={(e) => setFilter(e.target.value)} /></label>
        <label className="check">
          <input type="checkbox" checked={onlyDifferent} onChange={(e) => setOnlyDifferent(e.target.checked)} /> Only differences
        </label>
      </div>

      {shown.length === 0 ? (
        <div className="card">
          <EmptyState compact icon="search" title={onlyDifferent && !query ? 'No differences' : 'No matches'}
            tone={onlyDifferent && !query ? 'done' : 'plain'}
            line={onlyDifferent && !query ? 'Everything you counted matches what was expected.' : 'Try another name or code.'} />
        </div>
      ) : (
        <div className={`card table-wrap ${styles.sheet}`}>
          <table>
            <thead>
              <tr>
                <th>Item</th><th>SKU</th>
                <th className="num">{open ? 'On hand now' : 'Expected'}</th>
                <th className="num">Counted</th><th className="num">Difference</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((line: any) => {
                const difference = differenceOf(line);
                const lit = hit?.id === line.item_id;
                return (
                  <tr key={lit ? `${line.item_id}-${hit!.key}` : line.item_id} id={`count-row-${line.item_id}`}
                    className={`${isCounted(line) ? styles.counted : ''} ${lit ? styles.hitRow : ''}`}>
                    <td className="wrap">
                      <div className={styles.itemName}>{line.name}</div>
                      {line.barcode && <span className={`${styles.sku} muted`}>{line.barcode}</span>}
                    </td>
                    <td><span className={styles.sku}>{line.sku}</span></td>
                    <td className="num">
                      {open ? line.on_hand : line.expected} <span className="muted">{line.unit}</span>
                      {open && line.on_hand !== line.expected && <div className="muted small">was {line.expected} at start</div>}
                    </td>
                    <td className="num">
                      {open ? (
                        <input aria-label={`Counted ${line.name}`} inputMode="numeric" className={`${styles.countInput} ${lit ? styles.hitInput : ''}`}
                          value={counted[line.item_id] ?? ''} onChange={(e) => setCount(line.item_id, e.target.value.trim())} />
                      ) : (line.counted ?? '—')}
                    </td>
                    <td className={`num ${difference < 0 ? styles.diffDown : difference > 0 ? styles.diffUp : ''}`}>
                      {difference === null || difference === undefined ? '—' : difference > 0 ? `+${difference}` : difference === 0 ? <span className="muted">0</span> : difference}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
