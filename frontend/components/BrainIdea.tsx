import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { celebrate } from '@/components/Celebrate';
import Drawer from '@/components/Drawer';
import Icon from '@/components/Icon';
import { toast } from '@/components/Toast';
import { api, formatDate, money } from '@/lib/api';
import { count, plural } from '@/lib/format';
import useSubmit from '@/lib/useSubmit';
import s from '@/styles/brain.module.css';

// One idea from the Business Brain: the card in the list and the drawer where it is decided.
// The shapes follow backend/services/brain-service/README.md ("The idea object").

export type Evidence = { fact: string; number?: number | null; source?: string };
export type Impact = { metric?: string; amount?: number | null; currency?: string; timeframe_days?: number; confidence?: number };
export type IdeaAction = { type: string; label?: string; params?: Record<string, any> };
export type Run = {
  position: number; action: string; status: string; error?: string | null; at?: string;
  result?: { message?: string; link?: string; whatsapp_link?: string } | null;
};
export type Outcome = { metric?: string; baseline?: number; value?: number; verdict: 'worked' | 'partly' | 'didnt'; note?: string; measured_at?: string };
export type Proposal = {
  id: string; title: string; category: string; summary: string;
  evidence: Evidence[]; pros: string[]; cons: string[]; risks: string[];
  expected_impact: Impact | null; effort: 'S' | 'M' | 'L' | string; actions: IdeaAction[];
  source: string; status: string;
  decided_by?: string | null; decided_at?: string | null; decision_note?: string | null;
  created_at: string; expires_at?: string | null; executed_at?: string | null; check_at?: string | null;
  result_summary?: string | null; runs?: Run[]; outcome?: Outcome | null;
};
export type StepResult = { action: string; label: string; status: 'done' | 'failed' | 'skipped'; message?: string; link?: string | null; whatsapp_link?: string | null };

export const CATEGORIES: Record<string, { label: string; icon: string }> = {
  cash: { label: 'Cash', icon: 'money' },
  sales: { label: 'Sales', icon: 'deal' },
  stock: { label: 'Stock', icon: 'inventory' },
  people: { label: 'People', icon: 'hr' },
  marketing: { label: 'Marketing', icon: 'social' },
  operations: { label: 'Operations', icon: 'settings' },
  risk: { label: 'Risk', icon: 'warn' }
};
export const categoryOf = (key: string) => CATEGORIES[key] || { label: key ? key[0].toUpperCase() + key.slice(1) : 'Idea', icon: 'sparkle' };

const STATUS: Record<string, { label: string; badge: string }> = {
  pending: { label: 'Waiting for you', badge: 'pending' },
  changes_requested: { label: 'Changes asked for', badge: 'waiting' },
  approved: { label: 'Approved', badge: 'approved' },
  executing: { label: 'Running', badge: 'in_progress' },
  done: { label: 'Done', badge: 'done' },
  failed: { label: 'Some steps failed', badge: 'failed' },
  rejected: { label: 'Turned down', badge: 'rejected' },
  expired: { label: 'Expired', badge: 'expired' }
};
export const statusOf = (status: string) => STATUS[status] || { label: status, badge: '' };

const VERDICTS: Record<string, { label: string; badge: string }> = {
  worked: { label: 'Worked', badge: 'done' },
  partly: { label: 'Partly worked', badge: 'partial' },
  didnt: { label: 'Didn’t work', badge: 'failed' }
};

const EFFORT: Record<string, string> = { S: 'Quick win', M: 'Some work', L: 'Bigger job' };

export const sourceName = (source: string) => {
  if (!source || source === 'rules' || source === 'brain' || source === 'daily' || source.startsWith('app')) return 'Brain';
  return source;
};

// What each measured metric counts, so "+3 deals moving" reads right next to "+€171"
const MONEY_METRICS = ['invoices_owed', 'overdue_total', 'cash_balance', 'revenue_30d', 'won_value_30d'];
const COUNT_WORDS: Record<string, [string, string]> = {
  items_short: ['item restocked', 'items restocked'],
  deals_quiet: ['deal moving again', 'deals moving again'],
  chats_waiting: ['chat answered', 'chats answered'],
  new_leads_30d: ['new lead', 'new leads']
};

export const impactText = (impact: Impact | null | undefined) => {
  const amount = Number(impact?.amount);
  if (!impact || !Number.isFinite(amount) || amount === 0) return null;
  const metric = impact.metric || 'other';
  let value: string;
  if (MONEY_METRICS.includes(metric) || (metric === 'other' && impact.currency)) {
    value = `+${money(Math.abs(amount), impact.currency || undefined).replace(/\.00$/, '')}`;
  } else if (COUNT_WORDS[metric]) {
    const [one, many] = COUNT_WORDS[metric];
    value = `${count(Math.abs(amount))} ${Math.abs(amount) === 1 ? one : many}`;
  } else {
    value = `+${count(amount)}`;
  }
  const days = Number(impact.timeframe_days);
  return { value, when: days ? `in ${plural(days, 'day')}` : '' };
};

const confidenceWords = (value: number) => (value >= 0.7 ? 'Likely' : value >= 0.45 ? 'Fair chance' : 'A long shot');

export function Confidence({ value }: { value?: number }) {
  const n = Math.max(0, Math.min(1, Number(value) || 0));
  if (!value && value !== 0) return null;
  const filled = Math.round(n * 5);
  return (
    <span className={s.confidence} title={`The Brain is ${Math.round(n * 100)}% sure`}>
      <span className={s.meter} aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => <i key={i} className={i < filled ? s.on : ''} />)}
      </span>
      <span>{confidenceWords(n)}<span className="sr-only">, {Math.round(n * 100)}% sure</span></span>
    </span>
  );
}

export function EffortChip({ effort }: { effort?: string }) {
  if (!effort) return null;
  return <span className="chip" title="How much work it is">{EFFORT[effort] || 'Effort'} · {effort}</span>;
}

export function CategoryChip({ category }: { category: string }) {
  const meta = categoryOf(category);
  return (
    <span className={`${s.category} ${s[`cat_${category}`] || ''}`}>
      <Icon name={meta.icon} size={13} />{meta.label}
    </span>
  );
}

export function VerdictLine({ outcome }: { outcome: Outcome }) {
  const verdict = VERDICTS[outcome.verdict] || { label: outcome.verdict, badge: '' };
  return (
    <p className={s.outcome}>
      <span className={`badge ${verdict.badge}`}>{verdict.label}</span>
      <span>{outcome.note ? `${verdict.label}: ${outcome.note.replace(/^(worked|partly|didn.t work)[:.]?\s*/i, '')}` : verdict.label}</span>
    </p>
  );
}

// Plain words for each step an approval would carry out
const whenIn = (days?: number) => {
  const n = Number.isFinite(Number(days)) ? Number(days) : 1;
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  const day = new Date(Date.now() + n * 86400000);
  if (n < 7) return `on ${day.toLocaleDateString(undefined, { weekday: 'long' })}`;
  return `on ${day.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}`;
};
const GOAL_NAMES: Record<string, string> = { revenue: 'revenue', cash_in: 'money coming in', won_value: 'value of deals won', new_leads: 'new leads', bookings: 'bookings', chats: 'chats' };

export const actionWords = (action: IdeaAction, currency?: string) => {
  const p = action.params || {};
  switch (action.type) {
    case 'create_follow_up': {
      const kind = p.kind === 'call' ? 'call' : p.kind === 'meeting' ? 'meeting reminder' : 'follow-up task';
      const target = p.target_type === 'deal' ? 'on the deal' : p.target_type === 'lead' ? 'on the lead' : 'on the contact';
      return `Create a ${kind} ${target}${p.subject ? `: “${p.subject}”` : ''}, due ${whenIn(p.due_in_days)}`;
    }
    case 'create_lead':
      return `Add ${p.name || 'a new lead'}${p.company_name ? ` from ${p.company_name}` : ''} as a new lead in CRM`;
    case 'create_payment_link':
      return 'Make a payment link for the invoice, with a WhatsApp message ready to send. Nothing is sent for you.';
    case 'create_draft_reorder': {
      const lines: any[] = Array.isArray(p.lines) ? p.lines : [];
      const suppliers = new Set(lines.map((line) => line.vendor_id)).size || 1;
      return `Draft ${plural(suppliers, 'purchase order')} for ${plural(lines.length || 1, 'item')} to restock. They stay as drafts until you send them.`;
    }
    case 'create_draft_social_post':
      return `Save a draft post${p.title ? ` “${p.title}”` : ''}. Nothing is published.`;
    case 'create_goal': {
      const isMoney = ['revenue', 'cash_in', 'won_value'].includes(p.metric);
      const target = isMoney ? money(p.target, currency) : count(p.target);
      return `Set a goal of ${target} ${GOAL_NAMES[p.metric] || p.metric || ''} for ${p.month || 'this month'}${Number(p.months) > 1 ? ` and the ${Number(p.months) - 1} months after` : ''}`;
    }
    case 'assign_chat':
      return p.user_id === 'me' ? 'Give a waiting chat to you, so the customer gets a reply' : 'Give a waiting chat to a teammate';
    default:
      return action.label || 'Carry out a step in the app';
  }
};

// The card in the list
export function IdeaCard({ idea, showStatus }: { idea: Proposal; showStatus?: boolean }) {
  const impact = impactText(idea.expected_impact);
  const status = statusOf(idea.status);
  return (
    <Link href={{ pathname: '/saas/brain', query: { p: idea.id } }} shallow scroll={false} className={s.card}>
      <span className={s.cardTop}>
        <CategoryChip category={idea.category} />
        {showStatus && <span className={`badge ${status.badge}`}>{status.label}</span>}
        <span className={s.source}>From {sourceName(idea.source)}</span>
      </span>
      <span className={s.cardTitle}>{idea.title}</span>
      {idea.summary && <span className={s.cardSummary}>{idea.summary}</span>}
      <span className={s.cardFoot}>
        {impact
          ? <span className={s.impact}><strong>{impact.value}</strong>{impact.when && <span>{impact.when}</span>}</span>
          : <span className={s.impactQuiet}>{idea.actions?.length ? 'Not measured automatically' : 'Advice'}</span>}
        <span className={s.cardMeta}>
          <Confidence value={idea.expected_impact?.confidence} />
          <EffortChip effort={idea.effort} />
        </span>
      </span>
      {idea.outcome && <VerdictLine outcome={idea.outcome} />}
    </Link>
  );
}

// A link an approved step made, with copy and WhatsApp
const webOnly = (url?: string | null) => (url && /^https?:\/\//i.test(url) ? url : null);

export function LinkResult({ link: rawLink, whatsapp: rawWhatsapp }: { link?: string | null; whatsapp?: string | null }) {
  const [copied, setCopied] = useState(false);
  const link = webOnly(rawLink);
  const whatsapp = webOnly(rawWhatsapp);
  if (!link && !whatsapp) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error('Couldn’t copy', { detail: 'Select the link and copy it yourself.' });
    }
  };
  return (
    <span className={s.linkBox}>
      {link && <code className={s.linkText}>{link}</code>}
      <span className={s.linkButtons}>
        {link && <button type="button" className="small always" onClick={copy}><Icon name={copied ? 'check' : 'copy'} size={14} />{copied ? 'Copied' : 'Copy link'}</button>}
        {whatsapp && <a className="button small always" href={whatsapp} target="_blank" rel="noopener noreferrer"><Icon name="chat" size={14} />Send on WhatsApp</a>}
      </span>
    </span>
  );
}

function StepList({ steps }: { steps: StepResult[] }) {
  return (
    <ul className={s.steps}>
      {steps.map((step, n) => {
        const ok = step.status === 'done';
        return (
          <li key={n} className={ok ? s.stepOk : step.status === 'skipped' ? s.stepSkip : s.stepBad}>
            <span className={s.stepMark} aria-hidden="true"><Icon name={ok ? 'check' : step.status === 'skipped' ? 'chevron-right' : 'x'} size={14} strokeWidth={2.5} /></span>
            <span className={s.stepText}>
              <strong>{step.label}</strong>
              <span className="sr-only">{ok ? ' worked' : ' didn’t work'}</span>
              {step.message && <span>{step.message}</span>}
              <LinkResult link={step.link} whatsapp={step.whatsapp_link} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const runsAsSteps = (idea: Proposal): StepResult[] => (idea.runs || []).map((run) => {
  const action = idea.actions?.[run.position];
  return {
    action: run.action,
    label: action?.label || run.action,
    status: run.status === 'done' ? 'done' : run.status === 'skipped' ? 'skipped' : 'failed',
    message: run.status === 'done' ? run.result?.message : run.error || run.result?.message,
    link: run.result?.link,
    whatsapp_link: run.result?.whatsapp_link
  };
});

type Stage = 'view' | 'confirm' | 'changes' | 'reject';

// The heart of the page: why, pros and cons, what will happen, and the decision
export function IdeaDrawer({ idea, loading, error, canDecide, onClose, onChanged }: {
  idea: Proposal | null;
  loading?: boolean;
  error?: string;
  canDecide: boolean;
  onClose: () => void;
  onChanged: (proposal: Proposal) => void;
}) {
  const open = Boolean(idea || loading || error);
  const [stage, setStage] = useState<Stage>('view');
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState('');
  const [results, setResults] = useState<{ steps: StepResult[]; message: string } | null>(null);
  const { busy, run } = useSubmit();
  const approveButton = useRef<HTMLButtonElement>(null);
  const noteBox = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setStage('view');
    setNote('');
    setNoteError('');
    setResults(null);
  }, [idea?.id]);

  useEffect(() => {
    if (stage === 'changes' || stage === 'reject') noteBox.current?.focus();
  }, [stage]);

  const decidable = Boolean(idea && ['pending', 'changes_requested', 'approved'].includes(idea.status));
  const hasActions = Boolean(idea?.actions?.length);
  const currency = idea?.expected_impact?.currency;

  const approve = () => run(async () => {
    if (!idea) return;
    try {
      const response = await api.post(`/api/brain/proposals/${idea.id}/approve`, note.trim() ? { note: note.trim() } : {});
      const steps: StepResult[] = response.results || [];
      setResults({ steps, message: response.message || '' });
      setStage('view');
      setNote('');
      onChanged(response.proposal);
      const allDone = response.proposal?.status === 'done';
      if (allDone && steps.length) {
        celebrate({ from: approveButton.current });
        toast.success('Approved and done', { detail: response.message });
      } else if (allDone) {
        toast.success('Approved', { detail: 'Noted as advice. Nothing changed in the app.' });
      } else {
        toast.error('Some steps didn’t work', { detail: 'The steps that worked are kept. See each one below.' });
      }
    } catch (err: any) {
      toast.error('Couldn’t approve this idea', { detail: err?.message });
    }
  });

  const decide = (kind: 'reject' | 'request-changes') => run(async () => {
    if (!idea) return;
    if (kind === 'request-changes' && !note.trim()) {
      setNoteError('Say what should change, so the Brain can do better.');
      noteBox.current?.focus();
      return;
    }
    try {
      const response = await api.post(`/api/brain/proposals/${idea.id}/${kind}`, note.trim() ? { note: note.trim() } : {});
      onChanged(response.proposal);
      toast.success(kind === 'reject' ? 'Turned down' : 'Changes asked for', { detail: response.message });
      onClose();
    } catch (err: any) {
      toast.error(kind === 'reject' ? 'Couldn’t turn this down' : 'Couldn’t send your note', { detail: err?.message });
    }
  });

  const pastSteps = idea && !results ? runsAsSteps(idea) : [];
  const status = idea ? statusOf(idea.status) : null;
  const impact = impactText(idea?.expected_impact);

  let footer: JSX.Element | undefined;
  if (idea && decidable && !canDecide) {
    footer = <p className={s.readOnly}><Icon name="info" size={16} />Only owners and admins can approve ideas.</p>;
  } else if (idea && decidable && canDecide) {
    if (stage === 'view') {
      footer = (
        <div className={s.decide}>
          <button type="button" className="ghost" onClick={() => { setStage('reject'); setNoteError(''); }}>Turn down</button>
          <button type="button" onClick={() => { setStage('changes'); setNoteError(''); }}>Ask for changes</button>
          <button type="button" className="primary" onClick={() => setStage('confirm')}>
            {idea.status === 'approved' ? 'Finish running' : hasActions ? 'Approve and run' : 'Approve'}
          </button>
        </div>
      );
    } else if (stage === 'confirm') {
      footer = (
        <div className={s.confirm}>
          <p>
            <strong>{hasActions ? `Run ${plural(idea.actions.length, 'step')} now?` : 'Approve this advice?'}</strong>
            <span className="muted">{hasActions ? ' Each one runs as you, with your usual permissions.' : ' Nothing will change automatically.'}</span>
          </p>
          <label className={s.noteLabel}>
            <span className="muted small">A note for the Brain (optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="For example: good timing, the client asked last week" />
          </label>
          <div className={s.decide}>
            <button type="button" className="ghost" onClick={() => setStage('view')} disabled={busy}>Back</button>
            <button type="button" className="primary" ref={approveButton} onClick={approve} disabled={busy}>
              {busy ? 'Running…' : hasActions ? 'Yes, run it' : 'Yes, approve'}
            </button>
          </div>
        </div>
      );
    } else {
      const rejecting = stage === 'reject';
      footer = (
        <div className={s.confirm}>
          <label className={s.noteLabel}>
            <span>
              <strong>{rejecting ? 'Why not? (optional)' : 'What should change?'}</strong>
              <span className="muted small"> {rejecting ? 'The Brain learns from your reasons and won’t suggest this again for a while.' : 'The Brain reads this next time it thinks.'}</span>
            </span>
            <textarea
              ref={noteBox}
              value={note}
              maxLength={1000}
              rows={3}
              aria-invalid={noteError ? 'true' : undefined}
              onChange={(e) => { setNote(e.target.value); if (noteError) setNoteError(''); }}
              placeholder={rejecting ? 'For example: we already called them yesterday' : 'For example: wait until the end of the month'}
            />
            {noteError && <small className="error">{noteError}</small>}
          </label>
          <div className={s.decide}>
            <button type="button" className="ghost" onClick={() => { setStage('view'); setNoteError(''); }} disabled={busy}>Back</button>
            <button type="button" className={rejecting ? 'danger' : 'primary'} onClick={() => decide(rejecting ? 'reject' : 'request-changes')} disabled={busy}>
              {busy ? 'Saving…' : rejecting ? 'Turn down' : 'Send to the Brain'}
            </button>
          </div>
        </div>
      );
    }
  }

  return (
    <Drawer
      open={open}
      width={600}
      title={idea?.title || (error ? 'Idea not found' : 'Loading the idea…')}
      subtitle={idea ? (
        <span className={s.drawerSub}>
          <CategoryChip category={idea.category} />
          <span className={`badge ${status?.badge}`}>{status?.label}</span>
          <span>From {sourceName(idea.source)} · {formatDate(idea.created_at)}</span>
        </span>
      ) : undefined}
      onClose={onClose}
      footer={footer}
    >
      {loading && !idea && <div className={s.shimmerBlock} aria-busy="true"><i /><i /><i /></div>}
      {error && !idea && <p className="muted">{error}</p>}
      {idea && (
        <div className={s.detail}>
          {results && (
            <section className={s.resultBox} aria-live="polite">
              <h3>{results.steps.length ? 'What happened' : 'Approved'}</h3>
              {results.steps.length ? <StepList steps={results.steps} /> : <p className="muted">Noted as advice. Nothing changed in the app.</p>}
            </section>
          )}

          <p className={s.summary}>{idea.summary}</p>

          <div className={s.impactRow}>
            <div>
              <span className={s.label}>Expected impact</span>
              {impact
                ? <span className={s.impactBig}><strong>{impact.value}</strong> {impact.when}</span>
                : <span className={s.impactBig}><strong className={s.quiet}>{hasActions ? 'Not measured' : 'Advice'}</strong></span>}
            </div>
            <div className={s.impactSide}>
              <Confidence value={idea.expected_impact?.confidence} />
              <EffortChip effort={idea.effort} />
            </div>
          </div>

          {idea.outcome && <VerdictLine outcome={idea.outcome} />}
          {!idea.outcome && idea.check_at && idea.status === 'done' && (
            <p className="muted small">The Brain checks whether it worked on {formatDate(idea.check_at)}.</p>
          )}
          {idea.decision_note && (
            <p className={s.decisionNote}><Icon name="chat" size={14} />You said: “{idea.decision_note}”</p>
          )}

          {idea.evidence?.length > 0 && (
            <section>
              <h3>Why</h3>
              <ul className={s.evidence}>
                {idea.evidence.map((item, n) => (
                  <li key={n}>
                    <span>{item.fact}</span>
                    {item.number !== null && item.number !== undefined && <strong className="num">{Number(item.number).toLocaleString()}</strong>}
                    {item.source && <span className={s.evSource}>{item.source}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className={s.prosCons}>
            <section>
              <h3>Pros</h3>
              <ul className={s.points}>
                {(idea.pros || []).map((text, n) => <li key={n} className={s.pro}><Icon name="check" size={15} strokeWidth={2.25} />{text}</li>)}
                {!idea.pros?.length && <li className="muted">None given</li>}
              </ul>
            </section>
            <section>
              <h3>Cons</h3>
              <ul className={s.points}>
                {(idea.cons || []).map((text, n) => <li key={n} className={s.con}><Icon name="warn" size={15} />{text}</li>)}
              </ul>
            </section>
          </div>

          {idea.risks?.length > 0 && (
            <section>
              <h3>Risks</h3>
              <ul className={s.points}>
                {idea.risks.map((text, n) => <li key={n} className={s.risk}><Icon name="error" size={15} />{text}</li>)}
              </ul>
            </section>
          )}

          <section>
            <h3>{['done', 'failed'].includes(idea.status) ? 'What it did' : 'What will happen if you approve'}</h3>
            {hasActions
              ? (
                <ol className={s.willDo}>
                  {idea.actions.map((action, n) => <li key={n}><span className={s.stepNum}>{n + 1}</span>{actionWords(action, currency)}</li>)}
                </ol>
              )
              : <p className={s.advice}><Icon name="info" size={16} />This is advice. Nothing will change automatically.</p>}
          </section>

          {pastSteps.length > 0 && (
            <section>
              <h3>Results</h3>
              <StepList steps={pastSteps} />
            </section>
          )}
          {!pastSteps.length && !results && idea.result_summary && <p className="muted">{idea.result_summary}</p>}

          {idea.expires_at && ['pending', 'changes_requested'].includes(idea.status) && (
            <p className="muted small">This idea stays open until {formatDate(idea.expires_at)}.</p>
          )}
        </div>
      )}
    </Drawer>
  );
}
