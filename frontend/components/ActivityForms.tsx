import { FormEvent, useState } from 'react';
import { OwnerField, useTeam } from '@/components/CrmForms';
import Modal from '@/components/Modal';
import { api, formatDate, today } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

// Activities that can be planned for a date
export const PLANNED_KINDS = [
  { id: 'call', name: 'Call' },
  { id: 'meeting', name: 'Meeting' },
  { id: 'email', name: 'Email' },
  { id: 'task', name: 'To-do' }
];

export const kindName = (kind: string) =>
  PLANNED_KINDS.find(({ id }) => id === kind)?.name || (kind === 'note' ? 'Note' : kind);

// Overdue, today or later, the same way everywhere
export const dueState = (activity: { due_on?: string | null; done_at?: string | null }) => {
  if (activity.done_at) return 'done';
  if (!activity.due_on) return 'later';
  const now = today();
  if (activity.due_on < now) return 'overdue';
  if (activity.due_on === now) return 'today';
  return 'later';
};

export const dueText = (activity: { due_on?: string | null; due_time?: string | null }) =>
  activity.due_on ? `${formatDate(activity.due_on)}${activity.due_time ? ` ${activity.due_time.slice(0, 5)}` : ''}` : 'No date';

export function NextActivity({ activity, empty = 'Nothing planned' }: { activity: any; empty?: string }) {
  if (!activity) return <span className="next-activity none">{empty}</span>;
  const state = dueState(activity);
  return (
    <span className={`next-activity ${state}`} title={state === 'overdue' ? 'Overdue' : state === 'today' ? 'Due today' : 'Planned'}>
      {kindName(activity.kind)}: {activity.subject} · {dueText(activity)}
    </span>
  );
}

type NextStep = { kind: string; subject: string; due_on: string; due_time: string; owner_id: string };

function NextStepFields({ value, onChange, members, emptyOwner }: { value: NextStep; onChange: (value: NextStep) => void; members: any[]; emptyOwner: string }) {
  const set = (field: keyof NextStep, text: string) => onChange({ ...value, [field]: text });
  return (
    <div className="form-grid">
      <label>Type
        <select value={value.kind} onChange={(e) => set('kind', e.target.value)}>
          {PLANNED_KINDS.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>
      <label>What<input required maxLength={200} value={value.subject} onChange={(e) => set('subject', e.target.value)} /></label>
      <label>Date<input type="date" required value={value.due_on} onChange={(e) => set('due_on', e.target.value)} /></label>
      <label>Time (optional)<input type="time" value={value.due_time} onChange={(e) => set('due_time', e.target.value)} /></label>
      <OwnerField value={value.owner_id} members={members} onChange={(owner) => set('owner_id', owner)} empty={emptyOwner} />
    </div>
  );
}

const blankStep = (kind = 'call'): NextStep => ({ kind, subject: '', due_on: today(), due_time: '', owner_id: '' });

// Tick an activity off with no notes, the same as "Mark done" with the form left empty
export const finishActivity = (id: string) => api.post(`/api/crm/activities/${id}/finish`, { feedback: '', next: null });

// Undo a tick: the activity is open again
export const reopenActivity = (id: string) => api.put(`/api/crm/activities/${id}/done`, { done: false });

// Mark done, say how it went, and plan what comes next on the same record
export function FinishForm({ activity, onClose, onSaved }: { activity: any; onClose: () => void; onSaved: () => void }) {
  const members = useTeam();
  const [feedback, setFeedback] = useState('');
  const [planNext, setPlanNext] = useState(false);
  const [next, setNext] = useState<NextStep>(blankStep());
  const [error, setError] = useState('');
  const linked = activity.deal_id || activity.lead_id || activity.contact_id || activity.company_id;

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api.post(`/api/crm/activities/${activity.id}/finish`, { feedback, next: planNext ? next : null });
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title={`Done: ${activity.subject}`} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <label>How did it go? (optional)<textarea rows={3} maxLength={4000} value={feedback} onChange={(e) => setFeedback(e.target.value)} /></label>
        {linked && (
          <label className="check"><input type="checkbox" checked={planNext} onChange={(e) => setPlanNext(e.target.checked)} />Plan the next step</label>
        )}
        {planNext && <NextStepFields value={next} onChange={setNext} members={members} emptyOwner="Same person" />}
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">Mark done</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

// Plan a call, meeting, email or to-do on a record (or on its own)
export function PlanForm({ links = {}, kind = 'call', onClose, onSaved }: { links?: Record<string, string | undefined>; kind?: string; onClose: () => void; onSaved: () => void }) {
  const members = useTeam();
  const [step, setStep] = useState<NextStep>(blankStep(kind));
  const [body, setBody] = useState('');
  const [error, setError] = useState('');

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api.post('/api/crm/activities', { ...links, ...step, body });
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title={kind === 'task' ? 'Add a task' : 'Plan an activity'} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <NextStepFields value={step} onChange={setStep} members={members} emptyOwner="Me" />
        <label>Details (optional)<textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">Plan it</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

const LOGGED_KINDS = [
  { id: 'note', name: 'Note' },
  { id: 'call', name: 'Call' },
  { id: 'meeting', name: 'Meeting' },
  { id: 'email', name: 'Email' }
];

// Log something that already happened (a call, a meeting, a note) on a record.
// Posts the same thing the timeline does when it logs an activity as done now.
export function LogForm({ links, onClose, onSaved }: { links: Record<string, string | undefined>; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState('call');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api.post('/api/crm/activities', { ...links, kind, subject, body, due_on: '', due_time: '' });
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title="Log an activity" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <div className="tabs" role="group" aria-label="Type">
          {LOGGED_KINDS.map(({ id, name }) => (
            <button type="button" key={id} className={kind === id ? 'active' : ''} onClick={() => setKind(id)}>{name}</button>
          ))}
        </div>
        <label>Subject<input required maxLength={200} autoFocus value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
        <label>Details (optional)<textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">{busy ? 'Saving…' : 'Log it'}</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
