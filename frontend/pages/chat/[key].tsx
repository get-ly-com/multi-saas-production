import Head from 'next/head';
import { useRouter } from 'next/router';
import { CSSProperties, FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { campaignFromUrl } from '@/lib/campaign';

const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

// Public, so it can be linked to or embedded in an iframe on a customer's website. It must not
// touch sign-in or the company choice. The conversation's secret token is kept in this browser
// so a visitor who reloads carries on where they left off.
type Message = { id: number; from: string; body: string; at: string };
type Info = { company: string; welcome: string; hours: string; colour: string; bot: boolean; online?: boolean; away?: string | null };
type State = {
  status: string; needs_contact: boolean; name: string | null; email: string | null; messages: Message[];
  online?: boolean; staff_typing?: boolean; seen_up_to?: number; can_rate?: boolean; rating?: number | null;
};

const FAST = 3000;
const SLOW = 15000;
const QUIET_AFTER = 2 * 60 * 1000;

const storageKey = (key: string) => `chat:${key}`;
const readToken = (key: string) => {
  try {
    return window.localStorage.getItem(storageKey(key)) || '';
  } catch {
    return '';
  }
};
const saveToken = (key: string, token: string) => {
  try {
    if (token) window.localStorage.setItem(storageKey(key), token);
    else window.localStorage.removeItem(storageKey(key));
  } catch {
    // The chat then lasts only while this page is open
  }
};

// Where the visitor is chatting from, without the query string
const startedOn = () => {
  try {
    const source = window.self !== window.top ? document.referrer : window.location.href;
    if (!source) return '';
    const url = new URL(source);
    return `${url.origin}${url.pathname}`.slice(0, 500);
  } catch {
    return '';
  }
};

const post = async (path: string, body: unknown) => {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const error: any = new Error(result?.error || 'Something went wrong. Please try again.');
    error.status = response.status;
    throw error;
  }
  return result;
};

const timeText = (value: string) => new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export default function PublicChat() {
  const router = useRouter();
  const key = typeof router.query.key === 'string' ? router.query.key : '';
  const embedded = router.query.embed === '1';
  const [info, setInfo] = useState<Info | null>(null);
  const [closed, setClosed] = useState(false);
  const [token, setToken] = useState('');
  const [state, setState] = useState<State | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [contact, setContact] = useState({ name: '', email: '' });
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const lastTyping = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lastId = useRef(0);
  const lastActivity = useRef(Date.now());
  const bottom = useRef<HTMLDivElement>(null);
  const base = `/api/chat/${encodeURIComponent(key)}`;

  const take = useCallback((next: State, replace = false) => {
    setState(next);
    const incoming = next.messages || [];
    if (replace) {
      setMessages(incoming);
      lastId.current = Math.max(0, ...incoming.map((m) => m.id));
      return;
    }
    // A reply and a check for new messages can overlap, so only messages not shown yet are added
    const fresh = incoming.filter((m) => m.id > lastId.current);
    if (!fresh.length) return;
    lastId.current = Math.max(...fresh.map((m) => m.id));
    setMessages((current) => [...current, ...fresh]);
  }, []);

  useEffect(() => {
    if (!key) return;
    fetch(`${BASE_URL}${base}`)
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((found: Info) => {
        setInfo(found);
        const saved = readToken(key);
        if (!saved) return;
        // Carry on an earlier chat from this browser
        post(`${base}/poll`, { token: saved, after: 0 })
          .then((found) => {
            setToken(saved);
            take(found, true);
          })
          .catch(() => saveToken(key, ''));
      })
      .catch(() => setClosed(true));
  }, [key]);

  // When the bot asks for details, start from the name the visitor already gave
  useEffect(() => {
    if (state?.needs_contact) setContact((current) => (current.name ? current : { ...current, name: state.name || name }));
  }, [state?.needs_contact]);

  // Check for replies every few seconds, slower once the visitor goes quiet, never while hidden
  useEffect(() => {
    if (!token) return;
    let timer = 0;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (!document.hidden) {
        try {
          take(await post(`${base}/poll`, { token, after: lastId.current }));
        } catch (err: any) {
          if (err.status === 404 || err.status === 400) {
            setError('This chat is no longer available.');
            saveToken(key, '');
            return;
          }
        }
      }
      const quiet = Date.now() - lastActivity.current > QUIET_AFTER;
      timer = window.setTimeout(tick, quiet || document.hidden ? SLOW : FAST);
    };
    timer = window.setTimeout(tick, FAST);
    const wake = () => {
      if (!document.hidden) {
        window.clearTimeout(timer);
        tick();
      }
    };
    document.addEventListener('visibilitychange', wake);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [token, base, take]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, state?.needs_contact, state?.can_rate, state?.staff_typing]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    lastActivity.current = Date.now();
    try {
      await work();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const send = (event?: FormEvent) => {
    event?.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    run(async () => {
      let current = token;
      if (!current) {
        const started = await post(`${base}/start`, { name: name.trim(), page: startedOn(), campaign: campaignFromUrl(), website });
        current = started.token;
        saveToken(key, current);
        setToken(current);
        take(started, true);
      }
      take(await post(`${base}/messages`, { token: current, body, after: lastId.current }));
      setText('');
    });
  };

  // Lets the team see "typing...", at most every 3 seconds
  const typed = (value: string) => {
    setText(value);
    if (!token || !value.trim() || Date.now() - lastTyping.current < 3000) return;
    lastTyping.current = Date.now();
    post(`${base}/typing`, { token }).catch(() => null);
  };

  const sendRating = (event: FormEvent) => {
    event.preventDefault();
    if (!rating) return;
    run(async () => {
      take(await post(`${base}/rate`, { token, rating, comment: comment.trim(), after: lastId.current }));
    });
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const askPerson = () => run(async () => {
    let current = token;
    if (!current) {
      const started = await post(`${base}/start`, { name: name.trim(), page: startedOn(), campaign: campaignFromUrl(), website });
      current = started.token;
      saveToken(key, current);
      setToken(current);
      take(started, true);
    }
    take(await post(`${base}/person`, { token: current, after: lastId.current }));
  });

  const saveContact = (event: FormEvent) => {
    event.preventDefault();
    run(async () => {
      take(await post(`${base}/contact`, { token, name: contact.name.trim(), email: contact.email.trim(), after: lastId.current }));
    });
  };

  const startOver = () => {
    saveToken(key, '');
    setToken('');
    setState(null);
    setMessages([]);
    lastId.current = 0;
  };

  const colour = info?.colour || '#1f5eff';
  const style = { '--chat-colour': colour } as CSSProperties;
  const shown: Message[] = messages.length || !info?.welcome ? messages : [{ id: 0, from: 'bot', body: info.welcome, at: '' }];
  const online = state?.online ?? info?.online ?? true;
  // "Seen" goes under the visitor's newest message once the team has read it
  const lastMine = [...shown].reverse().find((message) => message.from === 'visitor');
  const seen = Boolean(lastMine && state?.seen_up_to && lastMine.id <= state.seen_up_to);

  return (
    <div className={`chat-public ${embedded ? 'embedded' : ''}`} style={style}>
      <Head><title>{info ? `Chat with ${info.company}` : 'Chat'}</title></Head>
      {closed && <p className="empty">This chat is not available.</p>}
      {!closed && !info && <p className="empty">Loading…</p>}
      {info && (
        <div className="chat-window">
          <header className="chat-header">
            <strong>{info.company}</strong>
            {info.hours && <small>Hours: {info.hours}</small>}
            {!online && <small>We're away right now. Leave a message and your email, and we'll reply when we're back.</small>}
          </header>

          <div className="chat-messages" aria-live="polite">
            {shown.map((message) => (
              message.from === 'system'
                ? <p key={message.id} className="chat-system">{message.body}</p>
                : (
                  <div key={message.id} className={`chat-bubble ${message.from === 'visitor' ? 'mine' : 'theirs'}`}>
                    <small>{message.from === 'visitor' ? 'You' : message.from === 'bot' ? `${info.company} (automatic reply)` : info.company}
                      {message.at && ` · ${timeText(message.at)}`}</small>
                    <div className="chat-body">{message.body}</div>
                    {seen && message.id === lastMine?.id && <small className="chat-seen">Seen</small>}
                  </div>
                )
            ))}
            {state?.staff_typing && <p className="chat-typing">{info.company} is typing…</p>}

            {state?.needs_contact && (
              <form className="chat-contact" onSubmit={saveContact}>
                <label>Your name<input maxLength={100} value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} /></label>
                <label>Your email<input type="email" required maxLength={254} value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} /></label>
                <button className="chat-send" disabled={busy}>Send my details</button>
              </form>
            )}
            {state?.can_rate && (
              <form className="chat-contact" onSubmit={sendRating}>
                <strong>How was this chat?</strong>
                <div className="chat-stars" role="radiogroup" aria-label="Rating">
                  {[1, 2, 3, 4, 5].map((value) => (
                    <button key={value} type="button" role="radio" aria-checked={rating === value} aria-label={`${value} of 5`}
                      className={value <= rating ? 'on' : ''} onClick={() => setRating(value)}>★</button>
                  ))}
                </div>
                <label>Anything to add? (optional)<textarea rows={2} maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} /></label>
                <button className="chat-send" disabled={busy || !rating}>Send rating</button>
              </form>
            )}
            <div ref={bottom} />
          </div>

          {error && <p className="error chat-error">{error}</p>}

          <form className="chat-compose" onSubmit={send}>
            {!token && (
              <>
                <input aria-label="Your name (optional)" placeholder="Your name (optional)" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
                <label className="trap" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} /></label>
              </>
            )}
            <textarea rows={2} maxLength={1000} aria-label="Message" placeholder="Type your message"
              value={text} onChange={(e) => typed(e.target.value)} onKeyDown={onKey} />
            <div className="chat-compose-actions">
              {state?.status !== 'waiting' && (
                <button type="button" className="link" disabled={busy} onClick={askPerson}>Talk to a person</button>
              )}
              {state?.status === 'waiting' && <small className="muted">A person will reply here soon.</small>}
              <button className="chat-send" disabled={busy || !text.trim()}>Send</button>
            </div>
            {token && state?.status === 'closed' && (
              <button type="button" className="link" onClick={startOver}>Start a new chat</button>
            )}
          </form>
        </div>
      )}
    </div>
  );
}
