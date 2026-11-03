import { FormEvent, useEffect, useState } from 'react';
import { customText } from '@/components/CustomFields';
import { api } from '@/lib/api';

export type Filters = { search?: string; owner?: string; customField?: string; customValue?: string; [name: string]: string | undefined };

// The owner and custom field filters work the same way on every list
export const matchesFilters = (row: any, filters: Filters, fields: any[], searchIn: (string | null | undefined)[]) => {
  const text = (filters.search || '').trim().toLowerCase();
  if (text && !searchIn.some((value) => (value || '').toLowerCase().includes(text))) return false;
  if (filters.owner === 'none' && row.owner_id) return false;
  if (filters.owner && filters.owner !== 'none' && row.owner_id !== filters.owner) return false;
  if (filters.tag && !(row.tags || []).includes(filters.tag)) return false;

  const field = fields.find(({ slug }) => slug === filters.customField);
  const wanted = (filters.customValue || '').trim().toLowerCase();
  if (field && wanted) return customText(field, row.custom?.[field.slug]).toLowerCase().includes(wanted);
  return true;
};

export function ListFilters({ filters, onChange, members, fields }: { filters: Filters; onChange: (filters: Filters) => void; members: any[]; fields: any[] }) {
  const set = (name: string, value: string) => onChange({ ...filters, [name]: value });

  return (
    <>
      <label>Owner
        <select value={filters.owner || ''} onChange={(e) => set('owner', e.target.value)}>
          <option value="">Anyone</option>
          <option value="none">Unassigned</option>
          {members.map((member) => <option key={member.user_id} value={member.user_id}>{member.email}</option>)}
        </select>
      </label>
      {fields.length > 0 && (
        <>
          <label>Custom field
            <select value={filters.customField || ''} onChange={(e) => set('customField', e.target.value)}>
              <option value="">None</option>
              {fields.map((field) => <option key={field.id} value={field.slug}>{field.label}</option>)}
            </select>
          </label>
          {filters.customField && <label>Contains<input value={filters.customValue || ''} onChange={(e) => set('customValue', e.target.value)} /></label>}
        </>
      )}
    </>
  );
}

export default function SavedViews({ entity, filters, onApply }: { entity: string; filters: Filters; onApply: (filters: Filters) => void }) {
  const [views, setViews] = useState<any[]>([]);
  const [userId, setUserId] = useState('');
  const [chosen, setChosen] = useState('');
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [rows, me] = await Promise.all([api.get(`/api/crm/views?entity=${entity}`), api.get('/api/me')]);
      setViews(rows);
      setUserId(me.user.id);
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, [entity]);

  const choose = (id: string) => {
    setChosen(id);
    const view = views.find((row) => row.id === id);
    if (view) onApply(view.filters);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const view = await api.post('/api/crm/views', { entity, name, shared, filters });
      setSaving(false);
      setName('');
      setShared(false);
      setError('');
      await load();
      setChosen(view.id);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const remove = async () => {
    try {
      await api.delete(`/api/crm/views/${chosen}`);
      setChosen('');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const view = views.find((row) => row.id === chosen);

  return (
    <div className="stack">
      <div className="saved-views">
        <label>View
          <select value={chosen} onChange={(e) => choose(e.target.value)}>
            <option value="">Current filters</option>
            {views.map((row) => <option key={row.id} value={row.id}>{row.name}{row.shared ? ' (shared)' : ''}</option>)}
          </select>
        </label>
        <div className="row-actions">
          <button onClick={() => setSaving(!saving)}>Save view</button>
          {view?.user_id === userId && <button className="danger" onClick={remove}>Delete view</button>}
        </div>
      </div>
      {saving && (
        <form className="saved-views" onSubmit={save}>
          <label>View name<input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="check"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />Share with the team</label>
          <div className="row-actions"><button>Save</button></div>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
