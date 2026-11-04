import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { api } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

type Action = { id: string; kind: string; title: string; detail: string; link: string; link_label: string; priority: number };
type Feed = { actions: Action[]; note?: string; unavailable?: string[] };

const MAX_QUESTION = 500;
const EXPLAIN_MONTH = 'Explain my month so far in plain words: how sales, money in and out, and profit compare with last month, what stands out, and the two or three things I should do next.';

const KIND_LABELS: Record<string, string> = {
  overdue_invoice: 'Money owed',
  bank_match: 'Banking',
  stock: 'Stock',
  chat: 'Chat',
  leave: 'Leave',
  pay_run: 'Payroll',
  quiet_deal: 'Deals'
};

export default function Assistant() {
  return <AppShell><AssistantPage /></AppShell>;
}

function AssistantPage() {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [feedError, setFeedError] = useState('');
  const [loading, setLoading] = useState(true);

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

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Assistant</h1>
        <button onClick={load} disabled={loading}>{loading ? 'Checking…' : 'Check again'}</button>
      </div>

      <Ask />

      <section className="card">
        <h2 style={{ marginTop: 0 }}>To do</h2>
        <p className="muted">Things across your apps that need you, most urgent first.</p>
        {feedError && <p className="error">{feedError}</p>}
        {!feed && loading && <p className="muted">Looking for things to do…</p>}
        {feed?.note && <p className="muted">{feed.note}</p>}
        {feed && !feed.note && feed.actions.length === 0 && <p className="empty">You&apos;re all caught up. Nothing needs you right now.</p>}
        {feed && feed.actions.length > 0 && (
          <div style={{ display: 'grid', gap: 8 }}>
            {feed.actions.map((action) => (
              <div key={action.id} className="timeline-item" style={{ alignItems: 'center' }}>
                <div>
                  <span className="badge">{KIND_LABELS[action.kind] || 'To do'}</span>{' '}
                  <strong>{action.title}</strong>
                  <div className="muted">{action.detail}</div>
                </div>
                <Link href={action.link} className="button" style={{ whiteSpace: 'nowrap' }}>{action.link_label} →</Link>
              </div>
            ))}
          </div>
        )}
        {feed?.unavailable && feed.unavailable.length > 0 && (
          <p className="muted">Couldn&apos;t check {feed.unavailable.join(', ')} just now.</p>
        )}
      </section>
    </div>
  );
}

function Ask() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<{ question: string; text: string } | null>(null);
  const [error, setError] = useState('');
  const { busy, run } = useSubmit();

  const ask = (text: string, shown = text) => run(async () => {
    setError('');
    try {
      const result = await api.post('/api/analytics/assistant/ask', { question: text });
      setAnswer({ question: shown, text: result.answer });
    } catch (err: any) {
      setError(err.message);
    }
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text) return setError('Type a question first');
    ask(text);
  };

  return (
    <section className="card">
      <h2 style={{ marginTop: 0 }}>Ask about your business</h2>
      <p className="muted">Answers come only from your company&apos;s own numbers for this month and last month.</p>
      <form onSubmit={submit}>
        <label>Your question
          <textarea
            rows={2}
            maxLength={MAX_QUESTION}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Did we sell more than last month? Who owes us the most?"
          />
        </label>
        <div className="form-actions">
          <button className="primary always" disabled={busy}>{busy ? 'Thinking…' : 'Ask'}</button>
          <button type="button" className="always" disabled={busy} onClick={() => ask(EXPLAIN_MONTH, 'Explain my month')}>Explain my month</button>
          <span className="muted" style={{ alignSelf: 'center' }}>{question.length}/{MAX_QUESTION}</span>
        </div>
      </form>
      {error && <p className="error">{error}</p>}
      {answer && (
        <div style={{ marginTop: 16 }}>
          <div className="muted">{answer.question}</div>
          <p style={{ whiteSpace: 'pre-wrap' }}>{answer.text}</p>
          <p className="muted" style={{ fontSize: 13 }}>Written by AI from your numbers. Check anything important before acting on it.</p>
        </div>
      )}
    </section>
  );
}
