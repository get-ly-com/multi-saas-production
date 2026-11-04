import Link from 'next/link';
import { DragEvent, useEffect, useRef, useState } from 'react';
import AppShell from '@/components/AppShell';
import { NextActivity, PlanForm, dueState } from '@/components/ActivityForms';
import BulkBar, { useSelection } from '@/components/BulkBar';
import { celebrate } from '@/components/Celebrate';
import CrmNav from '@/components/CrmNav';
import { DealForm, LostForm, useTeam } from '@/components/CrmForms';
import { RecordDrawer, openInDrawer } from '@/components/CrmRecord';
import EmptyState from '@/components/EmptyState';
import Skeleton, { SkeletonTable } from '@/components/Skeleton';
import { TagChips, TagFilter, tagNames, useTags } from '@/components/Tags';
import { toast } from '@/components/Toast';
import { api, formatDate, money, today } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { plural } from '@/lib/format';
import styles from '@/styles/crm.module.css';

export default function Pipeline() {
  return <AppShell><PipelineApp /></AppShell>;
}

const VIEW_KEY = 'crm-pipeline-view';

const savedView = () => {
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'board';
  } catch {
    return 'board';
  }
};

function PipelineApp() {
  const members = useTeam();
  const tags = useTags();
  const [pipelines, setPipelines] = useState<any[]>([]);
  const [pipelineId, setPipelineId] = useState('');
  const [deals, setDeals] = useState<any[]>([]);
  const [signals, setSignals] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [opened, setOpened] = useState<any>(null);
  const [over, setOver] = useState('');
  const [landed, setLanded] = useState('');
  const cards = useRef<Record<string, HTMLDivElement | null>>({});
  const [losing, setLosing] = useState<any>(null);
  const [planning, setPlanning] = useState<any>(null);
  const [dragged, setDragged] = useState('');
  const [view, setView] = useState<'board' | 'list'>('board');
  const [filters, setFilters] = useState({ search: '', owner: '', tag: '', focus: '', status: 'open' });

  const load = async () => {
    try {
      const [pipelineRows, dealRows, signalMap] = await Promise.all([
        api.get('/api/crm/pipelines'),
        api.get('/api/crm/deals'),
        api.get('/api/crm/deal-signals')
      ]);
      setPipelines(pipelineRows);
      setDeals(dealRows);
      setSignals(signalMap || {});
      setPipelineId((current) => current || pipelineRows[0]?.id || '');
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setView(savedView());
    load();
  }, []);

  const changeView = (next: 'board' | 'list') => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      // The choice lasts until the page reloads
    }
  };

  const pipeline = pipelines.find(({ id }) => id === pipelineId);
  const stages = pipeline ? [...pipeline.stages].sort((a, b) => a.position - b.position) : [];
  const set = (name: string, value: string) => setFilters({ ...filters, [name]: value });

  const matches = (deal: any) => {
    const text = filters.search.trim().toLowerCase();
    if (text && ![deal.title, deal.contact?.name, deal.company?.name].some((value) => (value || '').toLowerCase().includes(text))) return false;
    if (filters.owner === 'none' && deal.owner_id) return false;
    if (filters.owner && filters.owner !== 'none' && deal.owner_id !== filters.owner) return false;
    if (filters.tag && !(deal.tags || []).includes(filters.tag)) return false;
    const signal = signals[deal.id];
    if (filters.focus === 'stale' && !signal?.stale) return false;
    if (filters.focus === 'overdue' && !(signal?.next && dueState(signal.next) === 'overdue')) return false;
    if (filters.focus === 'nothing' && (!signal || signal.next)) return false;
    return true;
  };

  const inPipeline = deals.filter((deal) => stages.some(({ id }) => id === deal.stage_id));
  const shown = inPipeline.filter(matches);
  const listed = shown.filter((deal) => filters.status === '' || deal.stage?.kind === filters.status);
  const selection = useSelection(view === 'list' ? listed.map(({ id }) => id) : []);

  const ownerName = (id: string) => members.find(({ user_id }) => user_id === id)?.email || (id ? 'Former member' : 'Unassigned');

  // Show the move straight away, then save it. A failed save puts the card back.
  const place = (dealId: string, stage: any) =>
    setDeals((rows) => rows.map((row) => (row.id === dealId ? { ...row, stage_id: stage.id, stage: { ...row.stage, ...stage } } : row)));

  const move = async (deal: any, stageId: string) => {
    if (deal.stage_id === stageId) return;
    const target = stages.find(({ id }) => id === stageId);
    if (!target) return;
    if (target.kind === 'lost') return setLosing({ deal, stageId });
    const before = stages.find(({ id }) => id === deal.stage_id) || deal.stage;
    place(deal.id, target);
    setLanded(deal.id);
    try {
      await api.put(`/api/crm/deals/${deal.id}`, { stage_id: stageId });
      const undo = before && before.kind !== 'lost' ? {
        label: 'Undo',
        onClick: async () => {
          try {
            place(deal.id, before);
            await api.put(`/api/crm/deals/${deal.id}`, { stage_id: before.id });
          } catch (err: any) {
            toast.error('Could not undo', { detail: err.message });
          }
          await load();
        }
      } : undefined;
      if (target.kind === 'won' && before?.kind !== 'won') {
        celebrate({ from: cards.current[deal.id] });
        toast.success('Deal won', { detail: `${deal.title}, ${money(deal.value)}. Lovely work.`, action: undo });
      } else {
        toast.info(`Moved to ${target.name}`, { detail: deal.title, action: undo });
      }
      await load();
    } catch (err: any) {
      toast.error('Could not move the deal', { detail: err.message });
      await load();
    }
  };

  const dropOn = (event: DragEvent, stageId: string) => {
    event.preventDefault();
    const id = event.dataTransfer.getData('text/plain') || dragged;
    const deal = deals.find((row) => row.id === id);
    setOver('');
    setDragged('');
    if (deal) move(deal, stageId);
  };

  const lostSaved = async () => {
    toast.info('Marked as lost', { detail: 'Thanks for noting why. It makes the reports more useful.' });
    await load();
  };

  const exportCsv = () => {
    const rows = selection.selected.length ? listed.filter(({ id }) => selection.has(id)) : listed;
    downloadCsv(`deals-${today()}.csv`, [
      ['Deal', 'Stage', 'Value', 'Contact', 'Company', 'Owner', 'Expected close', 'Next activity', 'Next activity date', 'Days since last touch', 'Tags', 'Lost reason'],
      ...rows.map((deal) => {
        const signal = signals[deal.id];
        return [deal.title, deal.stage?.name, Number(deal.value || 0), deal.contact?.name, deal.company?.name, ownerName(deal.owner_id),
          deal.expected_close, signal?.next?.subject, signal?.next?.due_on, signal?.idle_days, tagNames(deal.tags, tags), deal.lost_reason];
      })
    ]);
  };

  const staleCount = inPipeline.filter((deal) => signals[deal.id]?.stale).length;
  const bulkStages = pipelines.flatMap((row) => [...row.stages].sort((a: any, b: any) => a.position - b.position)
    .map((stage: any) => ({ ...stage, pipeline: pipelines.length > 1 ? row.name : '' })));

  return (
    <div className="stack">
      <CrmNav />
      <div className="page-head">
        <div>
          <h1>Pipeline</h1>
          {!loading && pipeline && (
            <p className="muted">
              {plural(inPipeline.filter((deal) => deal.stage?.kind === 'open').length, 'open deal')} worth {money(inPipeline.filter((deal) => deal.stage?.kind === 'open').reduce((sum, deal) => sum + Number(deal.value || 0), 0))}
            </p>
          )}
        </div>
        <div className="row-actions">
          <div className="tabs" role="group" aria-label="Show as">
            <button type="button" className={view === 'board' ? 'active' : ''} onClick={() => changeView('board')}>Board</button>
            <button type="button" className={view === 'list' ? 'active' : ''} onClick={() => changeView('list')}>List</button>
          </div>
          {view === 'list' && <button disabled={!listed.length} onClick={exportCsv}>{selection.selected.length ? 'Export selected' : 'Export CSV'}</button>}
          <button className="primary" onClick={() => setAdding(true)}>New deal</button>
        </div>
      </div>

      <div className="report-filters">
        {pipelines.length > 1 && (
          <label>Pipeline
            <select value={pipelineId} onChange={(e) => setPipelineId(e.target.value)}>
              {pipelines.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
        )}
        <label>Search<input placeholder="Deal, contact or company" value={filters.search} onChange={(e) => set('search', e.target.value)} /></label>
        <label>Owner
          <select value={filters.owner} onChange={(e) => set('owner', e.target.value)}>
            <option value="">Anyone</option>
            <option value="none">Unassigned</option>
            {members.map((member) => <option key={member.user_id} value={member.user_id}>{member.email}</option>)}
          </select>
        </label>
        <TagFilter value={filters.tag} onChange={(tag) => set('tag', tag)} tags={tags} />
        <label>Show
          <select value={filters.focus} onChange={(e) => set('focus', e.target.value)}>
            <option value="">All deals</option>
            <option value="stale">Going stale{staleCount ? ` (${staleCount})` : ''}</option>
            <option value="overdue">Next step overdue</option>
            <option value="nothing">Nothing planned</option>
          </select>
        </label>
        {view === 'list' && (
          <label>Status
            <select value={filters.status} onChange={(e) => set('status', e.target.value)}>
              <option value="open">Open</option>
              <option value="won">Won</option>
              <option value="lost">Lost</option>
              <option value="">All</option>
            </select>
          </label>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {loading ? (
        view === 'board' ? (
          <div className={styles.board} style={{ gridTemplateColumns: 'repeat(4, minmax(220px, 1fr))' }} aria-busy="true">
            {[3, 2, 2, 1].map((cards, n) => (
              <div className={styles.column} key={n}>
                <div className={styles.columnHead}><Skeleton width={80} height={12} /><Skeleton width={56} height={12} /></div>
                {Array.from({ length: cards }, (_, c) => (
                  <div className={styles.dealCard} key={c} style={{ cursor: 'default' }}>
                    <Skeleton width="75%" height={13} /><Skeleton width="40%" height={12} /><Skeleton width="55%" height={10} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : <SkeletonTable rows={6} columns={6} />
      ) : !pipeline ? (
        <div className="card">
          <EmptyState icon="deal" title="No pipeline yet" line="Set up the stages your deals move through, and the board appears here."
            action={{ label: 'Set up a pipeline', href: '/saas/crm/settings' }} />
        </div>
      ) : view === 'board' && inPipeline.length === 0 ? (
        <div className="card">
          <EmptyState icon="deal" title="No deals yet" line="Add your first deal and drag it along as it moves forward."
            action={{ label: 'New deal', onClick: () => setAdding(true) }} />
        </div>
      ) : view === 'board' ? (
        <div className={styles.board} style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(220px, 1fr))` }}>
          {stages.map((stage) => {
            const stageDeals = shown.filter((deal) => deal.stage_id === stage.id);
            const total = stageDeals.reduce((sum, deal) => sum + Number(deal.value || 0), 0);
            const isOver = over === stage.id && !!dragged;
            return (
              <div
                className={`${styles.column} ${stage.kind === 'won' ? styles.won : stage.kind === 'lost' ? styles.lost : ''} ${isOver ? styles.isOver : ''}`}
                key={stage.id}
                aria-label={`${stage.name}, ${plural(stageDeals.length, 'deal')}, ${money(total)}`}
                onDragEnter={(event) => { event.preventDefault(); setOver(stage.id); }}
                onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; if (over !== stage.id) setOver(stage.id); }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver((current) => (current === stage.id ? '' : current));
                }}
                onDrop={(event) => dropOn(event, stage.id)}
              >
                <div className={styles.columnHead}>
                  <span className={styles.columnName}><span className={styles.dot} aria-hidden="true" /><span>{stage.name}</span></span>
                  <span>
                    <span className={styles.columnTotal}>{money(total)}</span>
                    <span className={styles.columnCount}> · {stageDeals.length}</span>
                  </span>
                </div>
                {stageDeals.length === 0 && (
                  <div className={styles.dropHint}>
                    {isOver ? (stage.kind === 'won' ? 'Drop to mark it won' : stage.kind === 'lost' ? 'Drop to mark it lost' : 'Drop here') : 'No deals here'}
                  </div>
                )}
                {stageDeals.map((deal) => {
                  const signal = signals[deal.id];
                  return (
                    <div
                      key={deal.id}
                      ref={(node) => { cards.current[deal.id] = node; }}
                      className={`${styles.dealCard} ${signal?.stale ? styles.isStale : ''} ${dragged === deal.id ? styles.isDragging : ''} ${landed === deal.id ? styles.justLanded : ''}`}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData('text/plain', deal.id);
                        event.dataTransfer.effectAllowed = 'move';
                        setDragged(deal.id);
                      }}
                      onDragEnd={() => { setDragged(''); setOver(''); }}
                      onAnimationEnd={() => landed === deal.id && setLanded('')}
                    >
                      <Link href={`/saas/crm/deal/${deal.id}`} className={styles.dealTitle} draggable={false} onClick={openInDrawer(() => setOpened(deal))}>{deal.title}</Link>
                      <div className={styles.dealMeta}>
                        <span className={styles.dealValue}>{money(deal.value)}</span>
                        {deal.contact && <span>{deal.contact.name}</span>}
                      </div>
                      {deal.expected_close && (
                        <div className={styles.dealMeta}>
                          <span className={deal.expected_close < today() && stage.kind === 'open' ? 'late' : ''}>Closes {formatDate(deal.expected_close)}</span>
                        </div>
                      )}
                      <TagChips ids={deal.tags} tags={tags} />
                      {stage.kind === 'open' && (
                        <div className={styles.dealMeta}>
                          {signal?.next
                            ? <NextActivity activity={signal.next} />
                            : <button type="button" className="link" onClick={() => setPlanning(deal)}>Plan an activity</button>}
                        </div>
                      )}
                      {signal?.stale && <div className="stale-note">No progress for {signal.idle_days} days</div>}
                      <select className={styles.dealStage} aria-label={`Stage of ${deal.title}`} value={deal.stage_id} onChange={(e) => move(deal, e.target.value)}>
                        {stages.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                      </select>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      ) : (
        <>
          <BulkBar entity="deal" selected={selection.selected} onClear={selection.clear} tags={tags} members={members} stages={bulkStages}
            onDone={async (message) => { toast.success('Done', { detail: message }); await load(); }} />
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="pick"><input type="checkbox" aria-label="Select all shown" checked={selection.all} onChange={selection.toggleAll} /></th>
                  <th>Deal</th><th>Stage</th><th className="num">Value</th><th>Contact</th><th>Owner</th><th>Close</th><th>Next activity</th><th>Tags</th>
                </tr>
              </thead>
              <tbody>
                {listed.length === 0 && (
                  <tr><td colSpan={9}>
                    {inPipeline.length
                      ? <EmptyState compact icon="search" title="No deals match" line="Try a different search or clear a filter." />
                      : <EmptyState compact icon="deal" title="No deals yet" line="Add your first deal to start your pipeline." action={{ label: 'New deal', onClick: () => setAdding(true) }} />}
                  </td></tr>
                )}
                {listed.map((deal) => {
                  const signal = signals[deal.id];
                  return (
                    <tr key={deal.id} className={`${selection.has(deal.id) ? 'picked' : ''} ${signal?.stale ? 'stale' : ''}`}>
                      <td className="pick"><input type="checkbox" aria-label={`Select ${deal.title}`} checked={selection.has(deal.id)} onChange={() => selection.toggle(deal.id)} /></td>
                      <td className="wrap">
                        <Link href={`/saas/crm/deal/${deal.id}`} className={styles.rowOpen} onClick={openInDrawer(() => setOpened(deal))}>{deal.title}</Link>
                        {signal?.stale && <div className="stale-note">No progress for {signal.idle_days} days</div>}
                      </td>
                      <td>{deal.stage?.name}{deal.stage?.kind === 'lost' && deal.lost_reason ? <div className="muted">{deal.lost_reason}</div> : null}</td>
                      <td className="num">{money(deal.value)}</td>
                      <td className="wrap">{deal.contact ? <Link href={`/saas/crm/contact/${deal.contact.id}`}>{deal.contact.name}</Link> : '—'}</td>
                      <td>{ownerName(deal.owner_id)}</td>
                      <td><span className={deal.expected_close && deal.expected_close < today() && deal.stage?.kind === 'open' ? 'late' : ''}>{formatDate(deal.expected_close)}</span></td>
                      <td className="wrap">
                        {deal.stage?.kind !== 'open' ? '—' : signal?.next
                          ? <NextActivity activity={signal.next} />
                          : <button type="button" className="link" onClick={() => setPlanning(deal)}>Plan an activity</button>}
                      </td>
                      <td className="wrap"><TagChips ids={deal.tags} tags={tags} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {adding && <DealForm onClose={() => setAdding(false)} onSaved={load} />}
      {losing && <LostForm deal={losing.deal} stageId={losing.stageId} onClose={() => setLosing(null)} onSaved={lostSaved} />}
      {planning && <PlanForm links={{ deal_id: planning.id }} onClose={() => setPlanning(null)} onSaved={async () => { toast.success('Planned', { detail: planning.title }); await load(); }} />}
      <RecordDrawer kind="deal" record={opened} onClose={() => setOpened(null)} onChanged={load} ownerName={ownerName} tags={tags} />
    </div>
  );
}
