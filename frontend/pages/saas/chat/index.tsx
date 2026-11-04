import Link from 'next/link';
import { useRouter } from 'next/router';
import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import AppShell, { useAccount } from '@/components/AppShell';
import { celebrate } from '@/components/Celebrate';
import ChatNav, { ChatMessage, STATUS_LABELS, STATUS_STYLES, WA_STATUS, stars, timeText } from '@/components/ChatNav';
import EmptyState from '@/components/EmptyState';
import Icon from '@/components/Icon';
import Skeleton from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api, isUuid, today } from '@/lib/api';
import { store } from '@/lib/ui';
import c from '@/styles/chat.module.css';

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
  channel?: string;
  visitor_phone?: string | null;
};

// WhatsApp lets a business write freely for 24 hours after the customer's last message
const WINDOW_MS = 24 * 60 * 60 * 1000;
const windowOpen = (chat: any) => Boolean(chat?.last_visitor_at) && Date.now() - Date.parse(chat.last_visitor_at) < WINDOW_MS;
const WhatsAppBadge = () => <span className={c.waBadge} title="This chat is on WhatsApp">WhatsApp</span>;

const TABS = [
  { key: 'waiting', label: 'Waiting' },
  { key: 'open', label: 'Open' },
  { key: 'closed', label: 'Closed' }
];

const visitorName = (chat: Conversation) => chat.visitor_name || chat.visitor_email || (chat.visitor_phone ? `+${chat.visitor_phone}` : 'Visitor');

// "Sam Jones" becomes "SJ"; an email or phone gives its first character
const initials = (name: string) => {
  const words = (name || '').replace(/[^A-Za-z0-9À-￿\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : words[0].slice(0, 1)).toUpperCase();
};

function Avatar({ name, kind = '', size = '' }: { name: string; kind?: string; size?: string }) {
  return <span className={`${c.avatar} ${kind ? c[kind] : ''} ${size ? c[size] : ''}`} aria-hidden="true">{kind === 'bot' ? <Icon name="assistant" size={14} /> : initials(name)}</span>;
}

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

const cheeredKey = (tenant: string, day: string) => `getly:chat-zero:${tenant}:${day}`;

function Inbox() {
  const router = useRouter();
  const account = useAccount();
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
  const zeroBox = useRef<HTMLDivElement>(null);
  const cheered = useRef(false);
  const selected = isUuid(router.query.c) ? router.query.c : '';

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
  const close = () => router.replace({ pathname: '/saas/chat' }, undefined, { shallow: true });

  // Inbox zero: nobody is waiting for a reply. A small celebration the first time each day.
  const tenant = account?.tenantId || '';
  const inboxZero = !loading && !error && tab === 'waiting' && !query && !mine && list.length === 0 && overview && Number(overview.waiting) === 0;
  useEffect(() => {
    if (!inboxZero || cheered.current || !tenant) return;
    cheered.current = true;
    const key = cheeredKey(tenant, today());
    if (!store.get(key, false)) {
      store.set(key, true);
      setTimeout(() => celebrate({ from: zeroBox.current?.querySelector('.empty-art') }), 250);
    }
  }, [inboxZero, tenant]);

  return (
    <div className="stack">
      <ChatNav />
      <div className="page-head">
        <div>
          <h1>Inbox</h1>
          <p className="muted">Website and WhatsApp chats in one place. Newest first.</p>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {overview && !overview.enabled && (
        <p className="muted">Chat is switched off, so visitors can&apos;t start new chats. {overview.is_manager
          ? <Link href="/saas/chat/settings">Turn it on in Settings.</Link> : 'Ask an owner or admin to turn it on.'}</p>
      )}
      {overview && overview.enabled && !overview.online && (
        <p className="notice">Outside your opening hours, so visitors see that you&apos;re away and are asked for their name and email.</p>
      )}
      {!overview && !error && (
        <div className={c.statRow} aria-hidden="true">
          {[0, 1, 2, 3, 4, 5].map((n) => <div className="card" key={n}><Skeleton width="60%" height={11} /><Skeleton width="40%" height={20} style={{ marginTop: 8 }} /></div>)}
        </div>
      )}
      {overview && (
        <div className={c.statRow}>
          <div className="card"><div className="stat-label">Waiting for a reply</div><div className="stat-value">{overview.waiting}</div></div>
          <div className="card"><div className="stat-label">Open</div><div className="stat-value">{overview.open}</div></div>
          <div className="card"><div className="stat-label">Unread messages</div><div className="stat-value">{overview.unread}</div></div>
          <div className="card"><div className="stat-label">Questions the bot missed</div><div className="stat-value">{overview.unanswered}</div>
            {overview.unanswered > 0 && <Link href="/saas/chat/answers">Add answers</Link>}</div>
          <div className="card"><div className="stat-label">Open tickets</div><div className="stat-value">{overview.tickets_open}</div>
            {overview.tickets_overdue > 0 && <Link href="/saas/chat/tickets?overdue=1" className="error">{overview.tickets_overdue} late</Link>}</div>
          <div className="card"><div className="stat-label">Rating, last 30 days</div>
            <div className="stat-value">{overview.rating_count ? `${Number(overview.rating_average).toFixed(1)} / 5` : 'None yet'}</div>
            {overview.rating_count > 0 && <Link href="/saas/chat/ratings">{overview.rating_count} rating{overview.rating_count === 1 ? '' : 's'}</Link>}</div>
        </div>
      )}

      <div className={`${c.inbox} ${selected ? c.picked : c.noSide}`}>
        <div className={c.list}>
          <div className={c.listHead}>
            <div className="tabs" role="tablist">
              {TABS.map(({ key, label }) => (
                <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
                  {label}{overview && key !== 'closed' && Number(overview[key]) > 0 ? <span className="count-pill" style={{ marginLeft: 6 }}>{overview[key]}</span> : null}
                </button>
              ))}
            </div>
            <div className={c.search}>
              <Icon name="search" size={16} />
              <input type="search" aria-label="Search chats" placeholder="Search name, email or message" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <label className="check"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only chats given to me</label>
          </div>
          <div className={c.items} ref={zeroBox}>
            {loading && [0, 1, 2, 3, 4].map((n) => (
              <div key={n} className={c.item} aria-hidden="true">
                <Skeleton width={36} height={36} radius={999} />
                <span className={c.itemBody}><Skeleton width="55%" height={13} /><Skeleton width="85%" height={11} style={{ marginTop: 6 }} /></span>
              </div>
            ))}
            {inboxZero && (
              <EmptyState tone="done" icon="inbox" compact title="Inbox zero"
                line="Every chat has a reply. Time is yours again."
                action={{ label: 'See tickets', href: '/saas/chat/tickets' }} />
            )}
            {!loading && !inboxZero && list.length === 0 && (
              <EmptyState compact icon="chat" title={query ? 'No chats match' : 'No chats here'}
                line={query ? 'Try a different name, email or word.' : tab === 'closed' ? 'Closed chats show up here.' : 'New chats from your website and WhatsApp land here.'} />
            )}
            {list.map((chat) => {
              const name = visitorName(chat);
              const assignee = chat.assigned_to ? team.find((person) => person.id === chat.assigned_to)?.email || 'Someone' : 'Not assigned';
              return (
                <button key={chat.id} className={`${c.item} ${chat.id === selected ? c.active : ''} ${chat.staff_unread > 0 ? c.unread : ''}`}
                  aria-current={chat.id === selected ? 'true' : undefined} onClick={() => open(chat.id)}>
                  <span className={`${c.avatar} ${chat.channel === 'whatsapp' ? c.wa : ''}`} aria-hidden="true">{initials(name)}</span>
                  <span className={c.itemBody}>
                    <span className={c.itemTop}>
                      <strong>{name}</strong>
                      <small>{timeText(chat.last_message_at)}</small>
                    </span>
                    <span className={c.itemText}>{chat.last_message || 'No messages yet'}</span>
                    <span className={c.itemFoot}>
                      <small>{chat.channel === 'whatsapp' && <><WhatsAppBadge />{' '}</>}{assignee}</small>
                      {chat.rating ? <small className={c.rating} title={`Rated ${chat.rating} of 5`}>{stars(chat.rating)}</small> : null}
                      {chat.staff_unread > 0 && <span className={c.unreadPill} aria-label={`${chat.staff_unread} unread`}>{chat.staff_unread}</span>}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {selected
          ? <Thread key={selected} id={selected} team={team} canned={canned} overview={overview} visible={visible} onChanged={loadList} onBack={close} />
          : (
            <div className={c.placeholder}>
              <EmptyState icon="chat" title="Pick a chat" line="Choose a conversation on the left to read it and reply." />
            </div>
          )}
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
    <div className={c.sideSection}>
      <h4>CRM contact</h4>
      <p className="small" style={{ margin: 0 }}>
        {chat.contact
          ? <>Linked to <Link href={`/saas/crm/contact/${chat.contact.id}`}>{chat.contact.name}</Link></>
          : <span className="muted">Not linked to a CRM contact yet</span>}
      </p>
      {canEdit && !picking && (
        <div className="row-actions">
          <button type="button" className="small" disabled={busy} onClick={() => setPicking(true)}>{chat.contact ? 'Change' : 'Link to a contact'}</button>
          {chat.contact && <button type="button" className="small ghost" disabled={busy} onClick={() => pick(null, 'Unlinked')}>Unlink</button>}
        </div>
      )}
      {picking && (
        <div className={c.contactPick}>
          <input autoFocus aria-label="Search contacts" placeholder="Search by name or email" value={search}
            onChange={(e) => setSearch(e.target.value)} />
          {found.length === 0 && <p className="muted small" style={{ margin: '4px 0' }}>No contacts found</p>}
          {found.map((contact) => (
            <button key={contact.id} type="button" className="ghost" disabled={busy}
              onClick={() => pick(contact.id, `Linked to ${contact.name}`)}>
              <strong>{contact.name}</strong><small>{contact.email || ''}</small>
            </button>
          ))}
          <div><button type="button" className="small" onClick={() => setPicking(false)}>Cancel</button></div>
        </div>
      )}
    </div>
  );
}

// A saved reply's text, with {name} as the visitor's first name
const fillReply = (body: string, chat: any) =>
  body.replace(/\{name\}/g, (chat?.visitor_name || '').trim().split(/\s+/)[0] || 'there');

function Thread({ id, team, canned, overview, visible, onChanged, onBack }: {
  id: string; team: any[]; canned: any[]; overview: any; visible: boolean; onChanged: () => void; onBack: () => void;
}) {
  const [chat, setChat] = useState<any>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
  }, [messages.length, chat?.visitor_typing]);

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

  const send = (event?: FormEvent) => {
    event?.preventDefault();
    const body = reply.trim();
    if (!body || busy) return;
    let notSent = '';
    act(async () => {
      const sent = await api.post(`/api/chatbot/conversations/${id}/reply`, { body });
      setReply('');
      // Saved in the chat, but WhatsApp didn't take it
      notSent = sent?.whatsapp_error || '';
    }).then(() => notSent && setError(notSent));
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
    if (result.existing) toast.info(`This chat already has ticket #${result.ticket.number}`);
    else toast.success(`Ticket #${result.ticket.number} made`, { action: { label: 'Open', onClick: () => { window.location.href = `/saas/chat/tickets?t=${result.ticket.id}`; } } });
  });

  if (!chat) {
    return (
      <div className={c.thread}>
        {error ? <div style={{ padding: 16 }}><p className="error">{error}</p></div> : (
          <div className={c.messages} aria-busy="true" aria-label="Loading chat">
            {[0, 1, 2, 3].map((n) => (
              <div key={n} className={`${c.row} ${n % 2 ? c.mine : ''}`}>
                <Skeleton width={28} height={28} radius={999} />
                <Skeleton width={n % 2 ? 180 : 240} height={44} radius={16} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const onWhatsApp = chat.channel === 'whatsapp';
  const whatsAppClosed = onWhatsApp && !windowOpen(chat);
  const name = chat.visitor_name || (chat.visitor_phone ? `+${chat.visitor_phone}` : 'Visitor');
  const assignee = chat.assigned_to ? team.find((person) => person.id === chat.assigned_to)?.email : '';

  const authorName = (message: ChatMessage) => {
    if (message.sender === 'bot') return 'Bot';
    if (message.sender === 'visitor') return chat.visitor_name || 'Visitor';
    if (message.sender === 'staff') return team.find((person) => person.id === message.author_id)?.email || 'Team';
    return '';
  };

  return (
    <>
      <section className={c.thread} aria-label={`Chat with ${name}`}>
        <header className={c.threadHead}>
          <div className={c.threadTitle}>
            <button type="button" className={`icon-button ${c.back}`} aria-label="Back to chats" onClick={onBack}><Icon name="chevron-left" size={18} /></button>
            <Avatar name={name} />
            <div style={{ minWidth: 0 }}>
              <h2>{name} <span className={`badge ${STATUS_STYLES[chat.status]}`}>{STATUS_LABELS[chat.status]}</span>{onWhatsApp && <WhatsAppBadge />}</h2>
              <p>
                {onWhatsApp ? `+${chat.visitor_phone || ''}` : chat.visitor_email || 'No email yet'}
                {chat.wants_person && chat.status !== 'closed' && <> · asked for a person</>}
              </p>
            </div>
          </div>
          {canReply && (
            <div className={c.threadActions}>
              {chat.status === 'closed'
                ? <button className="small" disabled={busy} onClick={() => act(() => api.post(`/api/chatbot/conversations/${id}/status`, { status: 'open' }), 'Chat reopened')}>Reopen</button>
                : <button className="small" disabled={busy} onClick={() => act(() => api.post(`/api/chatbot/conversations/${id}/status`, { status: 'closed' }), 'Chat closed')}><Icon name="check" size={14} />Close</button>}
            </div>
          )}
        </header>

        <div className={c.messages}>
          {messages.map((message) => {
            if (message.sender === 'system') return <p key={message.id} className={c.system}>{message.body}</p>;
            const mineSide = message.sender !== 'visitor';
            const author = authorName(message);
            return (
              <div key={message.id} className={`${c.row} ${mineSide ? c.mine : ''} ${message.sender === 'bot' ? c.botRow : ''}`}>
                <Avatar name={author} size="small" kind={message.sender === 'bot' ? 'bot' : message.sender === 'staff' ? 'staff' : ''} />
                <div className={c.bubble}>
                  <span className={c.meta}>{author} · {timeText(message.created_at)}
                    {message.wa_status && <> · <span className={message.wa_status === 'failed' ? c.metaError : ''}
                      title={message.send_error || ''}>{WA_STATUS[message.wa_status] || message.wa_status}</span></>}</span>
                  <div className={c.body}>{message.body}</div>
                  {message.wa_status === 'failed' && message.send_error && <span className={`${c.meta} ${c.metaError}`}>{message.send_error}</span>}
                </div>
              </div>
            );
          })}
          {chat.visitor_typing && (
            <div className={c.typing} role="status" aria-label={`${chat.visitor_name || 'The visitor'} is typing`}>
              <Avatar name={name} size="small" />
              <span className={c.dots} aria-hidden="true"><i /><i /><i /></span>
            </div>
          )}
          <div ref={bottom} />
        </div>

        <div className={c.threadNotes}>
          {error && <p className="error">{error}</p>}
          {canReply && whatsAppClosed && (
            <p className="notice">It has been more than 24 hours since this customer last wrote. WhatsApp only allows a
              pre-approved template message now, so replies here won&apos;t be sent. When they message you again, you can reply for 24 hours.</p>
          )}
        </div>
        {canReply ? (
          <form className={c.composer} onSubmit={send}>
            {suggestions.length > 0 && (
              <div className={c.canned} role="listbox" aria-label="Saved replies">
                {suggestions.map((row) => (
                  <button key={row.id} type="button" onClick={() => pickCanned(row)}>
                    <strong>/{row.shortcut}</strong> <span>{row.body}</span>
                  </button>
                ))}
                <small className="muted" style={{ padding: '2px 8px' }}>Tab or Enter uses the first one</small>
              </div>
            )}
            {shortcut !== undefined && suggestions.length === 0 && (
              <small className="muted">No saved reply starts with /{shortcut}. <Link href="/saas/chat/replies">Add saved replies</Link></small>
            )}
            <textarea rows={3} maxLength={2000} placeholder={onWhatsApp ? 'Reply on WhatsApp, or type / for a saved reply' : 'Write a reply, or type / for a saved reply'}
              value={reply} onChange={(e) => typed(e.target.value)} onKeyDown={onKey} aria-label="Reply" />
            <div className={c.composerFoot}>
              <span>{onWhatsApp
                ? 'Replies go to the customer on WhatsApp.'
                : 'The visitor sees replies within a few seconds.'} <span className="kbd">Enter</span> sends, <span className="kbd">Shift</span> + <span className="kbd">Enter</span> adds a line.</span>
              <button className="primary always" disabled={busy || !reply.trim() || whatsAppClosed}>Send<Icon name="arrow-right" size={14} /></button>
            </div>
          </form>
        ) : <p className="muted small" style={{ padding: '10px 16px', margin: 0, borderTop: '1px solid var(--border)' }}>Your role can read chats but not reply.</p>}
      </section>

      <aside className={c.side} aria-label="About this visitor">
        <div className={c.who}>
          <Avatar name={name} size="large" />
          <h3>{name}</h3>
          {chat.visitor_email && <p>{chat.visitor_email}</p>}
          {onWhatsApp && <p>+{chat.visitor_phone || ''} <WhatsAppBadge /></p>}
        </div>

        {canReply && (
          <div className={c.sideSection}>
            <h4>Given to</h4>
            <select aria-label="Given to" value={chat.assigned_to || ''} disabled={busy}
              onChange={(e) => act(() => api.post(`/api/chatbot/conversations/${id}/assign`, { user_id: e.target.value || null }), e.target.value ? 'Chat assigned' : 'Chat unassigned')}>
              <option value="">Not assigned</option>
              {team.map((person) => <option key={person.id} value={person.id}>{person.id === overview?.me ? `Me (${person.email})` : person.email}</option>)}
            </select>
          </div>
        )}
        {!canReply && assignee && (
          <div className={c.sideSection}><h4>Given to</h4><p className="small" style={{ margin: 0 }}>{assignee}</p></div>
        )}

        <div className={c.sideSection}>
          <h4>Details</h4>
          <dl className={c.facts}>
            {chat.started_on && <div><dt>Started on</dt><dd>{chat.started_on}</dd></div>}
            {chat.campaign && <div><dt>Campaign</dt><dd>{chat.campaign}</dd></div>}
            <div><dt>Channel</dt><dd>{onWhatsApp ? 'WhatsApp' : 'Website'}</dd></div>
            {chat.rating && <div><dt>Rating</dt><dd className={c.rating} title={`${chat.rating} of 5`}>{stars(chat.rating)}</dd></div>}
          </dl>
          {chat.rating_comment && <p className="small muted" style={{ margin: 0 }}>&ldquo;{chat.rating_comment}&rdquo;</p>}
        </div>

        <ContactLink chat={chat} canEdit={canReply} busy={busy}
          onLink={(contactId, done) => act(() => api.post(`/api/chatbot/conversations/${id}/contact`, { contact_id: contactId }), done)} />

        <div className={c.sideSection}>
          <h4>Follow up</h4>
          {chat.lead_id
            ? <Link className="button small" href={`/saas/crm/lead/${chat.lead_id}`}><Icon name="lead" size={14} />Open the CRM lead</Link>
            : canReply && <button className="small" disabled={busy || !chat.visitor_email} title={chat.visitor_email ? '' : 'Ask the visitor for their email first'} onClick={makeLead}><Icon name="lead" size={14} />Make CRM lead</button>}
          {chat.tickets?.length
            ? <Link className="button small" href={`/saas/chat/tickets?t=${chat.tickets[0].id}`}><Icon name="invoice" size={14} />Ticket #{chat.tickets[0].number}</Link>
            : canReply && <button className="small" disabled={busy} onClick={makeTicket} title="Keep track of this request as a ticket"><Icon name="invoice" size={14} />Make ticket</button>}
          {!canReply && !chat.lead_id && !chat.tickets?.length && <p className="muted small" style={{ margin: 0 }}>No lead or ticket yet.</p>}
        </div>
      </aside>
    </>
  );
}
