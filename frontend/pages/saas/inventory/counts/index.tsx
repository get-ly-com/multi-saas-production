import Link from 'next/link';
import { useRouter } from 'next/router';
import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import InventoryNav from '@/components/InventoryNav';
import Modal from '@/components/Modal';
import { api, formatDate, money } from '@/lib/api';

export default function Counts() {
  return <AppShell><CountsApp /></AppShell>;
}

function CountsApp() {
  const [counts, setCounts] = useState<any[]>([]);
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
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Stock counts</h1>
        <button className="primary" onClick={() => setStarting(true)}>Start a count</button>
      </div>
      <InventoryNav />
      <p className="muted">
        Count what's really on the shelves, then apply the count: every counted item is set to what you found, in one go, and the
        difference in value goes to Stock Adjustments. Items you leave blank aren't changed.
      </p>
      {error && <p className="error">{error}</p>}

      <div className="card table-wrap">
        <table>
          <thead><tr><th>#</th><th>Started</th><th>Where</th><th>Category</th><th>Status</th><th className="num">Counted</th><th className="num">Value change</th></tr></thead>
          <tbody>
            {counts.length === 0 && <tr><td colSpan={7} className="empty">No counts yet</td></tr>}
            {counts.map((row) => (
              <tr key={row.id}>
                <td><Link href={`/saas/inventory/counts/${row.id}`}>Count {row.number}</Link></td>
                <td>{formatDate(row.created_at)}</td>
                <td>{row.location?.name}</td>
                <td>{row.category?.name || 'All items'}</td>
                <td><span className={`badge ${row.status === 'applied' ? 'paid' : row.status === 'open' ? 'open' : 'void'}`}>{row.status}</span></td>
                <td className="num">{row.counted} of {row.lines}</td>
                <td className="num">{row.value_change === null ? '—' : money(row.value_change)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const { id } = await api.post('/api/inventory/counts', { location_id: location, category_id: category, note });
      router.push(`/saas/inventory/counts/${id}`);
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title="Start a count">
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
          <button className="primary">Start</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
