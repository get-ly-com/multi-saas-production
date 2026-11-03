import { FormEvent, useEffect, useState } from 'react';
import { TAG_COLORS } from '@/components/Tags';
import { api } from '@/lib/api';

// Tags: anyone who can edit can add or rename; owners and admins can delete
export function TagSettings() {
  const [tags, setTags] = useState<any[]>([]);
  const [name, setName] = useState('');
  const [color, setColor] = useState('blue');
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setTags(await api.get('/api/crm/tags'));
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      setError('');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const add = (event: FormEvent) => {
    event.preventDefault();
    run(async () => {
      await api.post('/api/crm/tags', { name, color });
      setName('');
    });
  };

  const rename = (tag: any) => {
    const next = window.prompt('Rename the tag', tag.name);
    if (next && next.trim() && next.trim() !== tag.name) run(() => api.put(`/api/crm/tags/${tag.id}`, { name: next }));
  };

  return (
    <div className="card stack">
      <h2>Tags</h2>
      <p className="muted">Tags group contacts, companies, leads and deals, for example VIP or Trade show. Filter any list by a tag, or add one to many rows at once. Deleting a tag takes it off every record.</p>
      <div className="tag-list">
        {tags.length === 0 && <span className="muted">No tags yet</span>}
        {tags.map((tag) => (
          <span key={tag.id} className="tag-row">
            <span className={`tag tag-${tag.color}`}>{tag.name}</span>
            <select aria-label={`Colour of ${tag.name}`} value={tag.color} onChange={(e) => run(() => api.put(`/api/crm/tags/${tag.id}`, { color: e.target.value }))}>
              {TAG_COLORS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
            <button type="button" className="link" onClick={() => rename(tag)}>Rename</button>
            <button type="button" className="link" onClick={() => window.confirm(`Delete the tag ${tag.name}? It comes off every record.`) && run(() => api.delete(`/api/crm/tags/${tag.id}`))}>Delete</button>
          </span>
        ))}
      </div>
      <form className="saved-views" onSubmit={add}>
        <label>New tag<input required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Colour
          <select value={color} onChange={(e) => setColor(e.target.value)}>
            {TAG_COLORS.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <div className="row-actions"><button>Add tag</button></div>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

const USUAL_REASONS = ['Price too high', 'Chose a competitor', 'No budget', 'No response', 'Not the right time', 'Missing features'];

// The reasons people pick from when a deal is lost
export function LostReasonSettings() {
  const [reasons, setReasons] = useState<any[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setReasons(await api.get('/api/crm/lost-reasons'));
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      setError('');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const add = (event: FormEvent) => {
    event.preventDefault();
    run(async () => {
      await api.post('/api/crm/lost-reasons', { name });
      setName('');
    });
  };

  const addUsual = () => run(async () => {
    const have = reasons.map((row) => row.name.toLowerCase());
    for (const reason of USUAL_REASONS.filter((row) => !have.includes(row.toLowerCase()))) {
      await api.post('/api/crm/lost-reasons', { name: reason });
    }
  });

  return (
    <div className="card stack">
      <h2>Lost reasons</h2>
      <p className="muted">When a deal is lost, people pick one of these (or type their own), so the Reports page can show why deals are lost. Only owners and admins can change the list.</p>
      <div className="tag-list">
        {reasons.length === 0 && <span className="muted">No reasons yet, so people type one each time</span>}
        {reasons.map((reason) => (
          <span key={reason.id} className="tag-row">
            <span className="tag tag-grey">{reason.name}</span>
            <button type="button" className="link" onClick={() => run(() => api.delete(`/api/crm/lost-reasons/${reason.id}`))}>Remove</button>
          </span>
        ))}
      </div>
      <form className="saved-views" onSubmit={add}>
        <label>New reason<input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div className="row-actions">
          <button>Add reason</button>
          {reasons.length < USUAL_REASONS.length && <button type="button" onClick={addUsual}>Add the usual reasons</button>}
        </div>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
