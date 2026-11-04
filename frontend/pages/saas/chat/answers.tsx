import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import ChatNav, { timeText } from '@/components/ChatNav';
import EmptyState from '@/components/EmptyState';
import Icon from '@/components/Icon';
import Modal from '@/components/Modal';
import { SkeletonTable } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api, formatDate } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';
import c from '@/styles/chat.module.css';

export default function ChatAnswers() {
  return <AppShell><Answers /></AppShell>;
}

type Answer = { id?: string; question: string; answer: string; keywords: string; is_active: boolean; times_used?: number; last_used_at?: string | null; unanswered_id?: string };

const blank: Answer = { question: '', answer: '', keywords: '', is_active: true };

function Answers() {
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [missed, setMissed] = useState<any[]>([]);
  const [overview, setOverview] = useState<any>(null);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Answer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [summary, rows, questions] = await Promise.all([
        api.get('/api/chatbot/overview'), api.get('/api/chatbot/answers'), api.get('/api/chatbot/unanswered')
      ]);
      setOverview(summary);
      setAnswers(rows);
      setMissed(questions);
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const canEdit = Boolean(overview?.can_reply);
  const query = search.trim().toLowerCase();
  const visible = answers.filter((row) => `${row.question} ${row.keywords} ${row.answer}`.toLowerCase().includes(query));

  const { busy, run: once } = useSubmit();
  const remove = (row: Answer) => once(async () => {
    if (!window.confirm(`Delete the answer to "${row.question}"?`)) return;
    try {
      await api.delete(`/api/chatbot/answers/${row.id}`);
      toast.success('Answer deleted');
      load();
    } catch (err: any) {
      setError(err.message);
    }
  });

  const dismiss = (id: string) => once(async () => {
    try {
      await api.delete(`/api/chatbot/unanswered/${id}`);
      setMissed((rows) => rows.filter((row) => row.id !== id));
      toast.info('Question dismissed');
    } catch (err: any) {
      setError(err.message);
    }
  });

  return (
    <div className="stack">
      <ChatNav />
      <div className="page-head">
        <div>
          <h1>Answers</h1>
          <p className="muted">What the bot says when visitors ask common questions.</p>
        </div>
        {canEdit && <button className="primary" onClick={() => setEditing(blank)}><Icon name="plus" size={16} />New answer</button>}
      </div>
      <p className="muted small">The bot replies with the answer that best matches what a visitor types. Keywords are the strongest
        signal: if every word of a keyword is in the message, that answer is picked. When nothing matches, the bot asks for the
        visitor's name and email and alerts your team.</p>
      {error && <p className="error">{error}</p>}

      <TryBot />

      {missed.length > 0 && (
        <div className="card">
          <div className="section-head">
            <div><h2>Questions the bot couldn&apos;t answer</h2><p className="muted">Add an answer once and the bot handles it next time.</p></div>
            <span className="count-pill">{missed.length}</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Question</th><th className="num">Times asked</th><th>Last asked</th><th /></tr></thead>
              <tbody>
                {missed.map((row) => (
                  <tr key={row.id}>
                    <td className="wrap">{row.question}</td>
                    <td className="num">{row.times}</td>
                    <td>{timeText(row.last_asked_at)}</td>
                    <td>
                      <div className="row-actions">
                        {row.conversation_id && <Link className="button" href={`/saas/chat?c=${row.conversation_id}`}>View chat</Link>}
                        {canEdit && <button onClick={() => setEditing({ ...blank, question: row.question.slice(0, 300), unanswered_id: row.id })}>Add answer</button>}
                        {canEdit && <button disabled={busy} onClick={() => dismiss(row.id)}>Dismiss</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="report-filters">
        <input type="search" aria-label="Search answers" placeholder="Search questions, keywords and answers" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {loading ? <SkeletonTable rows={5} columns={5} /> : !answers.length ? (
        <div className="card">
          <EmptyState icon="assistant" title="Teach the bot its first answer"
            line="Add the questions your customers ask most, like opening hours, delivery and refunds."
            action={canEdit ? { label: 'New answer', onClick: () => setEditing(blank) } : undefined} />
        </div>
      ) : (
      <div className="card table-wrap">
        {(
          <table>
            <thead><tr><th>Question</th><th>Keywords</th><th className="num">Used</th><th>Last used</th><th>Status</th><th /></tr></thead>
            <tbody>
              {visible.length === 0 && (
                <tr><td colSpan={6} className="empty">No answers match your search</td></tr>
              )}
              {visible.map((row) => (
                <tr key={row.id}>
                  <td className="wrap"><strong>{row.question}</strong><div className="muted chat-answer-preview">{row.answer}</div></td>
                  <td className="wrap">{row.keywords ? row.keywords.split(',').map((word) => word.trim()).filter(Boolean).map((word) => <span key={word} className="chip" style={{ margin: '0 4px 4px 0' }}>{word}</span>) : <span className="muted">None</span>}</td>
                  <td className="num">{row.times_used}</td>
                  <td>{row.last_used_at ? formatDate(row.last_used_at) : <span className="muted">Not yet</span>}</td>
                  <td><span className={`badge ${row.is_active ? 'active' : 'inactive'}`}>{row.is_active ? 'on' : 'off'}</span></td>
                  <td>
                    {canEdit && (
                      <div className="row-actions">
                        <button className="small" onClick={() => setEditing(row)}>Edit</button>
                        <button disabled={busy} className="small ghost danger" onClick={() => remove(row)}>Delete</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      )}

      {editing && <AnswerForm initial={editing} onClose={() => setEditing(null)} onSaved={() => { toast.success(editing.id ? 'Answer saved' : 'Answer added', { detail: 'The bot can use it straight away.' }); setEditing(null); load(); }} />}
    </div>
  );
}

function TryBot() {
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');

  const { busy, run } = useSubmit();
  const tryIt = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        setResult(await api.post('/api/chatbot/answers/test', { text: message }));
        setError('');
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <form className="card" onSubmit={tryIt}>
      <h2>Try the bot</h2>
      <p className="muted small">Type what a customer might ask and see what the bot would say.</p>
      <div className="chat-try">
        <input aria-label="Question to try" maxLength={1000} placeholder="Type a question a customer might ask" value={message} onChange={(e) => setMessage(e.target.value)} />
        <button className="always" disabled={busy || !message.trim()}>Try</button>
      </div>
      {error && <p className="error">{error}</p>}
      {result && (result.matched
        ? <div className={c.row} style={{ marginTop: 12, maxWidth: '100%' }}><span className={`${c.avatar} ${c.small} ${c.bot}`} aria-hidden="true"><Icon name="assistant" size={14} /></span><div className={`${c.bubble}`}><span className={c.meta}>Matched &ldquo;{result.question}&rdquo;</span><div className={c.body}>{result.answer}</div></div></div>
        : <p className="muted">{result.vague
          ? 'The bot would ask the visitor to say a little more.'
          : 'No answer matches, so the bot would hand over to a person and add this to the questions it couldn\'t answer.'}</p>)}
    </form>
  );
}

function AnswerForm({ initial, onClose, onSaved }: { initial: Answer; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<Answer>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (field: keyof Answer, value: any) => setForm({ ...form, [field]: value });

  const { busy, run } = useSubmit();
  const save = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      setSaving(true);
      try {
        if (form.id) await api.put(`/api/chatbot/answers/${form.id}`, form);
        else await api.post('/api/chatbot/answers', form);
        onSaved();
      } catch (err: any) {
        setError(err.message);
        setSaving(false);
      }
    });
  };

  return (
    <Modal title={form.id ? 'Edit answer' : 'New answer'} onClose={onClose}>
      <form onSubmit={save} className="stack">
        <label>Question<input required maxLength={300} value={form.question} onChange={(e) => set('question', e.target.value)}
          placeholder="What are your opening hours?" /></label>
        <label>Answer<textarea required rows={5} maxLength={4000} value={form.answer} onChange={(e) => set('answer', e.target.value)} /></label>
        <label>Keywords, separated by commas<input maxLength={500} value={form.keywords} onChange={(e) => set('keywords', e.target.value)}
          placeholder="hours, open, closing time" /></label>
        <label className="check"><input type="checkbox" checked={form.is_active} onChange={(e) => set('is_active', e.target.checked)} /> The bot can use this answer</label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary" disabled={busy || saving}>{saving ? 'Saving…' : 'Save'}</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
