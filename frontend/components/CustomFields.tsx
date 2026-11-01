import { useEffect, useState } from 'react';
import { api, formatDate } from '@/lib/api';

export const useCustomFields = (entity: string) => {
  const [fields, setFields] = useState<any[]>([]);

  useEffect(() => {
    api.get(`/api/crm/custom-fields?entity=${entity}`).then(setFields).catch(() => setFields([]));
  }, [entity]);

  return fields;
};

export const customText = (field: any, value: any) => {
  if (value === undefined || value === null || value === '') return '';
  if (field.kind === 'checkbox') return value ? 'Yes' : 'No';
  if (field.kind === 'date') return formatDate(value);
  return String(value);
};

export function CustomInputs({ fields, values, onChange }: { fields: any[]; values: any; onChange: (values: any) => void }) {
  const custom = values || {};
  const set = (slug: string, value: unknown) => onChange({ ...custom, [slug]: value });

  return (
    <>
      {fields.map((field) => {
        const value = custom[field.slug] ?? '';
        if (field.kind === 'checkbox') {
          return <label className="check" key={field.id}><input type="checkbox" checked={value === true} onChange={(e) => set(field.slug, e.target.checked)} />{field.label}</label>;
        }
        if (field.kind === 'select') {
          // A choice removed in settings still shows, so saving doesn't silently change the record
          const choices = field.options.includes(value) || !value ? field.options : [value, ...field.options];
          return (
            <label key={field.id}>{field.label}
              <select required={field.required} value={value} onChange={(e) => set(field.slug, e.target.value)}>
                <option value="">None</option>
                {choices.map((choice: string) => <option key={choice} value={choice}>{choice}</option>)}
              </select>
            </label>
          );
        }
        return (
          <label key={field.id}>{field.label}
            <input
              required={field.required}
              type={field.kind === 'text' ? 'text' : field.kind}
              step={field.kind === 'number' ? 'any' : undefined}
              value={value}
              onChange={(e) => set(field.slug, e.target.value)}
            />
          </label>
        );
      })}
    </>
  );
}

export function CustomValues({ entity, values }: { entity: string; values: any }) {
  const fields = useCustomFields(entity).filter((field) => customText(field, values?.[field.slug]));
  if (!fields.length) return null;

  return (
    <div className="card">
      <div className="facts">
        {fields.map((field) => (
          <div key={field.id}><div className="stat-label">{field.label}</div><div className="wrap">{customText(field, values[field.slug])}</div></div>
        ))}
      </div>
    </div>
  );
}
