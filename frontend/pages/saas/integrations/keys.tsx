import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import EmptyState from '@/components/EmptyState';
import Icon from '@/components/Icon';
import IntegrationsNav, { IntegrationsLoading, OnlyManagers, ShowOnce, dateTime } from '@/components/IntegrationsNav';
import Modal from '@/components/Modal';
import { api } from '@/lib/api';
import { toast } from '@/components/Toast';
import useSubmit from '@/lib/useSubmit';
import s from '@/styles/settings.module.css';

export default function ApiKeys() {
  return <AppShell><KeysApp /></AppShell>;
}

function KeysApp() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'read' | 'write'>('read');
  const [created, setCreated] = useState<{ name: string; key: string; scope: string } | null>(null);
  const [log, setLog] = useState<any>(null);
  const { busy, run } = useSubmit();

  const load = async () => {
    try {
      setData(await api.get('/api/integration/overview'));
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (!data) return <div className="stack"><IntegrationsNav />{error ? <p className="error">{error}</p> : <IntegrationsLoading />}</div>;
  if (!data.is_manager) return <div className="stack"><IntegrationsNav /><div className="page-head"><h1>API keys</h1></div><OnlyManagers /></div>;

  const create = (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        const result = await api.post('/api/integration/api-keys/scoped', { name, scope });
        setCreated({ name, key: result.key, scope });
        setName('');
        setScope('read');
        await load();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  const showLog = async (row: any) => {
    try {
      setLog({ key: row, ...(await api.get(`/api/integration/api-keys/${row.id}/requests`)) });
    } catch (err: any) {
      setError(err.message);
    }
  };

  const revoke = (row: any) => run(async () => {
    if (!window.confirm(`Revoke ${row.name}? Anything using it stops working straight away.`)) return;
    try {
      await api.delete(`/api/integration/api-keys/${row.id}`);
      await load();
      toast.success('Key revoked', { detail: `${row.name} no longer works.` });
    } catch (err: any) {
      setError(err.message);
    }
  });

  return (
    <div className="stack">
      <IntegrationsNav />
      <div className="page-head">
        <div>
          <h1>API keys</h1>
          <p className="muted">Let another app read your records, with a key you can revoke at any time.</p>
        </div>
        <Link className="button" href="/saas/integrations/api"><Icon name="external" size={15} />API guide</Link>
      </div>
      {error && <p className="error">{error}</p>}

      <div className="card">
        <div className={s.section}>
          <div className={s.sectionText}>
            <h2>Make a key</h2>
            <p>A key can read contacts, leads, invoices, stock items and deals. A key that can also write may add contacts and leads, nothing else. It stops working if you revoke it, or if the person who made it is no longer an owner or admin.</p>
          </div>
          <form className={s.inline} onSubmit={create}>
            <label>Name<input placeholder="Like Reporting tool" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label style={{ flex: '0 0 auto' }}>What it can do
              <select value={scope} onChange={(e) => setScope(e.target.value as 'read' | 'write')}>
                <option value="read">Read only</option>
                <option value="write">Read, and add contacts and leads</option>
              </select>
            </label>
            <button className="primary" disabled={busy}><Icon name="plus" size={16} />Make a key</button>
          </form>
        </div>
      </div>

      <div className="card table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Key</th><th>Can</th><th>Made</th><th>Last used</th><th>Status</th><th /></tr></thead>
          <tbody>
            {data.api_keys.length === 0 && <tr><td colSpan={7}><EmptyState compact icon="integrations" title="No API keys yet" line="Make one above when another app needs to read your records." /></td></tr>}
            {data.api_keys.map((row: any) => (
              <tr key={row.id}>
                <td><strong>{row.name}</strong></td>
                <td><code>{row.prefix}…</code></td>
                <td>{row.scope === 'write' ? 'Read and add' : 'Read only'}</td>
                <td>{dateTime(row.created_at)}{row.created_by && <div className="muted">{row.created_by}</div>}</td>
                <td>{row.last_used_at ? dateTime(row.last_used_at) : 'Never'}{Number(row.requests_1d) > 0 && <div className="muted">{row.requests_1d} in the last day</div>}</td>
                <td>{row.revoked_at ? <span className="badge cancelled">Revoked</span> : <span className="badge active">Active</span>}</td>
                <td>
                  <div className="row-actions">
                    <button className="small" onClick={() => showLog(row)}>Requests</button>
                    {!row.revoked_at && <button className="small ghost danger" disabled={busy} onClick={() => revoke(row)}>Revoke</button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small" style={{ padding: '12px 16px', margin: 0 }}>
          Up to {data.limits.api_keys_per_company} active keys, each allowed {data.limits.api_requests_per_minute} requests a minute.
          Keys that can write may add up to {data.limits.api_writes_per_day} contacts and leads a day for the whole company.
          Requests are kept in each key's log for {data.limits.log_days} days.
        </p>
      </div>

      {created && (
        <ShowOnce
          title={`API key: ${created.name}`}
          value={created.key}
          note={`Keep it secret, like a password. Only a scrambled copy is stored, so nobody here can show it to you again.${created.scope === 'write' ? ' This key can add contacts and leads.' : ''}`}
          onClose={() => setCreated(null)}
        />
      )}

      {log && (
        <Modal title={`Requests: ${log.key.name}`} onClose={() => setLog(null)}>
          <p className="muted">
            Last day: {log.last_day.requests} requests, {log.last_day.ok} worked, {log.last_day.refused} refused, {log.last_day.writes} added a record.
            Only the method, address and result are kept, never what was sent.
          </p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Request</th><th className="num">Result</th><th className="num">Time</th></tr></thead>
              <tbody>
                {log.requests.length === 0 && <tr><td colSpan={4} className="empty">No requests in the last {data.limits.log_days} days</td></tr>}
                {log.requests.map((request: any, n: number) => (
                  <tr key={`${request.at}-${n}`}>
                    <td>{dateTime(request.at)}</td>
                    <td><code>{request.method} {request.path}</code></td>
                    <td className="num"><span className={`badge ${request.status < 400 ? 'delivered' : 'failed'}`}>{request.status}</span></td>
                    <td className="num">{request.duration_ms === null ? '—' : `${request.duration_ms} ms`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form-actions"><button className="primary" onClick={() => setLog(null)}>Close</button></div>
        </Modal>
      )}
    </div>
  );
}
