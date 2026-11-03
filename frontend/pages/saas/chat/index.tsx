import Link from 'next/link';
import { useRouter } from 'next/router';
import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import AppShell from '@/components/AppShell';
import ChatNav, { ChatMessage, STATUS_LABELS, STATUS_STYLES, stars, timeText } from '@/components/ChatNav';
import { api } from '@/lib/api';

export default function ChatInbox() {
  return <AppShell><Inbox /></AppShell>;
}

type Conversation = {
  id: string;
  status: string;
  visitor_name: string | null;
  visitor_email: string | null;
  started_on: string | null;
  wants_person: boolean;
  assigned_to: string | null;
  lead_id: string | null;
  staff_unread: number;
  rating?: number | null;
  last_message: string | null;
  last_message_at: string;
  created_at: string;
};

const TABS = [
  { key: 'waiting', label: 'Waiting' },
  { key: 'open', label: 'Open' },
  { key: 'closed', label: 'Closed' }
];

const visitorName = (chat: Conversation) => chat.visitor_name || chat.visitor_email || 'Visitor';

// Polling pauses while the tab is hidden
const useVisible = () => {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
};

function Inbox() {
  const router = useRouter();
  const visible = useVisible();
  const [overview, setOverview] = useState<any>(null);
  const [team, setTeam] = useState<any[]>([]);
  const [canned, setCanned] = useState<any[]>([]);
  const [tab, setTab] = useState('waiting');
  const [mine, setMine] = useState(false);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [list, setList] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const selected = typeof router.query.c === 'string' ? router.query.c : '';

  const loadList = useCallback(async () => {
    try {
      const summary = await api.get('/api/chatbot/overview');
      const params = new URLSearchParams({ status: tab });
      if (mine && summary.me) {
        params.set('mine', '1');
        params.set('me', summary.me);
      }
      if (query) params.set('q', query);
      const rows = await api.get(`/api/chatbot/conversations?${params}`);
      setOverview(summary);
      setList(rows);
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [tab, mine, query]);

  // Searching waits until typing pauses
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    api.get('/api/chatbot/team').then(setTeam).catch(() => setTeam([]));
    api.get('/api/chatbot/canned').then(setCanned).catch(() => setCanned([]));
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(loadList, 10000);
    return () => window.clearInterval(timer);
  }, [visible, loadList]);

  const open = (id: string) => router.replace({ pathname: '/saas/chat', query: { c: id } }, undefined, { shallow: true });

  return (
    <div className="stack">
      <ChatNav />
      <div className="page-head">
        <h1>Chat</h1>
      </div>
      {error && <p className="error">{error}</p>}
      {overview && !overview.enabled && (
        <p className="muted">Chat is switched off, so visitors can't start new chats. {overview.is_manager
          ? <Link href="/saas/chat/settings">Turn it on in Settings.</Link> : 'Ask an owner or admin to turn it on.'}</p>
      )}
      {overview && overview.enabled && !overview.online && (
        <p className="notice">Outside your opening hours: visitors see that you're away and are asked for their name and email.</p>
      )}
      {overview && (
        <div className="stats">
          <div className="card"><div className="stat-label">Waiting for a reply</div><div className="stat-value">{overview.waiting}</div></div>
          <div className="card"><div className="stat-label">Open</div><div className="stat-value">{overview.open}</div></div>
          <div className="card"><div className="stat-label">Unread messages</div><div className="stat-value">{overview.unread}</div></div>
          <div className="card"><div className="stat-label">Questions the bot missed</div><div className="stat-value">{overview.unanswered}</div>
            {overview.unanswered > 0 && <Link href="/saas/chat/answers">Add answers</Link>}</div>
          <div className="card"><div className="stat-label">Open tickets</div><div className="stat-value">{overview.tickets_open}</div>
            {overview.tickets_overdue > 0 && <Link href="/saas/chat/tickets?overdue=1" className="error">{overview.tickets_overdue} late</Link>}</div>
          <div className="card"><div className="stat-label">Rating, last 30 days</div>
            <div className="stat-value">{overview.rating_count ? `${Number(overview.rating_average).toFixed(1)} / 5` : '—'}</div>
            {overview.rating_count > 0 && <Link href="/saas/chat/ratings">{overview.rating_count} rating{overview.rating_count === 1 ? '' : 's'}</Link>}</div>
        </div>
      )}

      <div className="chat-inbox">
        <div className="card chat-list">
          <div className="tabs">
            {TABS.map(({ key, label }) => (
              <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
                {label}{overview && key !== 'closed' ? ` (${overview[key]})` : ''}
              </button>
            ))}
          </div>
          <input aria-label="Search chats" placeholder="Search name, email or message" value={search} onChange={(e) => setSearch(e.target.value)} />
          <label className="check"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only chats given to me</label>
          {loading && <p className="empty">Loading…</p>}
          {!loading && list.length === 0 && <p className="empty">No chats here</p>}
          {list.map((chat) => (
            <button key={chat.id} className={`chat-item ${chat.id === selected ? 'active' : ''}`} onClick={() => open(chat.id)}>
              <span className="chat-item-head">
                <strong>{visitorName(chat)}</strong>
                <small>{timeText(chat.last_message_at)}</small>
              </span>
              <span className="chat-item-text">{chat.last_message || 'No messages yet'}</span>
              <span className="chat-item-head">
                <small>{chat.assigned_to ? team.find((person) => person.id === chat.assigned_to)?.email || 'Someone' : 'Not assigned'}</small>
                {chat.rating ? <small title={`Rated ${chat.rating} of 5`}>{stars(chat.rating)}</small> : null}
                {chat.staff_unread > 0 && <span className="chat-unread">{chat.staff_unread}</span>}
              </span>
            </button>
          ))}
        </div>

        {selected
          ? <Thread key={selected} id={selected} team={team} canned={canned} overview={overview} visible={visible} onChanged={loadList} />
          : <div className="card chat-thread"><p className="empty">Choose a chat to read and reply</p></div>}
      </div>
    </div>
  );
}

// "Linked to <contact>", and for staff a search to link the chat to a CRM contact. A closed chat's
// transcript goes on that contact's timeline.
function ContactLink({ chat, canEdit, busy, onLink }: {
  chat: any; canEdit: boolean; busy: boolean; onLink: (contactId: string | null, done: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<any[]>([]);

  useEffect(() => {
    if (!picking) return;
    const timer = window.setTimeout(() => {
      api.get(`/api/chatbot/contacts?q=${encodeURIComponent(search.trim())}`).then(setFound).catch(() => setFound([]));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [picking, search]);

  const pick = (contactId: string | null, done: string) => {
    setPicking(false);
    setSearch('');
    onLink(contactId, done);
  };

  return (
    <div className="stack">
      <p className="muted">
        {chat.contact
          ? <>Linked to <Link href={`/saas/crm/contact/${chat.contact.id}`}>{chat.contact.name}</Link></>
          : 'Not linked to a CRM contact'}
        {canEdit && !picking && (
          <>
            {' · '}<button type="button" className="link" disabled={busy} onClick={() => setPicking(true)}>{chat.contact ? 'Change' : 'Link to a contact'}</button>
            {chat.contact && <>{' · '}<button type="button" className="link" disabled={busy} onClick={() => pick(null, 'Unlinked')}>Unlink</button></>}
          </>
        )}
      </p>
      {picking && (
        <div className="stack">
          <input autoFocus aria-label="Search contacts" placeholder="Search contacts by name or email" value={search}
            onChange={(e) => setSearch(e.target.value)} />
          {found.length === 0 && <p className="empty">No contacts found</p>}
          {found.map((contact) => (
            <button key={contact.id} type="button" className="chat-item" disabled={busy}
              onClick={() => pick(contact.id, `Linked to ${contact.name}`)}>
              <strong>{contact.name}</strong> <small>{contact.email || ''}</small>
            </button>
          ))}
          <div><button type="button" onClick={() => setPicking(false)}>Cancel</button></div>
        </div>
      )}
    </div>
  );
}

// A saved reply's text, with {name} as the visitor's first name
const fillReply = (body: string, chat: any) =>
  body.replace(/\{name\}/g, (chat?.visitor_name || '').trim().split(/\s+/)[0] || 'there');

function Thread({ id, team, canned, overview, visible, onChanged }: {
  id: string; team: any[]; canned: any[]; overview: any; visible: boolean; onChanged: () => void;
}) {
  const [chat, setChat] = useState<any>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lastId = useRef(0);
  const lastTyping = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);
  const canReply = Boolean(overview?.can_reply);
  // Typing "/" and the start of a shortcut lists the saved replies that match
  const shortcut = /^\/([a-z0-9_-]*)$/i.exec(reply.trim())?.[1]?.toLowerCase();
  const suggestions = shortcut === undefined ? [] : canned.filter((row) => row.shortcut.startsWith(shortcut)).slice(0, 8);

  // Tells the visitor someone is typing, at most every 3 seconds
  const typed = (value: string) => {
    setReply(value);
    if (!value.trim() || value.trim().startsWith('/') || Date.now() - lastTyping.current < 3000) return;
    lastTyping.current = Date.now();
    api.post(`/api/chatbot/conversations/${id}/typing`, {}).catch(() => null);
  };

  const pickCanned = (row: any) => setReply(fillReply(row.body, chat));

  const markRead = useCallback(() => api.post(`/api/chatbot/conversations/${id}/read`, {}).catch(() => null), [id]);

  const load = useCallback(async (fresh = false) => {
    try {
      const data = await api.get(`/api/chatbot/conversations/${id}${fresh ? '' : `?after=${lastId.current}`}`);
      const { messages: incoming, ...rest } = data;
      setChat(rest);
      if (fresh) {
        setMessages(incoming);
        lastId.current = Math.max(0, ...incoming.map((m: ChatMessage) => m.id));
      } else {
        // A reply and a check for new messages can overlap, so only messages not shown yet are added
        const added = incoming.filter((m: ChatMessage) => m.id > lastId.current);
        if (added.length) {
          lastId.current = Math.max(...added.map((m: ChatMessage) => m.id));
          setMessages((current) => [...current, ...added]);
        }
      }
      if (rest.staff_unread > 0) markRead();
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  }, [id, markRead]);

  useEffect(() => {
    lastId.current = 0;
    load(true).then(() => onChanged());
  }, [id]);

  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => load(), 4000);
    return () => window.clearInterval(timer);
  }, [visible, load]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  const act = async (work: () => Promise<any>, done?: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      await load();
      onChanged();
      if (done) setNotice(done);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const send = (event?: FormEvent) => {
    event?.preventDefault();
    const body = reply.trim();
    if (!body || busy) return;
    act(async () => {
      await api.post(`/api/chatbot/conversations/${id}/reply`, { body });
      setReply('');
    });
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.key === 'Tab' || event.key === 'Enter') && suggestions.length) {
      event.preventDefault();
      pickCanned(suggestions[0]);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const makeLead = () => act(async () => {
    const result = await api.post(`/api/chatbot/conversations/${id}/lead`, {});
    setChat((current: any) => ({ ...current, lead_id: result.lead_id }));
  }, 'Saved as a CRM lead');

  const makeTicket = () => act(async () => {
    const result = await api.post(`/api/chatbot/conversations/${id}/ticket`, { priority: 'normal' });
    setNotice(result.existing ? `This chat already has ticket #${result.ticket.number}` : `Ticket #${result.ticket.number} made`);
  });

  if (!chat) return <div className="card chat-thread">{error ? <p className="error">{error}</p> : <p className="empty">Loading…</p>}</div>;

  const authorName = (message: ChatMessage) => {
    if (message.sender === 'bot') return 'Bot';
    if (message.sender === 'visitor') return chat.visitor_name || 'Visitor';
    if (message.sender === 'staff') return team.find((person) => person.id === message.author_id)?.email || 'Team';
    return '';
  };

  return (
    <div className="card chat-thread">
      <div className="chat-thread-head">
        <div>
          <h2>{chat.visitor_name || 'Visitor'} <span className={`badge ${STATUS_STYLES[chat.status]}`}>{STATUS_LABELS[chat.status]}</span></h2>
          <div className="muted">
            {chat.visitor_email || 'No email yet'}
            {chat.started_on && <> · started on {chat.started_on}</>}
            {chat.wants_person && chat.status !== 'closed' && <> · asked for a person</>}
            {chat.campaign && <> · campaign {chat.campaign}</>}
          </div>
          {chat.rating && (
            <div className="muted">Visitor rated this chat <strong title={`${chat.rating} of 5`}>{stars(chat.rating)}</strong>
              {chat.rating_comment && <> · “{chat.rating_comment}”</>}</div>
          )}
        </div>
        {canReply && (
          <div className="row-actions">
            <select aria-label="Given to" value={chat.assigned_to || ''} disabled={busy}
              onChange={(e) => act(() => api.post(`/api/chatbot/conversations/${id}/assign`, { user_id: e.target.value || null }))}>
              <option value="">Not assigned</option>
              {team.map((person) => <option key={person.id} value={person.id}>{person.id === overview?.me ? `Me (${person.email})` : person.email}</option>)}
            </select>
            {chat.lead_id
              ? <Link className="button" href={`/saas/crm/lead/${chat.lead_id}`}>Open lead</Link>
              : <button disabled={busy || !chat.visitor_email} title={chat.visitor_email ? '' : 'Ask the visitor for their email first'} onClick={makeLead}>Make CRM lead</button>}
            {chat.tickets?.length
              ? <Link className="button" href={`/saas/chat/tickets?t=${chat.tickets[0].id}`}>Ticket #{chat.tickets[0].number}</Link>
              : <button disabled={busy} onClick={makeTicket} title="Keep track of this request as a ticket">Make ticket</button>}
            {chat.status === 'closed'
              ? <button disabled={busy} onClick={() => act(() => api.post(`/api/chatbot/conversations/${id}/status`, { status: 'open' }))}>Reopen</button>
              : <button disabled={busy} onClick={() => act(() => api.post(`/api/chatbot/conversations/${id}/status`, { status: 'closed' }))}>Close</button>}
          </div>
        )}
      </div>
      {!canReply && chat.lead_id && <p><Link href={`/saas/crm/lead/${chat.lead_id}`}>Open the CRM lead</Link></p>}
      <ContactLink chat={chat} canEdit={canReply} busy={busy}
        onLink={(contactId, done) => act(() => api.post(`/api/chatbot/conversations/${id}/contact`, { contact_id: contactId }), done)} />

      <div className="chat-messages">
        {messages.map((message) => (
          message.sender === 'system'
            ? <p key={message.id} className="chat-system">{message.body}</p>
            : (
              <div key={message.id} className={`chat-bubble ${message.sender === 'visitor' ? 'them' : 'us'} ${message.sender}`}>
                <small>{authorName(message)} · {timeText(message.created_at)}</small>
                <div className="chat-body">{message.body}</div>
              </div>
            )
        ))}
        {chat.visitor_typing && <p className="chat-typing">{chat.visitor_name || 'The visitor'} is typing…</p>}
        <div ref={bottom} />
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}
      {canReply ? (
        <form className="chat-reply" onSubmit={send}>
          <textarea rows={3} maxLength={2000} placeholder="Type a reply, or / and a shortcut for a saved reply. Enter sends, Shift+Enter adds a line."
            value={reply} onChange={(e) => typed(e.target.value)} onKeyDown={onKey} aria-label="Reply" />
          {suggestions.length > 0 && (
            <div className="chat-canned" role="listbox" aria-label="Saved replies">
              {suggestions.map((row) => (
                <button key={row.id} type="button" className="chat-item" onClick={() => pickCanned(row)}>
                  <strong>/{row.shortcut}</strong> <span className="chat-item-text">{row.body}</span>
                </button>
              ))}
              <small className="muted">Tab or Enter uses the first one</small>
            </div>
          )}
          {shortcut !== undefined && suggestions.length === 0 && (
            <small className="muted">No saved reply starts with /{shortcut}. <Link href="/saas/chat/replies">Add saved replies</Link></small>
          )}
          <div className="form-actions">
            <button className="primary always" disabled={busy || !reply.trim()}>Send</button>
            <span className="muted">The visitor sees replies within a few seconds while their chat page is open.</span>
          </div>
        </form>
      ) : <p className="muted">Your role can read chats but not reply.</p>}
    </div>
  );
}
