import { FormEvent, useEffect, useState } from 'react';
import { useTeam } from '@/components/CrmForms';
import Modal from '@/components/Modal';
import { api } from '@/lib/api';

export const EVENTS = [
  { id: 'lead_created', name: 'A new lead arrives', filter: 'source' },
  { id: 'lead_hot', name: 'A lead turns Hot', filter: 'source' },
  { id: 'lead_idle', name: 'A lead goes quiet', filter: 'source', days: 'Quiet for this many days' },
  { id: 'deal_created', name: 'A new deal is added', filter: 'value' },
  { id: 'deal_stage', name: 'A deal enters a stage', filter: 'value', stage: true },
  { id: 'deal_won', name: 'A deal is won', filter: 'value' },
  { id: 'deal_lost', name: 'A deal is lost', filter: 'value' },
  { id: 'deal_idle', name: 'A deal goes quiet', filter: 'value', days: 'Quiet for this many days' },
  { id: 'deal_closing', name: 'A deal is close to its expected date', filter: 'value', days: 'Days before the date' },
  { id: 'quote_expiring', name: 'A sent quote is about to expire', filter: 'value', days: 'Days before it expires' }
] as { id: string; name: string; filter: string; days?: string; stage?: boolean }[];

export const eventFor = (id: string) => EVENTS.find((event) => event.id === id);

const newAction = (type: string) => ({ type, subject: '', message: '', due_days: 1, to: type === 'assign' ? '' : 'owner' });

const STARTERS = [
  { name: 'New web form lead', event: 'lead_created', source: 'Web form', actions: [{ ...newAction('alert'), message: 'New web form lead: {name}' }, { ...newAction('task'), subject: 'Call {name}' }] },
  { name: 'Hot lead alert', event: 'lead_hot', actions: [{ ...newAction('alert'), message: '{name} is now a Hot lead' }] },
  { name: 'Quiet deal', event: 'deal_idle', days: 14, actions: [{ ...newAction('task'), subject: 'Check in on {name}', due_days: 0 }] },
  { name: 'Deal closing soon', event: 'deal_closing', days: 7, actions: [{ ...newAction('alert'), message: '{name} is due to close soon' }] },
  { name: 'Quote expiring', event: 'quote_expiring', days: 3, actions: [{ ...newAction('task'), subject: 'Follow up on quote {name}', due_days: 0 }] },
  { name: 'Deal won', event: 'deal_won', actions: [{ ...newAction('alert'), message: '{name} was won', to: 'managers' }] }
];

export const blankRule = { name: '', event: 'lead_created', stage_id: '', days: 7, source: '', min_value: '', actions: [newAction('task')] };

export function Starters({ onChoose }: { onChoose: (rule: any) => void }) {
  return (
    <div className="starters">
      {STARTERS.map((starter) => (
        <button key={starter.name} onClick={() => onChoose({ ...blankRule, ...starter })}>{starter.name}</button>
      ))}
    </div>
  );
}

export default function AutomationForm({ initial, onClose, onSaved }: { initial: any; onClose: () => void; onSaved: () => void }) {
  const members = useTeam();
  const workers = members.filter(({ role }) => role !== 'viewer');
  const [rule, setRule] = useState<any>({
    ...initial,
    stage_id: initial.stage_id || '',
    days: initial.days ?? 7,
    source: initial.source || '',
    min_value: initial.min_value ?? '',
    actions: initial.actions.map((action: any) => ({ ...newAction(action.type), ...action }))
  });
  const [pipelines, setPipelines] = useState<any[]>([]);
  const [error, setError] = useState('');
  const event = eventFor(rule.event);
  const set = (field: string, value: unknown) => setRule({ ...rule, [field]: value });

  useEffect(() => {
    api.get('/api/crm/pipelines').then(setPipelines).catch(() => setPipelines([]));
  }, []);

  const setAction = (index: number, field: string, value: unknown) =>
    set('actions', rule.actions.map((action: any, i: number) => {
      if (i !== index) return action;
      return field === 'type' ? newAction(value as string) : { ...action, [field]: value };
    }));

  const submit = async (submitted: FormEvent) => {
    submitted.preventDefault();
    try {
      await api.post('/api/crm/automations', rule);
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title={rule.id ? `Edit ${rule.name}` : 'New rule'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Name<input required maxLength={80} value={rule.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label>When
            <select value={rule.event} onChange={(e) => set('event', e.target.value)}>
              {EVENTS.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
          {event?.stage && (
            <label>Stage
              <select required value={rule.stage_id} onChange={(e) => set('stage_id', e.target.value)}>
                <option value="">Choose a stage</option>
                {pipelines.map((pipeline) => (
                  <optgroup key={pipeline.id} label={pipeline.name}>
                    {pipeline.stages.map((stage: any) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
          )}
          {event?.days && <label>{event.days}<input required type="number" min="1" max="365" value={rule.days} onChange={(e) => set('days', e.target.value)} /></label>}
          {event?.filter === 'source' && <label>Only from this source<input maxLength={100} placeholder="Any source" value={rule.source} onChange={(e) => set('source', e.target.value)} /></label>}
          {event?.filter === 'value' && <label>Only if the value is at least<input type="number" min="0" step="0.01" placeholder="Any value" value={rule.min_value} onChange={(e) => set('min_value', e.target.value)} /></label>}
        </div>
        {event?.days && <p className="muted">This is checked every hour. It also applies to records that already match, once each.</p>}

        <h2 style={{ marginTop: 16 }}>Then</h2>
        <p className="muted">Write {'{name}'} to put in the name of the lead, deal or quote.</p>
        {rule.actions.map((action: any, index: number) => (
          <div className="rule-action" key={index}>
            <label>Do this
              <select value={action.type} onChange={(e) => setAction(index, 'type', e.target.value)}>
                <option value="task">Create a task</option>
                <option value="alert">Send an alert</option>
                {rule.event !== 'quote_expiring' && <option value="assign">Assign it to</option>}
              </select>
            </label>
            {action.type === 'task' && <label>Task<input required maxLength={200} value={action.subject} onChange={(e) => setAction(index, 'subject', e.target.value)} /></label>}
            {action.type === 'task' && <label>Due in days<input required type="number" min="0" max="365" value={action.due_days} onChange={(e) => setAction(index, 'due_days', e.target.value)} /></label>}
            {action.type === 'alert' && <label>Message<input required maxLength={200} value={action.message} onChange={(e) => setAction(index, 'message', e.target.value)} /></label>}
            <label>{action.type === 'assign' ? 'Person' : 'For'}
              <select required value={action.to} onChange={(e) => setAction(index, 'to', e.target.value)}>
                {action.type === 'assign' && <option value="">Choose a person</option>}
                {action.type !== 'assign' && <option value="owner">Whoever owns it</option>}
                {action.type === 'alert' && <option value="managers">Owners and admins</option>}
                {(action.type === 'alert' ? members : workers).map((member) => <option key={member.user_id} value={member.user_id}>{member.email}</option>)}
              </select>
            </label>
            <div className="row-actions">
              <button type="button" aria-label="Remove action" disabled={rule.actions.length === 1} onClick={() => set('actions', rule.actions.filter((_: any, i: number) => i !== index))}>×</button>
            </div>
          </div>
        ))}
        {rule.actions.length < 5 && <div><button type="button" onClick={() => set('actions', [...rule.actions, newAction('task')])}>Add action</button></div>}

        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary">Save rule</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
