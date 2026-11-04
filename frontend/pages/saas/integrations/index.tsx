import { FormEvent, Fragment, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import EmptyState from '@/components/EmptyState';
import Icon from '@/components/Icon';
import IntegrationsNav, { CodeBlock, EVENTS, IntegrationsLoading, OnlyManagers, ShowOnce, dateTime, eventLabel } from '@/components/IntegrationsNav';
import Modal from '@/components/Modal';
import Skeleton from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';
import s from '@/styles/settings.module.css';

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

  const { busy, run: once } = useSubmit();
  // One action at a time, so a double click cannot repeat it
  const run = (work: () => Promise<unknown>, done = '', detail = '') => once(async () => {
    setNotice('');
    setError('');
    try {
      await work();
      await load();
      if (done) toast.success(done, detail ? { detail } : undefined);
      return true;
    } catch (err: any) {
      setError(err.message);
      return false;
    }
  });

  if (!data) return <div className="stack"><IntegrationsNav />{error ? <p className="error">{error}</p> : <IntegrationsLoading />}</div>;
  if (!data.is_manager) return <div className="stack"><IntegrationsNav /><div className="page-head"><h1>Webhooks</h1></div><OnlyManagers /></div>;

  const hooks: Hook[] = data.webhooks;
  const full = hooks.length >= data.limits.webhooks_per_company;
  // run already allows one action at a time
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
        <div>
          <h1>Webhooks</h1>
          <p className="muted">Tell another app straight away when something happens here, like an invoice being paid.</p>
        </div>
        <button className="primary" onClick={() => setEditing('new')} disabled={full}><Icon name="plus" size={16} />Add webhook</button>
      </div>
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="card">
        {hooks.length === 0 ? (
          <EmptyState icon="integrations" title="No webhooks yet"
            line={`Each message is signed so the other app can check it came from us. Failed messages are tried again up to ${data.limits.attempts} times.`}
            action={{ label: 'Add webhook', onClick: () => setEditing('new') }} />
        ) : (
          <ul className={s.list}>
            {hooks.map((hook) => (
              <li key={hook.id} className={s.row} style={{ alignItems: 'flex-start' }}>
                <span className={s.tileIcon} aria-hidden="true"><Icon name="integrations" size={18} /></span>
                <span className={s.rowText}>
                  <strong style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', whiteSpace: 'normal' }}>
                    {hook.name}
                    {hook.enabled ? <span className="badge active">On</span> : <span className="badge failed">Off</span>}
                  </strong>
                  <span className="wrap-anywhere" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>{hook.url}</span>
                  <span>Sends {hook.events.map(eventLabel).join(', ')}</span>
                  <span>
                    <span className="tabular">{hook.delivered_7} sent{hook.failed_7 > 0 ? `, ${hook.failed_7} failed` : ''} in the last 7 days</span>
                    {hook.waiting > 0 && ` · ${hook.waiting} waiting to send`}
                    {hook.enabled && hook.failures_in_row > 0 && <span style={{ color: 'var(--warn)' }}> · {hook.failures_in_row} failed in a row</span>}
                  </span>
                  {hook.disabled_reason && <span style={{ color: 'var(--danger)' }}>{hook.disabled_reason}</span>}
                </span>
                <span className={s.rowActions}>
                  <button className="small" onClick={() => setLog(hook)}>Log</button>
                  <button className="small" disabled={!hook.enabled} onClick={() => run(() => api.post(`/api/integration/webhooks/${hook.id}/test`, {}), 'Test sent', 'Open the log to see the answer.')}>Send test</button>
                  <button className="small" onClick={() => setEditing(hook)}>Edit</button>
                  <button className="small ghost" onClick={() => run(() => api.post(`/api/integration/webhooks/${hook.id}/enabled`, { enabled: !hook.enabled }), hook.enabled ? 'Webhook turned off' : 'Webhook turned on')}>{hook.enabled ? 'Turn off' : 'Turn on'}</button>
                  <button className="small ghost" disabled={busy} onClick={() => newSecret(hook)}>New secret</button>
                  <button className="small ghost danger" onClick={() => window.confirm(`Delete ${hook.name} and its log?`) && run(() => api.delete(`/api/integration/webhooks/${hook.id}`), 'Webhook deleted')}>Delete</button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <div style={{ marginTop: 14 }}>
          <div className={s.progress}><span style={{ width: `${Math.min(100, (data.used_today / Math.max(1, data.limits.deliveries_per_day)) * 100)}%` }} /></div>
          <p className={s.progressText}>
            <span>{data.used_today} of {data.limits.deliveries_per_day} messages used today</span>
            <span>{hooks.length} of {data.limits.webhooks_per_company} webhooks</span>
          </p>
          <p className="muted small" style={{ margin: '6px 0 0' }}>
            A webhook that fails {data.limits.failures_before_off} times in a row is turned off and owners and admins get an alert.
          </p>
        </div>
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
            }, isNew ? '' : 'Webhook saved');
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
    <Modal title={hook ? 'Edit webhook' : 'Add webhook'} onClose={onClose}>
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

  const { busy, run: once } = useSubmit();
  const retry = (id: string) => once(async () => {
    try {
      await api.post(`/api/integration/deliveries/${id}/retry`, {});
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  });

  const status = (row: any) => {
    if (row.status === 'delivered') return <span className="badge delivered">Delivered</span>;
    if (row.status === 'failed') return <span className="badge failed">Failed</span>;
    if (row.status === 'sending') return <span className="badge">Sending</span>;
    return <span className="badge">{row.attempts ? 'Will try again' : 'Waiting'}</span>;
  };

  return (
    <Modal title={`Log for ${hook.name}`} onClose={onClose}>
      <p className="muted">The last 50 messages. Queued messages go out within a minute. Logs are kept for 30 days.</p>
      {error && <p className="error">{error}</p>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Event</th><th>Result</th><th className="num">Answer</th><th /></tr></thead>
          <tbody>
            {rows === null && [0, 1, 2].map((n) => <tr key={n}><td colSpan={5}><Skeleton height={14} width={`${80 - n * 15}%`} /></td></tr>)}
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
                      {row.status === 'failed' && row.event !== 'test' && <button disabled={busy} onClick={() => retry(row.id)}>Send again</button>}
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
      <CodeBlock label="Code copied" value={`// Node.js
const crypto = require('crypto');
const expected = 'sha256=' + crypto.createHmac('sha256', process.env.WEBHOOK_SECRET)
  .update(req.headers['x-webhook-timestamp'] + '.' + rawBody).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-webhook-signature']))
  && Math.abs(Date.now() / 1000 - Number(req.headers['x-webhook-timestamp'])) < 300;`} />
    </div>
  );
}
