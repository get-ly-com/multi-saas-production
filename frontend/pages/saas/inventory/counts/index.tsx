import Link from 'next/link';
import { useRouter } from 'next/router';
import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import EmptyState from '@/components/EmptyState';
import InventoryNav from '@/components/InventoryNav';
import Modal from '@/components/Modal';
import { SkeletonTable } from '@/components/Skeleton';
import styles from '@/styles/inventory.module.css';
import { api, formatDate, money } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

export default function Counts() {
  return <AppShell><CountsApp /></AppShell>;
}

function CountsApp() {
  const [counts, setCounts] = useState<any[] | null>(null);
  const [places, setPlaces] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get('/api/inventory/counts'),
      api.get('/api/inventory/locations'),
      api.get('/api/inventory/categories')
    ])
      .then(([countRows, placeRows, categoryRows]) => {
        setCounts(countRows);
        setPlaces(placeRows);
        setCategories(categoryRows);
      })
      .catch((err) => {
        setError(err.message);
        setCounts([]);
      });
  }, []);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Stock counts</h1>
          <p className="muted">Scan the shelves, then set stock to what is really there in one go.</p>
        </div>
        <button className="primary" onClick={() => setStarting(true)}>Start a count</button>
      </div>
      <InventoryNav />
      <p className="muted small">
        Count what's really on the shelves, then apply the count: every counted item is set to what you found, in one go, and the
        difference in value goes to Stock Adjustments. Items you leave blank aren't changed.
      </p>
      {error && <p className="error">{error}</p>}

      {!counts ? <SkeletonTable rows={4} columns={6} /> : counts.length === 0 ? (
        <div className="card">
          <EmptyState icon="inventory" title="No counts yet" line="Start one for a shelf, a category or the whole warehouse. Scanning makes it quick."
            action={{ label: 'Start a count', onClick: () => setStarting(true) }} />
        </div>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Count</th><th>Started</th><th>Where</th><th>Category</th><th>Status</th><th>Counted</th><th className="num">Value change</th></tr></thead>
            <tbody>
              {counts.map((row) => {
                const share = Number(row.lines) ? Math.round((Number(row.counted) / Number(row.lines)) * 100) : 0;
                return (
                  <tr key={row.id}>
                    <td><Link href={`/saas/inventory/counts/${row.id}`}><strong>Count {row.number}</strong></Link></td>
                    <td>{formatDate(row.created_at)}</td>
                    <td>{row.location?.name}</td>
                    <td>{row.category?.name || 'All items'}</td>
                    <td><span className={`badge ${row.status === 'applied' ? 'applied' : row.status === 'open' ? 'pending' : 'cancelled'}`}>{row.status === 'open' ? 'Counting' : row.status === 'applied' ? 'Applied' : 'Cancelled'}</span></td>
                    <td>
                      <div className={styles.progress} style={{ minWidth: 120 }}>
                        <div className={styles.progressTop}><span>{row.counted} of {row.lines}</span><span className="muted">{share}%</span></div>
                        <div className={styles.progressTrack} style={{ height: 6 }}><span className={share === 100 ? styles.full : ''} style={{ width: `${share}%` }} /></div>
                      </div>
                    </td>
                    <td className="num">{row.value_change === null ? '—' : money(row.value_change)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {starting && <StartForm places={places.filter((place) => place.active)} categories={categories} onClose={() => setStarting(false)} />}
    </div>
  );
}

function StartForm({ places, categories, onClose }: { places: any[]; categories: any[]; onClose: () => void }) {
  const router = useRouter();
  const [location, setLocation] = useState(places.find((place) => place.is_main)?.id || places[0]?.id || '');
  const [category, setCategory] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        const { id } = await api.post('/api/inventory/counts', { location_id: location, category_id: category, note });
        router.push(`/saas/inventory/counts/${id}`);
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title="Start a count" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Where
            <select required value={location} onChange={(e) => setLocation(e.target.value)}>
              {places.map((place) => <option key={place.id} value={place.id}>{place.name}</option>)}
            </select>
          </label>
          <label>What
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All items</option>
              {categories.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </select>
          </label>
          <label>Note<input maxLength={500} placeholder="Optional, e.g. Year end" value={note} onChange={(e) => setNote(e.target.value)} /></label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">Start</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
