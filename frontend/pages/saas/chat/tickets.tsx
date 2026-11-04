import Link from 'next/link';
import { useRouter } from 'next/router';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import AppShell from '@/components/AppShell';
import { celebrate } from '@/components/Celebrate';
import ChatNav, { PRIORITY, TICKET_STATUS, TICKET_STATUS_STYLES, dueText, timeText } from '@/components/ChatNav';
import EmptyState from '@/components/EmptyState';
import Icon from '@/components/Icon';
import Modal from '@/components/Modal';
import Skeleton from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api, isUuid } from '@/lib/api';
import c from '@/styles/chat.module.css';

export default function ChatTickets() {
  return <AppShell><Tickets /></AppShell>;
}

// Requests to deal with: from a chat, or typed in by the team. Each has a number, a status, a
// priority, a person looking after it and a due time from the response targets in Settings.

const FILTERS = [
  { key: 'open', label: 'Open' },
  { key: 'new', label: 'New' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'solved', label: 'Solved' },
  { key: 'all', label: 'All' }
];

const blank = { subject: '', description: '', priority: 'normal', assigned_to: '', customer_name: '', customer_email: '', contact_id: '' };


function Tickets() {
  const router = useRouter();
  const [overview, setOverview] = useState<any>(null);
  const [team, setTeam] = useState<any[]>([]);
  const [filter, setFilter] = useState('open');
  const [mine, setMine] = useState(false);
  const [overdue, setOverdue] = useState(false);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const solving = useRef(false);
  const selected = isUuid(router.query.t) ? router.query.t : '';

  useEffect(() => {
    if (router.query.overdue === '1') setOverdue(true);
  }, [router.query.overdue]);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    api.get('/api/chatbot/team').then(setTeam).catch(() => setTeam([]));
  }, []);

  const load = useCallback(async () => {
    try {
      const summary = await api.get('/api/chatbot/overview');
      const params = new URLSearchParams({ status: filter });
      if (mine && summary.me) {
        params.set('mine', '1');
        params.set('me', summary.me);
      }
      if (overdue) params.set('overdue', '1');
      if (query) params.set('q', query);
      setList(await api.get(`/api/chatbot/tickets?${params}`));
      setOverview(summary);
      setError('');
      // The last open ticket was just solved: a real win
      if (solving.current) {
        solving.current = false;
        if (Number(summary.tickets_open) === 0) {
          celebrate();
          toast.success('Every ticket is solved', { detail: 'Nothing left open. Time is yours again.' });
        }
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [filter, mine, overdue, query]);

  useEffect(() => {
    load();
  }, [load]);

  const open = (id: string) => router.replace({ pathname: '/saas/chat/tickets', query: { t: id } }, undefined, { shallow: true });
  const personName = (userId: string | null) => (userId ? team.find((person) => person.id === userId)?.email || 'Someone who left' : 'Nobody yet');
  const canEdit = Boolean(overview?.can_reply);
  const allClear = !loading && filter === 'open' && !mine && !overdue && !query && list.length === 0;

  return (
    <div className="stack">
      <ChatNav />
      <div className="page-head">
        <div>
          <h1>Tickets</h1>
          <p className="muted">Requests to follow through on, from chats or added by the team.</p>
        </div>
        {canEdit && <button className="primary" onClick={() => setAdding(true)}><Icon name="plus" size={16} />New ticket</button>}
      </div>
      {error && <p className="error">{error}</p>}
      {overview ? (
        <div className={c.statRow}>
          <div className="card"><div className="stat-label">Open</div><div className="stat-value">{overview.tickets_open}</div></div>
          <div className="card"><div className="stat-label">Late</div><div className="stat-value" style={Number(overview.tickets_overdue) > 0 ? { color: 'var(--danger)' } : undefined}>{overview.tickets_overdue}</div></div>
          <div className="card"><div className="stat-label">Given to me</div><div className="stat-value">{overview.tickets_mine}</div></div>
        </div>
      ) : !error && (
        <div className={c.statRow} aria-hidden="true">
          {[0, 1, 2].map((n) => <div className="card" key={n}><Skeleton width="50%" height={11} /><Skeleton width="30%" height={20} style={{ marginTop: 8 }} /></div>)}
        </div>
      )}

      <div className={`${c.inbox} ${c.noSide} ${selected ? c.picked : ''}`}>
        <div className={c.list}>
          <div className={c.listHead}>
            <select aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value)}>
              {FILTERS.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
            </select>
            <div className={c.search}>
              <Icon name="search" size={16} />
              <input type="search" aria-label="Search tickets" placeholder="Search number, subject, name or email" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <label className="check"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only tickets given to me</label>
            <label className="check"><input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} /> Only late tickets</label>
          </div>
          <div className={c.items}>
            {loading && [0, 1, 2, 3].map((n) => (
              <div key={n} className={c.item} style={{ gridTemplateColumns: '1fr' }} aria-hidden="true">
                <span className={c.itemBody}><Skeleton width="70%" height={13} /><Skeleton width="45%" height={11} style={{ marginTop: 6 }} /></span>
              </div>
            ))}
            {allClear && (
              <EmptyState tone="done" compact icon="inbox" title="No open tickets"
                line="Everything is solved. Time is yours again." action={{ label: 'Back to the inbox', href: '/saas/chat' }} />
            )}
            {!loading && !allClear && list.length === 0 && (
              <EmptyState compact icon="invoice" title="No tickets here" line={query ? 'Try a different number, subject or name.' : 'Try another filter.'} />
            )}
            {list.map((ticket) => {
              const due = dueText(ticket.due_at, ticket.status);
              const late = due.endsWith('late') && ticket.status !== 'waiting';
              return (
                <button key={ticket.id} className={`${c.item} ${ticket.id === selected ? c.active : ''}`} style={{ gridTemplateColumns: '1fr' }}
                  aria-current={ticket.id === selected ? 'true' : undefined} onClick={() => open(ticket.id)}>
                  <span className={c.itemBody}>
                    <span className={c.itemTop}>
                      <strong>#{ticket.number} {ticket.subject}</strong>
                      {due && <small className={late ? c.late : ''}>{due}</small>}
                    </span>
                    <span className={c.itemText}>{ticket.customer_name || ticket.customer_email || personName(ticket.assigned_to)}</span>
                    <span className={c.itemFoot}>
                      <span className={`badge ${TICKET_STATUS_STYLES[ticket.status]}`}>{TICKET_STATUS[ticket.status]}</span>
                      <small>{PRIORITY[ticket.priority]} priority</small>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        {selected
          ? <TicketView key={selected} id={selected} team={team} overview={overview} personName={personName} onChanged={load}
              onSolved={() => { solving.current = true; }}
              onBack={() => router.replace('/saas/chat/tickets', undefined, { shallow: true })}
              onGone={() => { router.replace('/saas/chat/tickets', undefined, { shallow: true }); load(); }} />
          : <div className={c.placeholder}><EmptyState icon="invoice" title="Pick a ticket" line="Choose one on the left to see its details and log." /></div>}
      </div>

      {adding && (
        <TicketForm team={team} title="New ticket" start={blank} onClose={() => setAdding(false)}
          onSave={async (data) => {
            const made = await api.post('/api/chatbot/tickets', data);
            setAdding(false);
            await load();
            open(made.id);
            toast.success(made.number ? `Ticket #${made.number} made` : 'Ticket made');
          }} />
      )}
    </div>
  );
}

function TicketForm({ team, title, start, onClose, onSave }: {
  team: any[]; title: string; start: any; onClose: () => void; onSave: (data: any) => Promise<void>;
}) {
  const [form, setForm] = useState({ ...blank, ...start });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm({ ...form, [field]: value });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSave({ ...form, assigned_to: form.assigned_to || null, contact_id: form.contact_id || null });
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Subject<input required maxLength={200} value={form.subject} onChange={(e) => set('subject', e.target.value)} /></label>
          <label>Priority
            <select value={form.priority} onChange={(e) => set('priority', e.target.value)}>
              {Object.entries(PRIORITY).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          <label>Looked after by
            <select value={form.assigned_to || ''} onChange={(e) => set('assigned_to', e.target.value)}>
              <option value="">Nobody yet</option>
              {team.map((person) => <option key={person.id} value={person.id}>{person.email}</option>)}
            </select>
          </label>
          <label>Customer name<input maxLength={100} value={form.customer_name || ''} onChange={(e) => set('customer_name', e.target.value)} /></label>
          <label>Customer email<input type="email" maxLength={254} value={form.customer_email || ''} onChange={(e) => set('customer_email', e.target.value)} /></label>
        </div>
        <label>What's needed<textarea rows={6} maxLength={4000} value={form.description || ''} onChange={(e) => set('description', e.target.value)} /></label>
        <p className="muted">The due time comes from the response targets for each priority in Chat settings.</p>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function TicketView({ id, team, overview, personName, onChanged, onGone, onSolved, onBack }: {
  id: string; team: any[]; overview: any; personName: (id: string | null) => string; onChanged: () => void; onGone: () => void;
  onSolved: () => void; onBack: () => void;
}) {
  const [ticket, setTicket] = useState<any>(null);
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canEdit = Boolean(overview?.can_reply);

  const load = useCallback(async () => {
    try {
      setTicket(await api.get(`/api/chatbot/tickets/${id}`));
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (work: () => Promise<any>, done?: string) => {
    setBusy(true);
    setError('');
    try {
      await work();
      await load();
      onChanged();
      if (done) toast.success(done);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const addNote = (event: FormEvent) => {
    event.preventDefault();
    if (!note.trim()) return;
    act(async () => {
      await api.post(`/api/chatbot/tickets/${id}/notes`, { body: note.trim() });
      setNote('');
    });
  };

  const remove = () => {
    if (!window.confirm(`Delete ticket #${ticket.number}? Its notes go too. This can't be undone.`)) return;
    act(async () => {
      await api.delete(`/api/chatbot/tickets/${id}`);
      onGone();
    }, `Ticket #${ticket.number} deleted`);
  };

  const setStatus = (status: string) => {
    if (status === 'solved') onSolved();
    act(() => api.post(`/api/chatbot/tickets/${id}/status`, { status }), status === 'solved' ? `Ticket #${ticket.number} solved` : 'Status changed');
  };

  if (!ticket) {
    return (
      <div className={c.thread}>
        {error ? <div style={{ padding: 16 }}><p className="error">{error}</p></div> : (
          <div className={c.messages} aria-busy="true" aria-label="Loading ticket">
            <Skeleton width="60%" height={20} /><Skeleton width="40%" height={12} /><Skeleton height={80} radius={12} />
          </div>
        )}
      </div>
    );
  }
  const due = dueText(ticket.due_at, ticket.status);
  const late = due.endsWith('late') && ticket.status !== 'waiting';

  return (
    <section className={c.thread} aria-label={`Ticket ${ticket.number}`}>
      <header className={c.threadHead}>
        <div className={c.threadTitle}>
          <button type="button" className={`icon-button ${c.back}`} aria-label="Back to tickets" onClick={onBack}><Icon name="chevron-left" size={18} /></button>
          <div style={{ minWidth: 0 }}>
            <h2>#{ticket.number} {ticket.subject} <span className={`badge ${TICKET_STATUS_STYLES[ticket.status]}`}>{TICKET_STATUS[ticket.status]}</span></h2>
            <p>
              {PRIORITY[ticket.priority]} priority · looked after by {personName(ticket.assigned_to)}
              {due && <> · <span className={late ? c.late : ''}>{due}</span></>}
              {ticket.solved_at && <> · solved {timeText(ticket.solved_at)}</>}
            </p>
            <p>
              {ticket.customer_name || ticket.customer_email ? `${ticket.customer_name || ''} ${ticket.customer_email ? `<${ticket.customer_email}>` : ''}` : 'No customer details'}
              {ticket.contact && <> · <Link href={`/saas/crm/contact/${ticket.contact.id}`}>{ticket.contact.name}</Link></>}
              {ticket.conversation_id && <> · <Link href={`/saas/chat?c=${ticket.conversation_id}`}>Open the chat</Link></>}
            </p>
          </div>
        </div>
        {canEdit && (
          <div className={c.threadActions}>
            <select aria-label="Status" value={ticket.status} disabled={busy} style={{ width: 'auto' }}
              onChange={(e) => setStatus(e.target.value)}>
              {Object.entries(TICKET_STATUS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            {ticket.status !== 'solved' && <button className="small" disabled={busy} onClick={() => setStatus('solved')}><Icon name="check" size={14} />Solve</button>}
            <button className="small" disabled={busy} onClick={() => setEditing(true)}>Edit</button>
            {overview?.is_manager && <button className="small ghost danger" disabled={busy} onClick={remove}>Delete</button>}
          </div>
        )}
      </header>

      <div className={c.messages}>
        {ticket.description && (
          <div className={c.bubble} style={{ alignSelf: 'stretch' }}>
            <span className={c.meta}>What&apos;s needed</span>
            <div className={c.body}>{ticket.description}</div>
          </div>
        )}
        {ticket.notes.length === 0 && <p className={c.system}>No notes yet</p>}
        {ticket.notes.map((row: any) => (
          row.kind === 'change'
            ? <p key={row.id} className={c.system}>{row.body} · {personName(row.author_id)} · {timeText(row.created_at)}</p>
            : (
              <div key={row.id} className={c.row}>
                <span className={`${c.avatar} ${c.small}`} aria-hidden="true">{(personName(row.author_id) || '?').charAt(0).toUpperCase()}</span>
                <div className={c.bubble}>
                  <span className={c.meta}>{personName(row.author_id)} · {timeText(row.created_at)}</span>
                  <div className={c.body}>{row.body}</div>
                </div>
              </div>
            )
        ))}
      </div>
      {error && <div className={c.threadNotes}><p className="error">{error}</p></div>}
      {canEdit ? (
        <form className={c.composer} onSubmit={addNote}>
          <textarea rows={2} maxLength={2000} placeholder="Add a note for the team" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
          <div className={c.composerFoot}><span>Notes are only seen by your team.</span><button className="primary always" disabled={busy || !note.trim()}>Add note</button></div>
        </form>
      ) : <p className="muted small" style={{ padding: '10px 16px', margin: 0, borderTop: '1px solid var(--border)' }}>Your role can read tickets but not change them.</p>}

      {editing && (
        <TicketForm team={team} title={`Edit ticket #${ticket.number}`} start={ticket} onClose={() => setEditing(false)}
          onSave={async (data) => {
            await api.put(`/api/chatbot/tickets/${id}`, data);
            setEditing(false);
            await load();
            onChanged();
            toast.success('Ticket saved');
          }} />
      )}
    </section>
  );
}
