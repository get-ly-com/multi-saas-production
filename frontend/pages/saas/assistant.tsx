import Link from 'next/link';
import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';
import AppShell, { useAccount } from '@/components/AppShell';
import EmptyState from '@/components/EmptyState';
import Icon from '@/components/Icon';
import Skeleton from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api, today } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';
import { store } from '@/lib/ui';
import s from '@/styles/assistant.module.css';

type Action = { id: string; kind: string; title: string; detail: string; link: string; link_label: string; priority: number };
type Feed = { actions: Action[]; note?: string; unavailable?: string[] };

const MAX_QUESTION = 500;
const EXPLAIN_MONTH = 'Explain my month so far in plain words: how sales, money in and out, and profit compare with last month, what stands out, and the two or three things I should do next.';
const SUGGESTIONS = ['Did we sell more than last month?', 'Who owes us the most?', 'What did we spend the most on?'];

const KIND_LABELS: Record<string, string> = {
  overdue_invoice: 'Money owed',
  bank_match: 'Banking',
  stock: 'Stock',
  chat: 'Chat',
  leave: 'Leave',
  pay_run: 'Payroll',
  quiet_deal: 'Deals'
};
const KIND_ICONS: Record<string, string> = { overdue_invoice: 'invoice', bank_match: 'bank', stock: 'inventory', chat: 'chat', leave: 'leave', pay_run: 'money', quiet_deal: 'deal' };

// The same "done for today" list as the Today page, so ticking in one place ticks both
const doneKey = (tenant: string, day: string) => `getly:todo-done:${tenant}:${day}`;

export default function Assistant() {
  return <AppShell><AssistantPage /></AppShell>;
}

function AssistantPage() {
  const account = useAccount();
  const tenant = account?.tenantId || '';
  const day = today();
  const [feed, setFeed] = useState<Feed | null>(null);
  const [feedError, setFeedError] = useState('');
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState<string[]>([]);
  const [checking, setChecking] = useState<string[]>([]);

  const load = async () => {
    setLoading(true);
    try {
      setFeed(await api.get('/api/analytics/assistant/actions'));
      setFeedError('');
    } catch (err: any) {
      setFeedError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (tenant) setDone(store.get<string[]>(doneKey(tenant, day), []));
  }, [tenant]);

  const save = (list: string[]) => {
    setDone(list);
    store.set(doneKey(tenant, day), list);
  };

  const check = (action: Action) => {
    setChecking((list) => [...list, action.id]);
    setTimeout(() => {
      setChecking((list) => list.filter((id) => id !== action.id));
      save([...store.get<string[]>(doneKey(tenant, day), []), action.id]);
      toast.success('Done for today', {
        detail: 'It comes back tomorrow if it still needs you.',
        action: { label: 'Undo', onClick: () => save(store.get<string[]>(doneKey(tenant, day), []).filter((id) => id !== action.id)) }
      });
    }, 520);
  };

  const open = (feed?.actions || []).filter((action) => !done.includes(action.id));

  return (
    <div className={`stack ${s.layout}`}>
      <div className="page-head">
        <div>
          <h1>Assistant</h1>
          <p className="muted">Ask about your numbers, and see what needs you across your apps.</p>
        </div>
        <button onClick={load} disabled={loading}>{loading ? 'Checking…' : 'Check again'}</button>
      </div>

      <Ask />

      <section className="card todo" aria-labelledby="todo-title">
        <div className="section-head">
          <div>
            <h2 id="todo-title">To do</h2>
            <p className="muted">Things across your apps that need you, most urgent first.</p>
          </div>
          {feed && open.length > 0 && <span className="count-pill">{open.length}</span>}
        </div>
        {feedError && <p className="error">{feedError}</p>}
        {!feed && loading && (
          <div className="todo-list" aria-busy="true">
            {[0, 1, 2].map((n) => (
              <div className="todo-row" key={n}>
                <Skeleton width={22} height={22} radius={999} />
                <div style={{ flex: 1, display: 'grid', gap: 6 }}><Skeleton width="55%" height={13} /><Skeleton width="80%" height={11} /></div>
              </div>
            ))}
          </div>
        )}
        {feed?.note && <p className="muted">{feed.note}</p>}
        {feed && !feed.note && open.length === 0 && (
          <EmptyState tone="done" icon="inbox" compact title="You're all caught up"
            line="Nothing needs you right now. Time is yours again." action={{ label: 'Go to Today', href: '/saas/today' }} />
        )}
        {feed && open.length > 0 && (
          <ul className="todo-list">
            {open.map((action) => {
              const ticking = checking.includes(action.id);
              return (
                <li key={action.id} className={`todo-row ${ticking ? 'is-checking' : ''}`}>
                  <button type="button" className="todo-check always" aria-label={`Mark "${action.title}" as done for today`} onClick={() => check(action)} disabled={ticking || !tenant}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M7.5 12.5l3 3 6-6.5" /></svg>
                  </button>
                  <span className="todo-icon" aria-hidden="true"><Icon name={KIND_ICONS[action.kind] || 'sparkle'} size={16} /></span>
                  <Link href={action.link} className="todo-text">
                    <strong>{action.title}</strong>
                    <span>{action.detail}</span>
                  </Link>
                  <span className="todo-meta">
                    <span className="chip">{KIND_LABELS[action.kind] || 'To do'}</span>
                    <Link href={action.link} className="button ghost small todo-go">{action.link_label}<Icon name="arrow-right" size={14} /></Link>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {feed?.unavailable && feed.unavailable.length > 0 && (
          <p className="muted small">We couldn&apos;t check {feed.unavailable.join(', ')} just now.</p>
        )}
      </section>
    </div>
  );
}

type Turn = { question: string; text: string };

function Ask() {
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const { busy, run } = useSubmit();
  const end = useRef<HTMLDivElement>(null);

  const ask = (text: string, shown = text) => run(async () => {
    setError('');
    setPending(shown);
    try {
      const result = await api.post('/api/analytics/assistant/ask', { question: text });
      setTurns((list) => [...list, { question: shown, text: result.answer }]);
      if (text === question.trim()) setQuestion('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setPending('');
    }
  });

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [turns.length, pending]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text) return setError('Type a question first');
    ask(text);
  };

  // Enter sends, Shift+Enter makes a new line
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  return (
    <section className={`card ${s.ask}`} aria-labelledby="ask-title">
      <div className={s.askHead}>
        <span className={s.spark} aria-hidden="true"><Icon name="assistant" size={18} /></span>
        <div>
          <h2 id="ask-title">Ask about your business</h2>
          <p className="muted">Answers come only from your company&apos;s own numbers for this month and last month.</p>
        </div>
      </div>

      {(turns.length > 0 || pending) && (
        <div className={s.thread} aria-live="polite">
          {turns.map((turn, n) => (
            <div key={n} style={{ display: 'contents' }}>
              <div className={s.question}>{turn.question}</div>
              <div className={s.answerRow}>
                <span className={s.avatar} aria-hidden="true"><Icon name="assistant" size={14} /></span>
                <div className={s.answer}>
                  {turn.text}
                  <small>Written by AI from your numbers. Check anything important before acting on it.</small>
                </div>
              </div>
            </div>
          ))}
          {pending && (
            <>
              <div className={s.question}>{pending}</div>
              <div className={s.answerRow} role="status" aria-label="Thinking">
                <span className={s.avatar} aria-hidden="true"><Icon name="assistant" size={14} /></span>
                <div className={`${s.answer} ${s.thinking}`}>
                  <span className={s.dots} aria-hidden="true"><i /><i /><i /></span>
                  <Skeleton width="92%" height={11} /><Skeleton width="76%" height={11} /><Skeleton width="54%" height={11} />
                </div>
              </div>
            </>
          )}
          <div ref={end} />
        </div>
      )}

      {turns.length === 0 && !pending && (
        <div className={s.suggestions}>
          <button type="button" className={`${s.suggestion} always`} disabled={busy} onClick={() => ask(EXPLAIN_MONTH, 'Explain my month')}>
            <Icon name="sparkle" size={14} />Explain my month
          </button>
          {SUGGESTIONS.map((text) => (
            <button key={text} type="button" className={`${s.suggestion} always`} disabled={busy} onClick={() => ask(text)}>{text}</button>
          ))}
        </div>
      )}

      <form onSubmit={submit} className={s.composer}>
        <label className="sr-only" htmlFor="ask-box">Your question</label>
        <textarea
          id="ask-box"
          rows={2}
          maxLength={MAX_QUESTION}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onKey}
          placeholder="Ask anything, like: did we sell more than last month?"
        />
        <div className={s.composerFoot}>
          <span className={s.count}>{question.length}/{MAX_QUESTION}</span>
          <span className="row-actions">
            {turns.length > 0 && (
              <button type="button" className="ghost small always" disabled={busy} onClick={() => ask(EXPLAIN_MONTH, 'Explain my month')}>Explain my month</button>
            )}
            <button className="primary small always" disabled={busy}>{busy ? 'Thinking…' : 'Ask'}<Icon name="arrow-right" size={14} /></button>
          </span>
        </div>
      </form>
      {error && <p className="error" style={{ margin: '0 var(--s-5) var(--s-5)' }}>{error}</p>}
    </section>
  );
}
