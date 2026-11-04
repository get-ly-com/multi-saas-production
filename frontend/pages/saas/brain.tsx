import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import AppShell, { useAccount } from '@/components/AppShell';
import BrainConnect from '@/components/BrainConnect';
import { ForecastCard, WhatIf } from '@/components/BrainGlance';
import { IdeaCard, IdeaDrawer, Proposal, categoryOf } from '@/components/BrainIdea';
import EmptyState from '@/components/EmptyState';
import Icon from '@/components/Icon';
import Skeleton from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api, queryId } from '@/lib/api';
import { forget } from '@/lib/cache';
import { plural } from '@/lib/format';
import useSubmit from '@/lib/useSubmit';
import s from '@/styles/brain.module.css';

// The Brain: ideas for growing the business, each with its evidence, pros, cons and risks.
// AI proposes, a person approves. Only owners and admins decide; everyone else can read.
// ?p=<id> opens one idea (the bell, the review links and the MCP tools link here).

export default function BrainPage() {
  return <AppShell><Brain /></AppShell>;
}

type Tab = 'review' | 'done' | 'rejected' | 'all';
const TABS: { key: Tab; label: string; statuses?: string[] }[] = [
  { key: 'review', label: 'To review', statuses: ['pending', 'changes_requested'] },
  { key: 'done', label: 'Approved and done', statuses: ['approved', 'executing', 'done', 'failed'] },
  { key: 'rejected', label: 'Turned down', statuses: ['rejected'] },
  { key: 'all', label: 'All' }
];

type Learning = {
  category: string; approved: number; rejected: number; changes_requested: number;
  worked: number; partly: number; didnt: number;
  recent_notes?: { title?: string; note?: string; decision?: string; at?: string }[] | null;
};
type History = { decisions: Proposal[]; learnings: Learning[] };

const minutesIn = (message: string) => Number((message.match(/(\d+)\s+minute/) || [])[1]) || 10;

function Brain() {
  const account = useAccount();
  const router = useRouter();
  const role = account?.role || '';
  const canDecide = role === 'owner' || role === 'admin';
  const canThink = Boolean(role) && role !== 'viewer';

  const [ideas, setIdeas] = useState<Proposal[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState<Tab>('review');
  const [history, setHistory] = useState<History | null>(null);
  const [restUntil, setRestUntil] = useState(0);
  const [restNote, setRestNote] = useState('');
  const thinking = useSubmit();

  const load = useCallback(async () => {
    try {
      const rows = await api.get('/api/brain/proposals?status=all&limit=200');
      setIdeas(Array.isArray(rows) ? rows : []);
      setLoadError('');
    } catch (err: any) {
      setIdeas((now) => now || []);
      setLoadError(err?.status === 403 ? 'You don’t have access to the Brain in this company.' : 'We couldn’t load the ideas just now. Try again in a minute.');
    }
  }, []);

  const loadHistory = useCallback(() => {
    api.get('/api/brain/history?limit=100').then(setHistory).catch(() => setHistory((now) => now || { decisions: [], learnings: [] }));
  }, []);

  useEffect(() => {
    if (!account?.tenantId) return;
    load();
    loadHistory();
  }, [account?.tenantId]);

  // The rest after a think wears off on its own
  useEffect(() => {
    if (!restUntil) return;
    const timer = setTimeout(() => { setRestUntil(0); setRestNote(''); }, Math.max(restUntil - Date.now(), 0));
    return () => clearTimeout(timer);
  }, [restUntil]);

  // The open idea comes from the address, so a link to ?p=<id> opens it
  const openId = typeof router.query.p === 'string' ? router.query.p : '';
  const [fetched, setFetched] = useState<{ id: string; idea: Proposal | null; error: string } | null>(null);
  const listed = ideas?.find((idea) => idea.id === openId) || null;

  useEffect(() => {
    if (!openId || !account?.tenantId || ideas === null || listed) return;
    if (fetched?.id === openId) return;
    setFetched({ id: openId, idea: null, error: '' });
    api.get(`/api/brain/proposals/${queryId(openId)}`)
      .then((idea) => setFetched({ id: openId, idea, error: '' }))
      .catch((err) => setFetched({ id: openId, idea: null, error: err?.status === 404 ? 'This idea isn’t here any more. It may belong to another company.' : err?.message || 'We couldn’t open this idea.' }));
  }, [openId, account?.tenantId, ideas, listed]);

  const openIdea = listed || (fetched?.id === openId ? fetched.idea : null);
  const openError = !listed && fetched?.id === openId ? fetched.error : '';
  const openLoading = Boolean(openId) && !openIdea && !openError;

  const closeIdea = () => {
    const { p, ...rest } = router.query;
    router.replace({ pathname: router.pathname, query: rest }, undefined, { shallow: true, scroll: false });
  };

  const changed = (proposal: Proposal) => {
    if (!proposal?.id) return;
    forget('/api/brain');
    setIdeas((now) => {
      const list = now || [];
      return list.some((idea) => idea.id === proposal.id)
        ? list.map((idea) => (idea.id === proposal.id ? proposal : idea))
        : [proposal, ...list];
    });
    if (fetched?.id === proposal.id) setFetched({ id: proposal.id, idea: proposal, error: '' });
    loadHistory();
  };

  const think = () => thinking.run(async () => {
    try {
      const result = await api.post('/api/brain/think', {});
      forget('/api/brain');
      await load();
      const created = result.created?.length || 0;
      if (created) {
        setTab('review');
        toast.success(`${plural(created, 'new idea')} to review`, { detail: result.forecast_warning || 'Open one to see the reasons behind it.' });
      } else {
        toast.info('No new ideas this time', { detail: result.message || 'Everything the Brain found is already on your list.' });
      }
    } catch (err: any) {
      if (err?.status === 429) {
        const minutes = minutesIn(err.message || '');
        setRestUntil(Date.now() + minutes * 60000);
        setRestNote(err.message || `The Brain thought a few minutes ago. Try again in ${plural(minutes, 'minute')}.`);
      } else {
        toast.error('The Brain couldn’t think just now', { detail: err?.message });
      }
    }
  });

  const counts = useMemo(() => {
    const out: Record<Tab, number> = { review: 0, done: 0, rejected: 0, all: ideas?.length || 0 };
    for (const idea of ideas || []) {
      for (const t of TABS) if (t.statuses?.includes(idea.status)) out[t.key] += 1;
    }
    return out;
  }, [ideas]);

  const current = TABS.find((t) => t.key === tab)!;
  const shown = (ideas || []).filter((idea) => !current.statuses || current.statuses.includes(idea.status));
  const resting = restUntil > Date.now();

  return (
    <div className={s.page}>
      <header className="page-head">
        <div>
          <h1 className={s.title}><span className={s.titleMark} aria-hidden="true"><Icon name="brain" size={20} /></span>Brain</h1>
          <p className="muted">Ideas for growing the business, based on your own numbers. Nothing happens until you approve.</p>
        </div>
        {canThink && (
          <button type="button" className={`primary ${thinking.busy ? s.thinkingButton : ''}`} onClick={think} disabled={thinking.busy || resting}>
            <Icon name="sparkle" size={16} />{thinking.busy ? 'Thinking…' : 'Think now'}
          </button>
        )}
      </header>

      {restNote && <p className={s.rest}><Icon name="clock" size={15} />{restNote} The Brain also checks your business every morning on its own.</p>}

      <div className={s.layout}>
        <div className={s.main}>
          <div className="tabs" role="tablist" aria-label="Ideas">
            {TABS.map((t) => (
              <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`always ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
                {t.label}{ideas && counts[t.key] > 0 && <span className={s.tabCount}>{counts[t.key]}</span>}
              </button>
            ))}
          </div>

          {!canDecide && account && (
            <p className={s.readOnlyBanner}><Icon name="info" size={15} />Only owners and admins can approve ideas. You can read every idea and the reasons behind it.</p>
          )}
          {loadError && <p className="error">{loadError}</p>}

          {thinking.busy && (
            <div className={s.thinkingBox} aria-live="polite">
              <p><Icon name="brain" size={16} />The Brain is reading your numbers…</p>
              <div className={s.shimmerCard} /><div className={s.shimmerCard} />
            </div>
          )}

          {ideas === null && (
            <div className={s.list} aria-busy="true">
              {[0, 1, 2].map((n) => (
                <div key={n} className={s.cardSkeleton}>
                  <Skeleton width={90} height={20} radius={999} />
                  <Skeleton width="75%" height={16} />
                  <Skeleton width="95%" height={12} />
                  <Skeleton width={140} height={26} />
                </div>
              ))}
            </div>
          )}

          {ideas !== null && shown.length > 0 && (
            <div className={s.list}>
              {shown.map((idea) => <IdeaCard key={idea.id} idea={idea} showStatus={tab !== 'review'} />)}
            </div>
          )}

          {ideas !== null && !shown.length && !thinking.busy && !loadError && (
            <div className="card">
              {tab === 'review' || tab === 'all' ? (
                <EmptyState
                  icon="brain"
                  title="No ideas waiting"
                  line="The Brain checks your business every morning."
                  action={canThink && !resting ? { label: 'Think now', onClick: think } : undefined}
                />
              ) : tab === 'done' ? (
                <EmptyState icon="check" title="Nothing approved yet" line="Ideas you approve show here, with what they did and whether they worked." />
              ) : (
                <EmptyState icon="x" title="Nothing turned down" line="When you turn an idea down, your reason helps the Brain suggest better ones." />
              )}
            </div>
          )}
        </div>

        <aside className={s.side} aria-label="Your business at a glance">
          <h2 className={s.sideTitle}>Your business at a glance</h2>
          <ForecastCard />
          <WhatIf />
          <Memory history={history} />
        </aside>
      </div>

      <BrainConnect />

      <IdeaDrawer
        idea={openIdea}
        loading={openLoading}
        error={openError}
        canDecide={canDecide}
        onClose={closeIdea}
        onChanged={changed}
      />
    </div>
  );
}

// What the Brain has learned from this company's decisions, in plain words
function Memory({ history }: { history: History | null }) {
  const rows = (history?.learnings || [])
    .map((row) => ({
      ...row,
      decided: Number(row.approved || 0) + Number(row.rejected || 0) + Number(row.changes_requested || 0),
      measured: Number(row.worked || 0) + Number(row.partly || 0) + Number(row.didnt || 0)
    }))
    .filter((row) => row.decided > 0)
    .sort((a, b) => b.decided - a.decided);

  return (
    <section className={`card ${s.glanceCard}`} aria-labelledby="memory-title">
      <div className={s.glanceHead}><h3 id="memory-title">What the Brain has learned</h3></div>
      {!history && <><Skeleton width="80%" height={12} /><Skeleton width="60%" height={12} style={{ marginTop: 8 }} /></>}
      {history && !rows.length && (
        <p className="muted small">Nothing yet. Each idea you approve or turn down teaches the Brain what matters to you.</p>
      )}
      {rows.length > 0 && (
        <ul className={s.memory}>
          {rows.map((row) => {
            const name = categoryOf(row.category).label.toLowerCase();
            const rate = row.decided ? Math.round((Number(row.approved) / row.decided) * 100) : 0;
            const note = (row.recent_notes || []).find((item) => item?.note);
            return (
              <li key={row.category}>
                <div className={s.memoryHead}>
                  <span className={s.memoryName}><Icon name={categoryOf(row.category).icon} size={14} />{categoryOf(row.category).label}</span>
                  <span className={`num muted small`}>{rate}% approved</span>
                </div>
                <span className={s.rateBar} aria-hidden="true"><i style={{ width: `${rate}%` }} /></span>
                <p className="small">
                  You approved {row.approved} of {plural(row.decided, `${name} idea`)}.
                  {' '}{row.measured
                    ? `${row.worked} of ${row.measured} measured so far worked${Number(row.partly) ? `, ${row.partly} partly` : ''}.`
                    : 'None measured yet.'}
                </p>
                {note && <p className={`muted small ${s.memoryNote}`}>Your last reason: “{note.note}”</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
