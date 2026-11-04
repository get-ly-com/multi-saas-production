import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import IntegrationsNav, { OnlyManagers, ShowOnce, dateTime } from '@/components/IntegrationsNav';
import Modal from '@/components/Modal';
import { api } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

export default function Inbound() {
  return <AppShell><InboundApp /></AppShell>;
}

type Hook = {
  id: string; name: string; source: string; prefix: string; enabled: boolean; created_at: string;
  last_used_at: string | null; created_by: string | null; created_7: number; updated_7: number; refused_7: number;
};

const RESULTS: Record<string, { label: string; tone: string }> = {
  created: { label: 'New lead', tone: 'delivered' },
  updated: { label: 'Added to an open lead', tone: 'delivered' },
  rejected: { label: 'Refused', tone: 'failed' },
  limited: { label: 'Too many', tone: 'failed' }
};

const addressFor = (token: string) => `${process.env.NEXT_PUBLIC_API_BASE_URL || 'https://your-api-address'}/api/hooks/in/${token}`;

function InboundApp() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<Hook | 'new' | null>(null);
  const [address, setAddress] = useState<{ name: string; url: string } | null>(null);
  const [log, setLog] = useState<{ hook: Hook; rows: any[] } | null>(null);

  const load = async () => {
    try {
      setData(await api.get('/api/integration/inbound'));
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
  const run = (work: () => Promise<unknown>, done = '') => once(async () => {
    setNotice('');
    setError('');
    try {
      await work();
      await load();
      setNotice(done);
    } catch (err: any) {
      setError(err.message);
    }
  });

  if (!data) return <div className="stack"><IntegrationsNav />{error ? <p className="error">{error}</p> : <p className="empty">Loading…</p>}</div>;
  if (!data.is_manager) return <div className="stack"><IntegrationsNav /><h1>Incoming webhooks</h1><OnlyManagers /></div>;

  const hooks: Hook[] = data.hooks;

  const save = (form: { name: string; source: string }) => run(async () => {
    if (editing === 'new') {
      const result = await api.post('/api/integration/inbound', form);
      setAddress({ name: form.name, url: addressFor(result.token) });
    } else if (editing) {
      await api.put(`/api/integration/inbound/${editing.id}`, form);
    }
    setEditing(null);
  });

  const newAddress = (hook: Hook) => {
    if (!window.confirm(`Make a new address for ${hook.name}? The old one stops working straight away.`)) return;
    run(async () => {
      const result = await api.post(`/api/integration/inbound/${hook.id}/token`, {});
      setAddress({ name: hook.name, url: addressFor(result.token) });
    });
  };

  const remove = (hook: Hook) => {
    if (!window.confirm(`Delete ${hook.name}? Anything posting to it gets "not found" from now on. Leads it already added stay.`)) return;
    run(() => api.delete(`/api/integration/inbound/${hook.id}`), `${hook.name} deleted`);
  };

  const showLog = (hook: Hook) => run(async () => {
    setLog({ hook, rows: await api.get(`/api/integration/inbound/${hook.id}/log`) });
  });

  return (
    <div className="stack">
      <IntegrationsNav />
      <div className="page-head">
        <h1>Incoming webhooks</h1>
        <button className="primary" onClick={() => setEditing('new')} disabled={hooks.length >= data.limits.inbound_hooks_per_company}>Add incoming webhook</button>
      </div>
      <p className="muted">
        An incoming webhook is a secret web address. When another tool (a form builder, Zapier, an ad platform) sends a person's
        details to it, a new lead appears in CRM. If an open lead already has that email, a note is added to it instead.
        Anyone who knows the address can send leads, so treat it like a password.
      </p>
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="card table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Leads come in as</th><th>Status</th><th>Last used</th><th className="num">Last 7 days</th><th /></tr></thead>
          <tbody>
            {hooks.length === 0 && <tr><td colSpan={6} className="empty">No incoming webhooks yet</td></tr>}
            {hooks.map((hook) => (
              <tr key={hook.id}>
                <td>{hook.name}<div className="muted"><code>{hook.prefix}…</code></div></td>
                <td>Source: {hook.source}</td>
                <td>{hook.enabled ? <span className="badge delivered">On</span> : <span className="badge failed">Off</span>}</td>
                <td>{hook.last_used_at ? dateTime(hook.last_used_at) : 'Never'}</td>
                <td className="num">
                  {hook.created_7} new · {hook.updated_7} added to
                  {Number(hook.refused_7) > 0 && <div className="muted">{hook.refused_7} refused</div>}
                </td>
                <td>
                  <div className="row-actions">
                    <button onClick={() => showLog(hook)}>Log</button>
                    <button onClick={() => setEditing(hook)}>Edit</button>
                    <button onClick={() => run(() => api.post(`/api/integration/inbound/${hook.id}/enabled`, { enabled: !hook.enabled }), hook.enabled ? `${hook.name} turned off` : `${hook.name} turned on`)}>
                      {hook.enabled ? 'Turn off' : 'Turn on'}
                    </button>
                    <button onClick={() => newAddress(hook)}>New address</button>
                    <button className="danger" onClick={() => remove(hook)}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">
          Up to {data.limits.inbound_hooks_per_company} incoming webhooks. Each takes up to {data.limits.inbound_per_minute} a minute,
          and the company up to {data.limits.inbound_per_day} leads a day ({data.used_today} today). An address stops working if the
          person who made it is no longer an owner or admin.
        </p>
      </div>

      <div className="card">
        <h2>What to send</h2>
        <p>Send a POST with JSON or a normal form. Field names can be in any case. A name (or first and last name) and an email or phone are needed.</p>
        <pre className="code-block">{`curl -X POST ${addressFor('ih_your_secret')} \\
  -H "Content-Type: application/json" \\
  -d '{"name": "Ada Lovelace", "email": "ada@example.com", "phone": "+44 20 7946 0000",
       "company": "Analytical Engines", "message": "Please call me", "utm_campaign": "autumn"}'`}</pre>
        <table>
          <thead><tr><th>Lead field</th><th>Names we look for</th></tr></thead>
          <tbody>
            <tr><td>Name</td><td className="muted">name, full_name, or first_name and last_name</td></tr>
            <tr><td>Email</td><td className="muted">email, email_address</td></tr>
            <tr><td>Phone</td><td className="muted">phone, phone_number, mobile, telephone</td></tr>
            <tr><td>Company</td><td className="muted">company, company_name, organization</td></tr>
            <tr><td>Job title</td><td className="muted">job_title, title, position</td></tr>
            <tr><td>Message</td><td className="muted">message, notes, comments, description</td></tr>
            <tr><td>Campaign</td><td className="muted">campaign, utm_campaign</td></tr>
          </tbody>
        </table>
        <p className="muted">
          Fields inside <code>data</code> or <code>fields</code> are read too. The answer is 201 for a new lead, 200 when it was added to an
          open lead, 422 when something is missing, 429 when there were too many and 404 when the address is wrong or turned off.
          The log keeps which field names came in and the result, never the values. To add leads from your own code, an{' '}
          <Link href="/saas/integrations/keys">API key</Link> that can write is the better fit.
        </p>
      </div>

      {editing && (
        <InboundForm hook={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSave={save} />
      )}

      {address && (
        <ShowOnce title={`Address for ${address.name}`} value={address.url} onClose={() => setAddress(null)}
          note="Paste it into the other tool as the webhook address. Only a scrambled copy is stored, so it can't be shown again." />
      )}

      {log && (
        <Modal title={`Log: ${log.hook.name}`} onClose={() => setLog(null)}>
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Result</th><th>Fields sent</th></tr></thead>
              <tbody>
                {log.rows.length === 0 && <tr><td colSpan={3} className="empty">Nothing received in the last {data.limits.log_days} days</td></tr>}
                {log.rows.map((row, n) => (
                  <tr key={`${row.at}-${n}`}>
                    <td>{dateTime(row.at)}</td>
                    <td>
                      <span className={`badge ${RESULTS[row.result]?.tone || ''}`}>{RESULTS[row.result]?.label || row.result}</span>
                      {row.error && <div className="muted">{row.error}</div>}
                      {row.lead_id && <div><Link href={`/saas/crm/lead/${row.lead_id}`}>Open lead</Link></div>}
                    </td>
                    <td className="muted wrap-anywhere">{(row.fields || []).join(', ') || '—'}</td>
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

function InboundForm({ hook, onClose, onSave }: {
  hook: Hook | null; onClose: () => void; onSave: (form: { name: string; source: string }) => void;
}) {
  const [form, setForm] = useState({ name: hook?.name || '', source: hook?.source || '' });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave(form);
  };
  return (
    <Modal title={hook ? 'Edit incoming webhook' : 'Add incoming webhook'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Name<input required maxLength={80} placeholder="Like Website form or Facebook ads" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>Lead source<input maxLength={100} placeholder="Same as the name" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} /></label>
        </div>
        <p className="muted">Every lead from this address gets this source, so you can report on where leads came from.</p>
        <div className="form-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary">{hook ? 'Save' : 'Add and show the address'}</button>
        </div>
      </form>
    </Modal>
  );
}
