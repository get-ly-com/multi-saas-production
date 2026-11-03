import Link from 'next/link';
import { useRouter } from 'next/router';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import ChatNav, { PRIORITY, TICKET_STATUS, TICKET_STATUS_STYLES, dueText, timeText } from '@/components/ChatNav';
import Modal from '@/components/Modal';
import { api } from '@/lib/api';

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
  const selected = typeof router.query.t === 'string' ? router.query.t : '';

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

  return (
    <div className="stack">
      <ChatNav />
      <div className="page-head">
        <h1>Tickets</h1>
        {canEdit && <button className="primary" onClick={() => setAdding(true)}>New ticket</button>}
      </div>
      {error && <p className="error">{error}</p>}
      {overview && (
        <div className="stats">
          <div className="card"><div className="stat-label">Open</div><div className="stat-value">{overview.tickets_open}</div></div>
          <div className="card"><div className="stat-label">Late</div><div className="stat-value">{overview.tickets_overdue}</div></div>
          <div className="card"><div className="stat-label">Given to me</div><div className="stat-value">{overview.tickets_mine}</div></div>
        </div>
      )}

      <div className="chat-inbox">
        <div className="card chat-list">
          <select aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value)}>
            {FILTERS.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
          </select>
          <input aria-label="Search tickets" placeholder="Search number, subject, name or email" value={search} onChange={(e) => setSearch(e.target.value)} />
          <label className="check"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only tickets given to me</label>
          <label className="check"><input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} /> Only late tickets</label>
          {loading && <p className="empty">Loading…</p>}
          {!loading && list.length === 0 && <p className="empty">No tickets here</p>}
          {list.map((ticket) => {
            const due = dueText(ticket.due_at, ticket.status);
            return (
              <button key={ticket.id} className={`chat-item ${ticket.id === selected ? 'active' : ''}`} onClick={() => open(ticket.id)}>
                <span className="chat-item-head">
                  <strong>#{ticket.number} {ticket.subject}</strong>
                </span>
                <span className="chat-item-head">
                  <small>{TICKET_STATUS[ticket.status]} · {PRIORITY[ticket.priority]}</small>
                  {due && <small className={due.endsWith('late') && ticket.status !== 'waiting' ? 'error' : ''}>{due}</small>}
                </span>
                <span className="chat-item-text">{ticket.customer_name || ticket.customer_email || personName(ticket.assigned_to)}</span>
              </button>
            );
          })}
        </div>
        {selected
          ? <TicketView key={selected} id={selected} team={team} overview={overview} personName={personName} onChanged={load}
              onGone={() => { router.replace('/saas/chat/tickets', undefined, { shallow: true }); load(); }} />
          : <div className="card chat-thread"><p className="empty">Choose a ticket to see it</p></div>}
      </div>

      {adding && (
        <TicketForm team={team} title="New ticket" start={blank} onClose={() => setAdding(false)}
          onSave={async (data) => {
            const made = await api.post('/api/chatbot/tickets', data);
            setAdding(false);
            await load();
            open(made.id);
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
    <Modal title={title}>
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

function TicketView({ id, team, overview, personName, onChanged, onGone }: {
  id: string; team: any[]; overview: any; personName: (id: string | null) => string; onChanged: () => void; onGone: () => void;
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

  const act = async (work: () => Promise<any>) => {
    setBusy(true);
    setError('');
    try {
      await work();
      await load();
      onChanged();
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
    });
  };

  if (!ticket) return <div className="card chat-thread">{error ? <p className="error">{error}</p> : <p className="empty">Loading…</p>}</div>;
  const due = dueText(ticket.due_at, ticket.status);

  return (
    <div className="card chat-thread">
      <div className="chat-thread-head">
        <div>
          <h2>#{ticket.number} {ticket.subject} <span className={`badge ${TICKET_STATUS_STYLES[ticket.status]}`}>{TICKET_STATUS[ticket.status]}</span></h2>
          <div className="muted">
            {PRIORITY[ticket.priority]} priority · looked after by {personName(ticket.assigned_to)}
            {due && <> · <span className={due.endsWith('late') && ticket.status !== 'waiting' ? 'error' : ''}>{due}</span></>}
            {ticket.solved_at && <> · solved {timeText(ticket.solved_at)}</>}
          </div>
          <div className="muted">
            {ticket.customer_name || ticket.customer_email ? `${ticket.customer_name || ''} ${ticket.customer_email ? `<${ticket.customer_email}>` : ''}` : 'No customer details'}
            {ticket.contact && <> · <Link href={`/saas/crm/contact/${ticket.contact.id}`}>{ticket.contact.name}</Link></>}
            {ticket.conversation_id && <> · <Link href={`/saas/chat?c=${ticket.conversation_id}`}>Open the chat</Link></>}
          </div>
        </div>
        {canEdit && (
          <div className="row-actions">
            <select aria-label="Status" value={ticket.status} disabled={busy}
              onChange={(e) => act(() => api.post(`/api/chatbot/tickets/${id}/status`, { status: e.target.value }))}>
              {Object.entries(TICKET_STATUS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            <button disabled={busy} onClick={() => setEditing(true)}>Edit</button>
            {overview?.is_manager && <button className="danger" disabled={busy} onClick={remove}>Delete</button>}
          </div>
        )}
      </div>
      {ticket.description && <p className="wrap chat-body">{ticket.description}</p>}

      <h3 className="social-heading">Log</h3>
      <div className="chat-messages">
        {ticket.notes.map((row: any) => (
          row.kind === 'change'
            ? <p key={row.id} className="chat-system">{row.body} · {personName(row.author_id)} · {timeText(row.created_at)}</p>
            : (
              <div key={row.id} className="chat-bubble them">
                <small>{personName(row.author_id)} · {timeText(row.created_at)}</small>
                <div className="chat-body">{row.body}</div>
              </div>
            )
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      {canEdit ? (
        <form className="chat-reply" onSubmit={addNote}>
          <textarea rows={2} maxLength={2000} placeholder="Add a note for the team" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
          <div className="form-actions"><button className="primary always" disabled={busy || !note.trim()}>Add note</button></div>
        </form>
      ) : <p className="muted">Your role can read tickets but not change them.</p>}

      {editing && (
        <TicketForm team={team} title={`Edit ticket #${ticket.number}`} start={ticket} onClose={() => setEditing(false)}
          onSave={async (data) => {
            await api.put(`/api/chatbot/tickets/${id}`, data);
            setEditing(false);
            await load();
            onChanged();
          }} />
      )}
    </div>
  );
}
