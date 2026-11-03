import { FormEvent, Fragment, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import IntegrationsNav, { EVENTS, OnlyManagers, ShowOnce, dateTime, eventLabel } from '@/components/IntegrationsNav';
import Modal from '@/components/Modal';
import { api } from '@/lib/api';

export default function Webhooks() {
  return <AppShell><WebhooksApp /></AppShell>;
}

type Hook = {
  id: string; name: string; url: string; events: string[]; enabled: boolean; failures_in_row: number;
  disabled_reason: string | null; last_success_at: string | null; last_failure_at: string | null;
  secret_hint: string; waiting: number; delivered_7: number; failed_7: number;
};

function WebhooksApp() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<Hook | 'new' | null>(null);
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  const [log, setLog] = useState<Hook | null>(null);

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

  const run = async (work: () => Promise<unknown>, done = '') => {
    setNotice('');
    setError('');
    try {
      await work();
      await load();
      setNotice(done);
      return true;
    } catch (err: any) {
      setError(err.message);
      return false;
    }
  };

  if (!data) return <div className="stack"><IntegrationsNav />{error ? <p className="error">{error}</p> : <p className="empty">Loading…</p>}</div>;
  if (!data.is_manager) return <div className="stack"><IntegrationsNav /><h1>Webhooks</h1><OnlyManagers /></div>;

  const hooks: Hook[] = data.webhooks;
  const newSecret = async (hook: Hook) => {
    if (!window.confirm(`Make a new signing secret for ${hook.name}? The old one stops working straight away.`)) return;
    await run(async () => {
      const result = await api.post(`/api/integration/webhooks/${hook.id}/secret`, {});
      setSecret({ name: hook.name, secret: result.secret });
    });
  };

  return (
    <div className="stack">
      <IntegrationsNav />
      <div className="page-head">
        <h1>Webhooks</h1>
        <button className="primary" onClick={() => setEditing('new')} disabled={hooks.length >= data.limits.webhooks_per_company}>Add webhook</button>
      </div>
      <p className="muted">
        A webhook sends a short message to another app's web address when something happens here, like an invoice being paid.
        Each message is signed so the other app can check it came from us. Failed messages are tried again up to {data.limits.attempts} times.
      </p>
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="card table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Sends</th><th>Status</th><th className="num">Last 7 days</th><th /></tr></thead>
          <tbody>
            {hooks.length === 0 && <tr><td colSpan={5} className="empty">No webhooks yet</td></tr>}
            {hooks.map((hook) => (
              <tr key={hook.id}>
                <td>
                  <strong>{hook.name}</strong>
                  <div className="muted wrap-anywhere">{hook.url}</div>
                </td>
                <td>{hook.events.map(eventLabel).join(', ')}</td>
                <td>
                  {hook.enabled
                    ? <span className="badge delivered">On</span>
                    : <span className="badge failed">Off</span>}
                  {hook.disabled_reason && <div className="muted">{hook.disabled_reason}</div>}
                  {hook.enabled && hook.failures_in_row > 0 && <div className="muted">{hook.failures_in_row} failed in a row</div>}
                  {hook.waiting > 0 && <div className="muted">{hook.waiting} waiting to send</div>}
                </td>
                <td className="num">{hook.delivered_7} sent{hook.failed_7 > 0 ? `, ${hook.failed_7} failed` : ''}</td>
                <td>
                  <div className="row-actions">
                    <button onClick={() => setLog(hook)}>Log</button>
                    <button disabled={!hook.enabled} onClick={() => run(() => api.post(`/api/integration/webhooks/${hook.id}/test`, {}), 'Test sent. Open the log to see the answer.')}>Send test</button>
                    <button onClick={() => setEditing(hook)}>Edit</button>
                    <button onClick={() => run(() => api.post(`/api/integration/webhooks/${hook.id}/enabled`, { enabled: !hook.enabled }))}>{hook.enabled ? 'Turn off' : 'Turn on'}</button>
                    <button onClick={() => newSecret(hook)}>New secret</button>
                    <button className="danger" onClick={() => window.confirm(`Delete ${hook.name} and its log?`) && run(() => api.delete(`/api/integration/webhooks/${hook.id}`))}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">
          {data.used_today} of {data.limits.deliveries_per_day} messages used today. A webhook that fails {data.limits.failures_before_off} times
          in a row is turned off and owners and admins get an alert.
        </p>
      </div>

      <Checking />

      {editing && (
        <WebhookForm
          hook={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async (body) => {
            const isNew = editing === 'new';
            return run(async () => {
              const result = isNew
                ? await api.post('/api/integration/webhooks', body)
                : await api.put(`/api/integration/webhooks/${(editing as Hook).id}`, body);
              setEditing(null);
              if (isNew) setSecret({ name: body.name, secret: result.secret });
            }, isNew ? '' : 'Webhook saved.');
          }}
        />
      )}
      {secret && <ShowOnce title={`Signing secret for ${secret.name}`} value={secret.secret} onClose={() => setSecret(null)} />}
      {log && <DeliveryLog hook={log} onClose={() => { setLog(null); load(); }} />}
    </div>
  );
}

function WebhookForm({ hook, onSave, onClose }: { hook: Hook | null; onSave: (body: any) => Promise<boolean>; onClose: () => void }) {
  const [form, setForm] = useState({ name: hook?.name || '', url: hook?.url || 'https://', events: hook?.events || [] as string[] });

  const toggle = (name: string) =>
    setForm({ ...form, events: form.events.includes(name) ? form.events.filter((event) => event !== name) : [...form.events, name] });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave(form);
  };

  return (
    <Modal title={hook ? 'Edit webhook' : 'Add webhook'}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Name<input required maxLength={80} placeholder="Like Zapier or Slack" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>Web address<input required type="url" maxLength={500} pattern="https://.*" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} /></label>
        </div>
        <p className="muted">It must start with https:// and be a public address. Private network and IP addresses are not allowed.</p>
        <h3>Send a message when</h3>
        <div className="form-grid">
          {EVENTS.map(({ name, label }) => (
            <label key={name} className="check">
              <input type="checkbox" checked={form.events.includes(name)} onChange={() => toggle(name)} /> {label}
            </label>
          ))}
        </div>
        <p className="muted">HR messages only carry ids, dates and pay run totals, never names, reasons or anyone's own pay.
          Chat and social messages never include what was written. Only "Booking made" includes the customer's name and email.</p>
        <div className="form-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={form.events.length === 0}>{hook ? 'Save' : 'Add webhook'}</button>
        </div>
      </form>
    </Modal>
  );
}

function DeliveryLog({ hook, onClose }: { hook: Hook; onClose: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState('');

  const load = async () => {
    try {
      setRows(await api.get(`/api/integration/webhooks/${hook.id}/deliveries`));
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const retry = async (id: string) => {
    try {
      await api.post(`/api/integration/deliveries/${id}/retry`, {});
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const status = (row: any) => {
    if (row.status === 'delivered') return <span className="badge delivered">Delivered</span>;
    if (row.status === 'failed') return <span className="badge failed">Failed</span>;
    if (row.status === 'sending') return <span className="badge">Sending</span>;
    return <span className="badge">{row.attempts ? 'Will try again' : 'Waiting'}</span>;
  };

  return (
    <Modal title={`Log for ${hook.name}`}>
      <p className="muted">The last 50 messages. Queued messages go out within a minute. Logs are kept for 30 days.</p>
      {error && <p className="error">{error}</p>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Event</th><th>Result</th><th className="num">Answer</th><th /></tr></thead>
          <tbody>
            {rows === null && <tr><td colSpan={5} className="empty">Loading…</td></tr>}
            {rows?.length === 0 && <tr><td colSpan={5} className="empty">Nothing sent yet</td></tr>}
            {rows?.map((row) => (
              <Fragment key={row.id}>
                <tr>
                  <td>{dateTime(row.created_at)}</td>
                  <td>{eventLabel(row.event)}</td>
                  <td>
                    {status(row)}
                    <div className="muted">Try {row.attempts} of {row.max_attempts}{row.next_attempt_at ? `, next at ${dateTime(row.next_attempt_at)}` : ''}</div>
                    {row.error && <div className="muted">{row.error}</div>}
                  </td>
                  <td className="num">{row.status_code ?? '—'}{row.duration_ms !== null && row.duration_ms !== undefined ? <div className="muted">{row.duration_ms} ms</div> : null}</td>
                  <td>
                    <div className="row-actions">
                      <button onClick={() => setOpen(open === row.id ? '' : row.id)}>{open === row.id ? 'Hide' : 'Message'}</button>
                      {row.status === 'failed' && row.event !== 'test' && <button onClick={() => retry(row.id)}>Send again</button>}
                    </div>
                  </td>
                </tr>
                {open === row.id && <tr><td colSpan={5}><pre className="code-block">{JSON.stringify(row.payload, null, 2)}</pre></td></tr>}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div className="form-actions">
        <button onClick={load}>Refresh</button>
        <button className="primary" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

function Checking() {
  return (
    <div className="card">
      <h2>Checking a message is from us</h2>
      <p className="muted">
        Every message is a POST with a JSON body and these headers: <code>X-Webhook-Event</code>, <code>X-Webhook-Id</code> (the same on every
        try, so you can skip repeats), <code>X-Webhook-Timestamp</code> and <code>X-Webhook-Signature</code>. The signature is
        <code> sha256=</code> followed by the HMAC-SHA256 of the timestamp, a dot and the raw body, made with your signing secret.
        Answer with any 2xx status within 5 seconds.
      </p>
      <pre className="code-block">{`// Node.js
const crypto = require('crypto');
const expected = 'sha256=' + crypto.createHmac('sha256', process.env.WEBHOOK_SECRET)
  .update(req.headers['x-webhook-timestamp'] + '.' + rawBody).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-webhook-signature']))
  && Math.abs(Date.now() / 1000 - Number(req.headers['x-webhook-timestamp'])) < 300;`}</pre>
    </div>
  );
}
