import { KeyboardEvent, useEffect, useState } from 'react';
import { CRM_SAVED, api } from '@/lib/api';

export const TAG_COLORS = ['grey', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'];

export type Tag = { id: string; name: string; color: string };

// The company's tags, reloaded whenever something in the CRM is saved
export const useTags = () => {
  const [tags, setTags] = useState<Tag[]>([]);

  useEffect(() => {
    const load = () => api.get('/api/crm/tags').then(setTags).catch(() => setTags([]));
    load();
    window.addEventListener(CRM_SAVED, load);
    return () => window.removeEventListener(CRM_SAVED, load);
  }, []);

  return tags;
};

export const tagNames = (ids: string[] | undefined, tags: Tag[]) =>
  (ids || []).map((id) => tags.find((tag) => tag.id === id)?.name).filter(Boolean).join('; ');

export function TagChips({ ids, tags }: { ids?: string[]; tags: Tag[] }) {
  const shown = (ids || []).map((id) => tags.find((tag) => tag.id === id)).filter(Boolean) as Tag[];
  if (!shown.length) return null;
  return (
    <span className="tag-list">
      {shown.map((tag) => <span key={tag.id} className={`tag tag-${tag.color}`}>{tag.name}</span>)}
    </span>
  );
}

// Click a tag to add or take it off; type a new name and press Enter to make one
export function TagPicker({ value, onChange, tags }: { value: string[]; onChange: (ids: string[]) => void; tags: Tag[] }) {
  const [name, setName] = useState('');
  const [made, setMade] = useState<Tag[]>([]);
  const [error, setError] = useState('');
  const all = [...tags, ...made.filter((tag) => !tags.some(({ id }) => id === tag.id))];
  const chosen = value || [];

  const toggle = (id: string) => onChange(chosen.includes(id) ? chosen.filter((tag) => tag !== id) : [...chosen, id]);

  const add = async () => {
    const text = name.trim();
    if (!text) return;
    const existing = all.find((tag) => tag.name.toLowerCase() === text.toLowerCase());
    if (existing) {
      if (!chosen.includes(existing.id)) onChange([...chosen, existing.id]);
      setName('');
      return;
    }
    try {
      const tag = await api.post('/api/crm/tags', { name: text, color: TAG_COLORS[all.length % TAG_COLORS.length] });
      setMade([...made, tag]);
      onChange([...chosen, tag.id]);
      setName('');
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      add();
    }
  };

  return (
    <div className="tag-picker">
      <span className="tag-picker-label">Tags</span>
      <div className="tag-list">
        {all.map((tag) => (
          <button
            type="button"
            key={tag.id}
            aria-pressed={chosen.includes(tag.id)}
            className={`tag tag-${tag.color} ${chosen.includes(tag.id) ? 'chosen' : 'unchosen'}`}
            onClick={() => toggle(tag.id)}
          >
            {tag.name}
          </button>
        ))}
        <input aria-label="New tag" placeholder="New tag, then Enter" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={onKey} />
        {name.trim() && <button type="button" onClick={add}>Add</button>}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

export function TagFilter({ value, onChange, tags }: { value: string; onChange: (value: string) => void; tags: Tag[] }) {
  if (!tags.length) return null;
  return (
    <label>Tag
      <select value={value || ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">Any</option>
        {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
      </select>
    </label>
  );
}
