import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import IntegrationsNav, { OnlyManagers, ShowOnce, dateTime } from '@/components/IntegrationsNav';
import { api } from '@/lib/api';

export default function ApiKeys() {
  return <AppShell><KeysApp /></AppShell>;
}

function KeysApp() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);

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

  if (!data) return <div className="stack"><IntegrationsNav />{error ? <p className="error">{error}</p> : <p className="empty">Loading…</p>}</div>;
  if (!data.is_manager) return <div className="stack"><IntegrationsNav /><h1>API keys</h1><OnlyManagers /></div>;

  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const result = await api.post('/api/integration/api-keys', { name });
      setCreated({ name, key: result.key });
      setName('');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const revoke = async (row: any) => {
    if (!window.confirm(`Revoke ${row.name}? Anything using it stops working straight away.`)) return;
    try {
      await api.delete(`/api/integration/api-keys/${row.id}`);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="stack">
      <IntegrationsNav />
      <h1>API keys</h1>
      <p className="muted">
        An API key lets another app read this company's contacts, invoices, stock items and deals. Keys can only read, never change anything.
        A key stops working if you revoke it, or if the person who made it is no longer an owner or admin. See the <Link href="/saas/integrations/api">API guide</Link>.
      </p>
      {error && <p className="error">{error}</p>}

      <form className="card row-actions" style={{ justifyContent: 'flex-start' }} onSubmit={create}>
        <input aria-label="Key name" placeholder="Name, like Reporting tool" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="primary">Make a key</button>
      </form>

      <div className="card table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Key</th><th>Made</th><th>Last used</th><th>Status</th><th /></tr></thead>
          <tbody>
            {data.api_keys.length === 0 && <tr><td colSpan={6} className="empty">No API keys yet</td></tr>}
            {data.api_keys.map((row: any) => (
              <tr key={row.id}>
                <td>{row.name}</td>
                <td><code>{row.prefix}…</code></td>
                <td>{dateTime(row.created_at)}{row.created_by && <div className="muted">{row.created_by}</div>}</td>
                <td>{row.last_used_at ? dateTime(row.last_used_at) : 'Never'}</td>
                <td>{row.revoked_at ? <span className="badge failed">Revoked</span> : <span className="badge delivered">Active</span>}</td>
                <td><div className="row-actions">{!row.revoked_at && <button className="danger" onClick={() => revoke(row)}>Revoke</button>}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">Up to {data.limits.api_keys_per_company} active keys, each allowed {data.limits.api_requests_per_minute} requests a minute.</p>
      </div>

      {created && (
        <ShowOnce
          title={`API key: ${created.name}`}
          value={created.key}
          note="Keep it secret, like a password. Only a scrambled copy is stored, so nobody here can show it to you again."
          onClose={() => setCreated(null)}
        />
      )}
    </div>
  );
}
