import { FormEvent, useEffect, useState } from 'react';
import { Tag } from '@/components/Tags';
import { api } from '@/lib/api';

type Entity = 'contact' | 'company' | 'lead' | 'deal';

const NAMES: Record<Entity, [string, string]> = {
  contact: ['contact', 'contacts'],
  company: ['company', 'companies'],
  lead: ['lead', 'leads'],
  deal: ['deal', 'deals']
};

// Rows picked with checkboxes. Selecting the header box picks every row shown.
export const useSelection = (visibleIds: string[]) => {
  const [selected, setSelected] = useState<string[]>([]);
  const key = visibleIds.join(',');

  // Rows that are filtered out or deleted drop out of the selection
  useEffect(() => {
    setSelected((current) => current.filter((id) => visibleIds.includes(id)));
  }, [key]);

  const all = visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id));
  return {
    selected,
    clear: () => setSelected([]),
    has: (id: string) => selected.includes(id),
    toggle: (id: string) => setSelected((current) => (current.includes(id) ? current.filter((row) => row !== id) : [...current, id])),
    all,
    toggleAll: () => setSelected(all ? [] : visibleIds)
  };
};

export default function BulkBar({ entity, selected, onDone, onClear, tags, members, stages = [] }: {
  entity: Entity;
  selected: string[];
  onDone: (message: string) => void;
  onClear: () => void;
  tags: Tag[];
  members: any[];
  stages?: { id: string; name: string; kind: string; pipeline?: string }[];
}) {
  const [action, setAction] = useState('');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [reasons, setReasons] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [one, many] = NAMES[entity];
  const count = selected.length;
  const label = `${count} ${count === 1 ? one : many}`;

  useEffect(() => {
    if (entity === 'deal') api.get('/api/crm/lost-reasons').then(setReasons).catch(() => setReasons([]));
  }, [entity]);

  if (!count) return null;

  const stageKind = stages.find(({ id }) => id === value)?.kind;
  const needsReason = (action === 'stage' && stageKind === 'lost') || (action === 'status' && value === 'disqualified');
  const needsValue = ['add_tag', 'remove_tag', 'stage', 'status'].includes(action);

  const apply = async (event: FormEvent) => {
    event.preventDefault();
    if (!action) return;
    if (action === 'delete' && !window.confirm(`Delete ${label}? This can't be undone.`)) return;
    setBusy(true);
    try {
      const result = await api.post('/api/crm/bulk', { entity, ids: selected, action, value, reason });
      const changed = Number(result.changed);
      const skipped = count - changed;
      onDone(`${action === 'delete' ? 'Deleted' : 'Changed'} ${changed} of ${label}.${skipped ? ` ${skipped} already matched${entity === 'lead' && action === 'status' ? ' or were converted' : ''}.` : ''}`);
      setAction('');
      setValue('');
      setReason('');
      setError('');
      onClear();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const choose = (next: string) => {
    setAction(next);
    setValue('');
    setReason('');
    setError('');
  };

  return (
    <form className="bulk-bar" onSubmit={apply}>
      <strong>{label} selected</strong>
      <select aria-label="What to do with the selected rows" value={action} onChange={(e) => choose(e.target.value)}>
        <option value="">Choose an action…</option>
        <option value="owner">Change owner</option>
        {tags.length > 0 && <option value="add_tag">Add a tag</option>}
        {tags.length > 0 && <option value="remove_tag">Remove a tag</option>}
        {entity === 'deal' && <option value="stage">Move to a stage</option>}
        {entity === 'lead' && <option value="status">Set status</option>}
        <option value="delete">Delete</option>
      </select>

      {action === 'owner' && (
        <select aria-label="New owner" value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">Unassigned</option>
          {members.filter((member) => member.role !== 'viewer').map((member) => <option key={member.user_id} value={member.user_id}>{member.email}</option>)}
        </select>
      )}
      {(action === 'add_tag' || action === 'remove_tag') && (
        <select aria-label="Tag" required value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">Choose a tag</option>
          {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
        </select>
      )}
      {action === 'stage' && (
        <select aria-label="Stage" required value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">Choose a stage</option>
          {stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.pipeline ? `${stage.pipeline}: ` : ''}{stage.name}</option>)}
        </select>
      )}
      {action === 'status' && (
        <select aria-label="Status" required value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">Choose a status</option>
          <option value="new">New</option>
          <option value="working">Working</option>
          <option value="disqualified">Disqualified</option>
        </select>
      )}
      {needsReason && (
        <>
          <input aria-label="Reason" required maxLength={200} list="bulk-reasons" placeholder={action === 'stage' ? 'Why were they lost?' : 'Why are they disqualified?'} value={reason} onChange={(e) => setReason(e.target.value)} />
          <datalist id="bulk-reasons">{reasons.map((row) => <option key={row.id} value={row.name} />)}</datalist>
        </>
      )}

      <button className={action === 'delete' ? 'danger' : 'primary'} disabled={busy || !action || (needsValue && !value)}>{action === 'delete' ? 'Delete' : 'Apply'}</button>
      <button type="button" onClick={onClear}>Clear selection</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
