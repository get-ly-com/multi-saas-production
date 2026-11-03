import { useRouter } from 'next/router';
import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import InventoryNav from '@/components/InventoryNav';
import { api, formatDate, money } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';

export default function CountSheet() {
  return <AppShell><CountSheetApp /></AppShell>;
}

const blankOrWhole = (value: string) => value === '' || /^\d{1,9}$/.test(value);

function CountSheetApp() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : '';
  const [sheet, setSheet] = useState<any>(null);
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState('');
  const [scan, setScan] = useState('');
  const [onlyDifferent, setOnlyDifferent] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

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

  if (!sheet) {
    return <div className="stack"><InventoryNav />{error ? <p className="error">{error}</p> : <p className="empty">Loading…</p>}</div>;
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
    const code = scan.trim();
    if (!code) return;
    const line = sheet.lines.find((row: any) => row.barcode === code || row.sku === code);
    if (!line) {
      setError(`No item on this sheet with barcode or SKU ${code}`);
      return;
    }
    setCount(line.item_id, String(Number(counted[line.item_id] || 0) + 1));
    setNotice(`${line.name}: ${Number(counted[line.item_id] || 0) + 1}`);
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
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const differenceOf = (line: any) => {
    if (!open) return line.difference;
    return counted[line.item_id] === '' || counted[line.item_id] === undefined ? null : Number(counted[line.item_id]) - line.on_hand;
  };
  const changes = sheet.lines.filter((line: any) => (differenceOf(line) || 0) !== 0);
  const estimate = changes.reduce((sum: number, line: any) => sum + differenceOf(line) * Number(line.avg_cost || 0), 0);
  const countedLines = sheet.lines.filter((line: any) => counted[line.item_id] !== '' && counted[line.item_id] !== undefined).length;

  const apply = () => run(async () => {
    if (!window.confirm(
      `Apply count ${sheet.number}? ${changes.length} ${changes.length === 1 ? 'item changes' : 'items change'}, about ${money(estimate)} in value. This can't be undone, but a new count can correct it.`
    )) return;
    await save();
    const result = await api.post(`/api/inventory/counts/${id}/apply`, {});
    setNotice(`Count applied: ${result.adjusted} ${result.adjusted === 1 ? 'item' : 'items'} adjusted, ${money(result.value_change)} in value.`);
    await load();
  });

  const cancel = () => run(async () => {
    if (!window.confirm(`Cancel count ${sheet.number}? Nothing will change.`)) return;
    await api.post(`/api/inventory/counts/${id}/cancel`, {});
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
            {sheet.category?.name || 'All items'} · started {formatDate(sheet.created_at)}
            {sheet.applied_at && ` · applied ${formatDate(sheet.applied_at)}`}{sheet.note && ` · ${sheet.note}`}
          </div>
        </div>
        <div className="row-actions">
          <button onClick={download}>Download CSV</button>
          {open && <button onClick={() => run(async () => { await save(); setNotice('Saved'); await load(); })} disabled={busy || !dirty}>Save</button>}
          {open && <button className="primary" onClick={apply} disabled={busy || countedLines === 0}>Apply count</button>}
          {open && <button className="danger" onClick={cancel} disabled={busy}>Cancel count</button>}
        </div>
      </div>
      <InventoryNav />

      <div className="stats">
        <div className="card"><div className="stat-label">Status</div><div className="stat-value">{sheet.status}</div></div>
        <div className="card"><div className="stat-label">Counted</div><div className="stat-value">{countedLines} of {sheet.lines.length}</div></div>
        <div className="card"><div className="stat-label">Items that differ</div><div className="stat-value">{changes.length}</div></div>
        <div className="card">
          <div className="stat-label">{open ? 'Value change (estimate)' : 'Value change'}</div>
          <div className="stat-value">{money(open ? estimate : sheet.value_change)}</div>
        </div>
      </div>

      {open && <p className="muted">Leave an item blank if you didn't count it. Differences are against what's there now, so sales made while you count are allowed for.</p>}
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="report-filters">
        {open && (
          <form onSubmit={scanned}>
            <label>Scan to add one
              <input aria-label="Scan barcode" placeholder="Barcode or SKU, then Enter" value={scan} onChange={(e) => setScan(e.target.value)} />
            </label>
          </form>
        )}
        <label>Find<input aria-label="Find item" placeholder="Name, SKU or barcode" value={filter} onChange={(e) => setFilter(e.target.value)} /></label>
        <label className="row-actions" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={onlyDifferent} onChange={(e) => setOnlyDifferent(e.target.checked)} style={{ width: 'auto' }} /> Only differences
        </label>
      </div>

      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>SKU</th><th>Item</th>
              <th className="num">{open ? 'On hand now' : 'Expected'}</th>
              <th className="num">Counted</th><th className="num">Difference</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={5} className="empty">No matches</td></tr>}
            {shown.map((line: any) => {
              const difference = differenceOf(line);
              return (
                <tr key={line.item_id}>
                  <td>{line.sku}</td>
                  <td className="wrap">{line.name}{line.barcode && <div className="muted">{line.barcode}</div>}</td>
                  <td className="num">
                    {open ? line.on_hand : line.expected} <span className="muted">{line.unit}</span>
                    {open && line.on_hand !== line.expected && <div className="muted">was {line.expected} at start</div>}
                  </td>
                  <td className="num">
                    {open ? (
                      <input aria-label={`Counted ${line.name}`} inputMode="numeric" style={{ width: 90, textAlign: 'right' }}
                        value={counted[line.item_id] ?? ''} onChange={(e) => setCount(line.item_id, e.target.value.trim())} />
                    ) : (line.counted ?? '—')}
                  </td>
                  <td className={`num ${difference < 0 ? 'late' : ''}`}>
                    {difference === null || difference === undefined ? '—' : difference > 0 ? `+${difference}` : difference}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
