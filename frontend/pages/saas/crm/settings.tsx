import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import CrmNav from '@/components/CrmNav';
import { toast } from '@/components/Toast';
import CustomFieldSettings from '@/components/CustomFieldSettings';
import EmailSettings from '@/components/EmailSettings';
import LeadSettings from '@/components/LeadSettings';
import { LostReasonSettings, TagSettings } from '@/components/TagSettings';
import { api } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

const blankPipeline = {
  name: '',
  stages: [
    { name: 'New', probability: 10, kind: 'open' },
    { name: 'Won', probability: 100, kind: 'won' },
    { name: 'Lost', probability: 0, kind: 'lost' }
  ]
};

export default function Settings() {
  return <AppShell><SettingsApp /></AppShell>;
}

function SettingsApp() {
  const [pipelines, setPipelines] = useState<any[]>([]);
  const [editing, setEditing] = useState<any>(null);
  const [error, setError] = useState('');
  // Finished actions show as a toast
  const setNotice = (message: string) => { if (message) toast.success(message.replace(/\.$/, '')); };

  const load = async () => {
    try {
      setPipelines(await api.get('/api/crm/pipelines'));
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const open = (pipeline: any) => {
    setError('');
    setEditing({ ...pipeline, stages: [...pipeline.stages].sort((a: any, b: any) => a.position - b.position) });
  };

  const setStage = (index: number, field: string, value: unknown) =>
    setEditing({ ...editing, stages: editing.stages.map((stage: any, i: number) => (i === index ? { ...stage, [field]: value } : stage)) });

  const moveStage = (index: number, by: number) => {
    const stages = [...editing.stages];
    const [stage] = stages.splice(index, 1);
    stages.splice(index + by, 0, stage);
    setEditing({ ...editing, stages });
  };

  const { busy, run } = useSubmit();
  const save = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        const stages = editing.stages.map((stage: any) => ({ ...stage, rot_days: stage.kind === 'open' ? stage.rot_days ?? '' : '' }));
        await api.post('/api/crm/pipelines', { id: editing.id, name: editing.name, stages });
        setEditing(null);
        setNotice('Pipeline saved.');
        await load();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  const remove = (pipeline: any) => run(async () => {
    if (!window.confirm(`Delete ${pipeline.name}?`)) return;
    try {
      await api.delete(`/api/crm/pipelines/${pipeline.id}`);
      setNotice('Pipeline deleted.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  });

  return (
    <div className="stack">
      <CrmNav />
      <div className="page-head">
        <h1>CRM settings</h1>
        <button className="primary" onClick={() => open(blankPipeline)}>New pipeline</button>
      </div>

      <p className="muted">Each stage's chance of winning drives the weighted forecast. A deal goes stale when nothing has happened on it for the stage's number of days (14 if left blank); stale deals are marked on the pipeline. Only owners and admins can change these settings.</p>

      {error && <p className="error">{error}</p>}

      {pipelines.map((pipeline) => (
        <div className="card table-wrap" key={pipeline.id}>
          <div className="page-head">
            <h2>{pipeline.name}{pipeline.is_default && <span className="badge"> default</span>}</h2>
            <div className="row-actions">
              <button onClick={() => open(pipeline)}>Edit</button>
              {!pipeline.is_default && <button disabled={busy} className="danger" onClick={() => remove(pipeline)}>Delete</button>}
            </div>
          </div>
          <table>
            <thead><tr><th>Stage</th><th>Type</th><th className="num">Chance</th><th className="num">Stale after</th></tr></thead>
            <tbody>
              {[...pipeline.stages].sort((a: any, b: any) => a.position - b.position).map((stage: any) => (
                <tr key={stage.id}><td>{stage.name}</td><td>{stage.kind}</td><td className="num">{stage.probability}%</td><td className="num">{stage.kind === 'open' ? `${stage.rot_days || 14} days` : '—'}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {editing && (
        <form className="card" onSubmit={save}>
          <h2>{editing.id ? `Edit ${editing.name}` : 'New pipeline'}</h2>
          <label>Name<input required value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
          <div className="stage-line with-stale stage-line-head muted"><span>Stage</span><span>Type</span><span>Chance %</span><span>Stale after days</span></div>
          <div className="lines">
            {editing.stages.map((stage: any, index: number) => (
              <div className="stage-line with-stale" key={stage.id || index}>
                <input required aria-label="Stage name" value={stage.name} onChange={(e) => setStage(index, 'name', e.target.value)} />
                <select aria-label="Stage type" value={stage.kind} onChange={(e) => setStage(index, 'kind', e.target.value)}>
                  <option value="open">Open</option>
                  <option value="won">Won</option>
                  <option value="lost">Lost</option>
                </select>
                <input required aria-label="Chance of winning" type="number" min="0" max="100" value={stage.probability} onChange={(e) => setStage(index, 'probability', e.target.value)} />
                <input aria-label="Days before a deal goes stale" title="Days before a deal goes stale (blank means 14)" placeholder="14 days" type="number" min="1" max="365" disabled={stage.kind !== 'open'} value={stage.kind === 'open' ? stage.rot_days ?? '' : ''} onChange={(e) => setStage(index, 'rot_days', e.target.value)} />
                <button type="button" aria-label="Move up" disabled={index === 0} onClick={() => moveStage(index, -1)}>↑</button>
                <button type="button" aria-label="Move down" disabled={index === editing.stages.length - 1} onClick={() => moveStage(index, 1)}>↓</button>
                <button type="button" aria-label="Remove stage" onClick={() => setEditing({ ...editing, stages: editing.stages.filter((_: any, i: number) => i !== index) })}>×</button>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => setEditing({ ...editing, stages: [...editing.stages, { name: '', probability: 50, kind: 'open' }] })}>Add stage</button>
          <div className="form-actions">
            <button disabled={busy} className="primary">Save pipeline</button>
            <button type="button" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form>
      )}

      <TagSettings />
      <LostReasonSettings />
      <LeadSettings />
      <EmailSettings />
      <CustomFieldSettings />
    </div>
  );
}
