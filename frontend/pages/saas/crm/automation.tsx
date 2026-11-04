import Link from 'next/link';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import AutomationForm, { Starters, blankRule, eventFor } from '@/components/AutomationForm';
import CrmNav from '@/components/CrmNav';
import { api, formatDate } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

const ACTION_NAMES: Record<string, string> = { task: 'Task', alert: 'Alert', assign: 'Assign' };
const statusBadge: Record<string, string> = { done: 'won', failed: 'lost', skipped: '' };
const statusName: Record<string, string> = { done: 'Done', failed: 'Failed', skipped: 'Skipped' };

export default function Automation() {
  return <AppShell><AutomationApp /></AppShell>;
}

function AutomationApp() {
  const [data, setData] = useState<any>(null);
  const [editing, setEditing] = useState<any>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    try {
      setData(await api.get('/api/crm/automations'));
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const { busy, run: once } = useSubmit();
  // One action at a time, so a double click cannot repeat it
  const run = (action: () => Promise<unknown>, done = '') => once(async () => {
    try {
      await action();
      await load();
      setNotice(done);
    } catch (err: any) {
      setNotice('');
      setError(err.message);
    }
  });

  const remove = (rule: any) => {
    if (window.confirm(`Delete ${rule.name}? Tasks it already created stay.`)) {
      run(() => api.delete(`/api/crm/automations/${rule.id}`), 'Rule deleted.');
    }
  };

  const runNow = () => once(async () => {
    try {
      const { handled } = await api.post('/api/crm/automations/run', {});
      await load();
      setNotice(`Checked now. ${handled} ${handled === 1 ? 'record' : 'records'} matched a time based rule.`);
    } catch (err: any) {
      setNotice('');
      setError(err.message);
    }
  });

  return (
    <div className="stack">
      <CrmNav />
      <div className="page-head">
        <h1>Automation</h1>
        <div className="row-actions">
          <button disabled={busy} onClick={runNow}>Check now</button>
          <button className="primary" onClick={() => setEditing(blankRule)}>New rule</button>
        </div>
      </div>

      <p className="muted">Rules create tasks, send alerts and assign records for you. Alerts show under Alerts at the top of the page; nothing is emailed yet. Only owners and admins can change rules.</p>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      {data && (
        <>
          <div className="card stack">
            <h2>Start from an example</h2>
            <Starters onChoose={setEditing} />
          </div>

          <div className="card table-wrap">
            <table>
              <thead><tr><th>Rule</th><th>When</th><th>Does</th><th>Last ran</th><th className="num">30 days</th><th /></tr></thead>
              <tbody>
                {data.rules.length === 0 && <tr><td colSpan={6} className="empty">No rules yet</td></tr>}
                {data.rules.map((rule: any) => (
                  <tr key={rule.id}>
                    <td className="wrap">{rule.name}{!rule.enabled && <span className="badge"> off</span>}</td>
                    <td className="wrap">
                      {eventFor(rule.event)?.name}
                      {rule.event === 'deal_stage' && !rule.stage_id && <span className="late"> (its stage was deleted)</span>}
                    </td>
                    <td>{Array.from(new Set(rule.actions.map((action: any) => ACTION_NAMES[action.type]))).join(', ')}</td>
                    <td>{rule.last_run ? formatDate(rule.last_run) : 'Not yet'}</td>
                    <td className="num">{rule.runs_30}{Number(rule.failed_30) > 0 && <span className="late"> ({rule.failed_30} failed)</span>}</td>
                    <td>
                      <div className="row-actions">
                        <button onClick={() => run(() => api.post(`/api/crm/automations/${rule.id}/enabled`, { enabled: !rule.enabled }))}>{rule.enabled ? 'Turn off' : 'Turn on'}</button>
                        <button onClick={() => setEditing(rule)}>Edit</button>
                        <button className="danger" onClick={() => remove(rule)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h2>Task reminders</h2>
            <label className="check">
              <input
                type="checkbox"
                checked={Boolean(data.task_reminders)}
                onChange={(e) => run(() => api.post('/api/crm/automations/task-reminders', { enabled: e.target.checked }))}
              />
              Send each person one alert a day when they have tasks due or overdue
            </label>
          </div>

          <div className="card table-wrap">
            <h2>Recent runs</h2>
            <table>
              <thead><tr><th>Rule</th><th>Record</th><th>Result</th><th>When</th></tr></thead>
              <tbody>
                {data.runs.length === 0 && <tr><td colSpan={4} className="empty">Nothing has run yet</td></tr>}
                {data.runs.map((item: any) => (
                  <tr key={item.id}>
                    <td className="wrap">{item.rule_name}</td>
                    <td className="wrap">{item.link ? <Link href={item.link}>{item.record_name}</Link> : item.record_name}</td>
                    <td className="wrap"><span className={`badge ${statusBadge[item.status]}`}>{statusName[item.status]}</span>{item.error && <span className="muted"> {item.error}</span>}</td>
                    <td>{formatDate(item.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {editing && <AutomationForm initial={editing} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}
