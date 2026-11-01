import { FormEvent, useEffect, useState } from 'react';
import { api } from '@/lib/api';

const ENTITIES = [
  { id: 'lead', name: 'Leads' },
  { id: 'contact', name: 'Contacts' },
  { id: 'company', name: 'Companies' },
  { id: 'deal', name: 'Deals' }
];

const KINDS = [
  { id: 'text', name: 'Text' },
  { id: 'number', name: 'Number' },
  { id: 'date', name: 'Date' },
  { id: 'select', name: 'Choice list' },
  { id: 'checkbox', name: 'Yes or no' }
];

const blank = { entity: 'lead', label: '', kind: 'text', options: '', required: false };

export default function CustomFieldSettings() {
  const [fields, setFields] = useState<any[]>([]);
  const [editing, setEditing] = useState<any>(null);
  const [error, setError] = useState('');
  const set = (field: string, value: unknown) => setEditing({ ...editing, [field]: value });

  const load = async () => {
    try {
      setFields(await api.get('/api/crm/custom-fields'));
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post('/api/crm/custom-fields', {
        ...editing,
        options: editing.kind === 'select' ? editing.options.split(',').map((choice: string) => choice.trim()).filter(Boolean) : []
      });
      setEditing(null);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const remove = async (field: any) => {
    if (!window.confirm(`Delete ${field.label}? What people entered in it is deleted too.`)) return;
    try {
      await api.delete(`/api/crm/custom-fields/${field.id}`);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <h2>Custom fields</h2>
        <button onClick={() => setEditing(blank)}>New field</button>
      </div>
      {error && <p className="error">{error}</p>}

      {editing && (
        <form className="card" onSubmit={save}>
          <div className="form-grid">
            <label>Add to
              <select disabled={Boolean(editing.id)} value={editing.entity} onChange={(e) => set('entity', e.target.value)}>
                {ENTITIES.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
              </select>
            </label>
            <label>Name<input required maxLength={80} value={editing.label} onChange={(e) => set('label', e.target.value)} /></label>
            <label>Type
              <select disabled={Boolean(editing.id)} value={editing.kind} onChange={(e) => set('kind', e.target.value)}>
                {KINDS.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
              </select>
            </label>
            {editing.kind === 'select' && <label>Choices, separated by commas<input required value={editing.options} onChange={(e) => set('options', e.target.value)} /></label>}
          </div>
          <label className="check"><input type="checkbox" checked={editing.required} onChange={(e) => set('required', e.target.checked)} />Required when someone fills in the form</label>
          <div className="form-actions">
            <button className="primary">Save field</button>
            <button type="button" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form>
      )}

      <div className="card table-wrap">
        <table>
          <thead><tr><th>Field</th><th>On</th><th>Type</th><th>Required</th><th /></tr></thead>
          <tbody>
            {fields.length === 0 && <tr><td colSpan={5} className="empty">No custom fields yet</td></tr>}
            {fields.map((field) => (
              <tr key={field.id}>
                <td className="wrap">{field.label}</td>
                <td>{ENTITIES.find(({ id }) => id === field.entity)?.name}</td>
                <td>{KINDS.find(({ id }) => id === field.kind)?.name}</td>
                <td>{field.required ? 'Yes' : 'No'}</td>
                <td>
                  <div className="row-actions">
                    <button onClick={() => setEditing({ ...field, options: field.options.join(', ') })}>Edit</button>
                    <button className="danger" onClick={() => remove(field)}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
