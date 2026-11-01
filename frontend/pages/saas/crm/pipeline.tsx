import Link from 'next/link';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import CrmNav from '@/components/CrmNav';
import { DealForm, LostForm } from '@/components/CrmForms';
import { api, formatDate, money, today } from '@/lib/api';

export default function Pipeline() {
  return <AppShell><PipelineApp /></AppShell>;
}

function PipelineApp() {
  const [pipelines, setPipelines] = useState<any[]>([]);
  const [pipelineId, setPipelineId] = useState('');
  const [deals, setDeals] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [losing, setLosing] = useState<any>(null);
  const [dragged, setDragged] = useState('');

  const load = async () => {
    try {
      const [pipelineRows, dealRows] = await Promise.all([api.get('/api/crm/pipelines'), api.get('/api/crm/deals')]);
      setPipelines(pipelineRows);
      setDeals(dealRows);
      setPipelineId((current) => current || pipelineRows[0]?.id || '');
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

  const pipeline = pipelines.find(({ id }) => id === pipelineId);
  const stages = pipeline ? [...pipeline.stages].sort((a, b) => a.position - b.position) : [];

  const move = async (deal: any, stageId: string) => {
    if (deal.stage_id === stageId) return;
    if (stages.find(({ id }) => id === stageId)?.kind === 'lost') return setLosing({ deal, stageId });
    try {
      await api.put(`/api/crm/deals/${deal.id}`, { stage_id: stageId });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="stack">
      <CrmNav />
      <div className="page-head">
        <h1>Pipeline</h1>
        <button className="primary" onClick={() => setAdding(true)}>New deal</button>
      </div>

      {pipelines.length > 1 && (
        <div className="report-filters">
          <label>Pipeline
            <select value={pipelineId} onChange={(e) => setPipelineId(e.target.value)}>
              {pipelines.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
        </div>
      )}

      {error && <p className="error">{error}</p>}

      {loading ? <p className="empty">Loading…</p> : (
        <div className="board" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(190px, 1fr))` }}>
          {stages.map((stage) => {
            const stageDeals = deals.filter((deal) => deal.stage_id === stage.id);
            const total = stageDeals.reduce((sum, deal) => sum + Number(deal.value || 0), 0);
            return (
              <div
                className="column"
                key={stage.id}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => {
                  const deal = deals.find(({ id }) => id === dragged);
                  if (deal) move(deal, stage.id);
                  setDragged('');
                }}
              >
                <div className="column-head"><span>{stage.name}</span><span>{money(total)}</span></div>
                {stageDeals.map((deal) => (
                  <div className="deal" key={deal.id} draggable onDragStart={() => setDragged(deal.id)}>
                    <div className="deal-title"><Link href={`/saas/crm/deal/${deal.id}`}>{deal.title}</Link></div>
                    <div className="deal-meta">{money(deal.value)}{deal.contact ? ` · ${deal.contact.name}` : ''}</div>
                    {deal.expected_close && (
                      <div className="deal-meta">
                        <span className={deal.expected_close < today() && stage.kind === 'open' ? 'late' : ''}>Close {formatDate(deal.expected_close)}</span>
                      </div>
                    )}
                    <select aria-label={`Stage of ${deal.title}`} value={deal.stage_id} onChange={(e) => move(deal, e.target.value)}>
                      {stages.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {adding && <DealForm onClose={() => setAdding(false)} onSaved={load} />}
      {losing && <LostForm deal={losing.deal} stageId={losing.stageId} onClose={() => setLosing(null)} onSaved={load} />}
    </div>
  );
}
