import { FormEvent, Fragment, ReactNode, useEffect, useState } from 'react';
import { FinishForm, dueState, dueText, kindName } from '@/components/ActivityForms';
import { CrmIcon, kindIcon } from '@/components/CrmRecord';
import EmailForm from '@/components/EmailForm';
import EmptyState from '@/components/EmptyState';
import Icon from '@/components/Icon';
import Skeleton from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { CRM_SAVED, api, formatDate, today } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';
import styles from '@/styles/crm.module.css';

const KINDS = [
  { id: 'note', name: 'Note' },
  { id: 'call', name: 'Call' },
  { id: 'meeting', name: 'Meeting' },
  { id: 'email', name: 'Email' },
  { id: 'task', name: 'Task' }
];

type Links = { contact_id?: string; company_id?: string; deal_id?: string; lead_id?: string };

// Extra rows from the page (a deal's stage moves, say), drawn in the same feed
export type TimelineExtra = { id: string; at: string; content: ReactNode; icon?: string; tone?: 'toneAccent' | 'toneGood' | 'toneWarn' | 'toneDanger' };

const when = (at: string) => {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return formatDate(at);
  return `${formatDate(at)} at ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
};

export default function Timeline({ links, extra = [], onChange }: { links: Links; extra?: TimelineExtra[]; onChange?: () => void }) {
  const [items, setItems] = useState<any[] | null>(null);
  const [form, setForm] = useState({ kind: 'note', subject: '', body: '', due_on: '', due_time: '', later: false });
  const [finishing, setFinishing] = useState<any>(null);
  const [error, setError] = useState('');
  const [emailing, setEmailing] = useState(false);
  const query = new URLSearchParams(links as Record<string, string>).toString();

  const load = async () => {
    try {
      setItems(await api.get(`/api/crm/activities?${query}`));
      setError('');
    } catch (err: any) {
      setItems((current) => current || []);
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
    // Any CRM save reloads the list, which also shows tasks automation just made
    window.addEventListener(CRM_SAVED, load);
    return () => window.removeEventListener(CRM_SAVED, load);
  }, [query]);

  const plan = form.kind === 'task' || (form.later && form.kind !== 'note');

  const { busy, run: once } = useSubmit();
  const add = async (event: FormEvent) => {
    event.preventDefault();
    return once(async () => {
      try {
        // A call, meeting or email can be planned for a date; otherwise it is logged as done now
        const planned = form.kind === 'task' || (form.later && form.kind !== 'note');
        const { later, ...fields } = form;
        await api.post('/api/crm/activities', {
          ...links,
          ...fields,
          due_on: planned ? form.due_on || today() : '',
          due_time: planned ? form.due_time : ''
        });
        setForm({ ...form, subject: '', body: '', due_on: '', due_time: '', later: false });
        setError('');
        toast.success(planned ? (form.kind === 'task' ? 'Task added' : 'Planned') : form.kind === 'note' ? 'Note added' : 'Logged');
        onChange?.();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  const run = async (action: () => Promise<unknown>, done?: string) => {
    try {
      await action();
      if (done) toast.success(done);
      onChange?.();
    } catch (err: any) {
      toast.error('Could not save', { detail: err.message });
    }
  };

  const reopen = (item: any) => run(() => api.put(`/api/crm/activities/${item.id}/done`, { done: false }), 'Opened again');

  const entries = [
    ...(items || []).map((item) => ({ id: item.id, at: item.created_at, node: <Entry item={item} run={run} onFinish={setFinishing} onReopen={reopen} /> })),
    ...extra.map((row) => ({
      id: row.id,
      at: row.at,
      node: (
        <li className={styles.feedItem}>
          <span className={`${styles.feedIcon} ${styles[row.tone || 'toneWarn']}`} aria-hidden="true"><CrmIcon name={row.icon || 'stage'} size={15} /></span>
          <div className={styles.feedBody}>
            <div className={styles.feedTitle}>{row.content}</div>
            <time className={styles.feedTime} dateTime={row.at}>{when(row.at)}</time>
          </div>
          <span />
        </li>
      )
    }))
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));

  return (
    <section className="card" aria-labelledby="timeline-title">
      <div className={styles.cardHead}>
        <div>
          <h2 id="timeline-title">Activity</h2>
          <p className="muted">Notes, calls, meetings and emails, newest first.</p>
        </div>
        {(links.contact_id || links.lead_id || links.deal_id) && <button onClick={() => setEmailing(true)}><CrmIcon name="mail" />Send email</button>}
      </div>

      <form onSubmit={add} className={styles.composer}>
        <div className={styles.composerKinds} role="group" aria-label="What to add">
          {KINDS.map(({ id, name }) => (
            <button type="button" key={id} aria-pressed={form.kind === id} className={`${styles.kindPill} ${form.kind === id ? styles.active : ''}`} onClick={() => setForm({ ...form, kind: id })}>
              <CrmIcon name={kindIcon(id)} size={14} />{name}
            </button>
          ))}
        </div>
        <div className="form-grid">
          <label>{form.kind === 'task' ? 'What needs doing' : 'Subject'}<input required value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></label>
          {plan && (
            <>
              <label>{form.kind === 'task' ? 'Due' : 'When'}<input type="date" value={form.due_on || today()} onChange={(e) => setForm({ ...form, due_on: e.target.value })} /></label>
              <label>Time (optional)<input type="time" value={form.due_time} onChange={(e) => setForm({ ...form, due_time: e.target.value })} /></label>
            </>
          )}
        </div>
        {['call', 'meeting', 'email'].includes(form.kind) && (
          <label className="check">
            <input type="checkbox" checked={form.later} onChange={(e) => setForm({ ...form, later: e.target.checked })} />Plan this for later instead of logging it as done
          </label>
        )}
        {form.kind !== 'task' && (
          <label>Details<textarea rows={2} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></label>
        )}
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">
            {busy ? 'Saving…' : plan ? (form.kind === 'task' ? 'Add task' : 'Plan it') : form.kind === 'note' ? 'Add note' : 'Log it'}
          </button>
        </div>
      </form>

      {items === null ? (
        <ul className={styles.feed} aria-busy="true">
          {[0, 1, 2].map((n) => (
            <li className={styles.feedItem} key={n}>
              <Skeleton width={32} height={32} radius={999} />
              <div className={styles.feedBody}><Skeleton width="50%" height={13} /><Skeleton width="25%" height={10} style={{ marginTop: 6 }} /></div>
              <span />
            </li>
          ))}
        </ul>
      ) : entries.length === 0 ? (
        <EmptyState compact icon="clock" title="Nothing logged yet" line="Log a call, a meeting or a quick note and it shows up here." />
      ) : (
        <ol className={styles.feed}>
          {entries.map(({ id, node }) => <Fragment key={id}>{node}</Fragment>)}
        </ol>
      )}

      {finishing && (
        <FinishForm activity={finishing} onClose={() => setFinishing(null)} onSaved={() => {
          const item = finishing;
          toast.success('Done', { detail: item.subject, action: { label: 'Undo', onClick: () => reopen(item) } });
          onChange?.();
        }} />
      )}
      {emailing && <EmailForm links={{ contact_id: links.contact_id, lead_id: links.lead_id, deal_id: links.deal_id }} onClose={() => setEmailing(false)} />}
    </section>
  );
}

function Entry({ item, run, onFinish, onReopen }: {
  item: any; run: (action: () => Promise<unknown>, done?: string) => void; onFinish: (item: any) => void; onReopen: (item: any) => void;
}) {
  const task = item.kind === 'task';
  const open = !item.done_at && item.kind !== 'note';
  const late = open && dueState(item) === 'overdue';
  const planned = open && !task;
  const tone = late ? styles.toneDanger : open ? styles.toneAccent : item.kind === 'note' ? '' : styles.toneGood;
  const label = task
    ? (item.done_at ? 'Task done' : late ? 'Task overdue' : 'Task')
    : late ? `${kindName(item.kind)} overdue` : planned ? `Planned ${kindName(item.kind).toLowerCase()}` : kindName(item.kind);

  return (
    <li className={styles.feedItem}>
      <span className={`${styles.feedIcon} ${tone}`} aria-hidden="true"><CrmIcon name={kindIcon(item.kind)} size={15} /></span>
      <div className={styles.feedBody}>
        <div className={styles.feedTitle}>
          <strong>{item.subject}</strong>
          <span className={`badge ${late ? 'lost' : planned ? 'sent' : ''}`}>{label}</span>
          {item.automation_id && <span className="chip">automated</span>}
        </div>
        {(task || planned) && item.due_on && <span className={late ? 'late small' : 'muted small'}>{open ? 'Due' : 'Was due'} {dueText(item)}</span>}
        {item.body && <div className={styles.feedNote}>{item.body}</div>}
        <time className={styles.feedTime} dateTime={item.created_at}>{when(item.created_at)}</time>
      </div>
      <div className={styles.feedActions}>
        {open && <button className="small" onClick={() => onFinish(item)}><Icon name="check" size={14} />Done</button>}
        {item.done_at && item.due_on && item.kind !== 'note' && <button className="small ghost" onClick={() => onReopen(item)}>Reopen</button>}
        <button className="ghost icon-button" aria-label={`Delete ${item.subject}`} title="Delete"
          onClick={() => window.confirm('Delete this entry?') && run(() => api.delete(`/api/crm/activities/${item.id}`), 'Deleted')}>
          <Icon name="x" size={14} />
        </button>
      </div>
    </li>
  );
}
