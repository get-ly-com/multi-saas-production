import { CSSProperties, FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import ChatNav, { PRIORITY } from '@/components/ChatNav';
import Icon from '@/components/Icon';
import Skeleton from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api } from '@/lib/api';
import c from '@/styles/chat.module.css';
import useSubmit from '@/lib/useSubmit';

export default function ChatSettingsPage() {
  return <AppShell><ChatSettings /></AppShell>;
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// The browser's list of time zones, where it has one
const timeZones = (): string[] => {
  try {
    return (Intl as any).supportedValuesOf?.('timeZone') || ['UTC'];
  } catch {
    return ['UTC'];
  }
};

const linkFor = (key: string) => (typeof window === 'undefined' ? '' : `${window.location.origin}/chat/${key}`);

// A browser only tells an embedded page the bare site it sits on, so a tiny script writes the chat box
// with the host page (address without its query) and its campaign (utm_campaign) added to the link.
const IFRAME_STYLE = 'width:100%;max-width:400px;height:560px;border:0;border-radius:12px';
const iframeSnippet = (url: string) => `<!-- Chat box -->
<script>(function(s){var c=new URLSearchParams(location.search).get('utm_campaign'),f=document.createElement('iframe');f.src='${url}?embed=1&page='+encodeURIComponent(location.origin+location.pathname)+(c?'&utm_campaign='+encodeURIComponent(c):'');f.title='Chat with us';f.style.cssText='${IFRAME_STYLE}';s.parentNode.insertBefore(f,s)})(document.currentScript);</script>
<noscript><iframe src="${url}?embed=1" title="Chat with us" style="${IFRAME_STYLE}"></iframe></noscript>`;

// A floating button that opens the chat. The chat only loads when someone clicks it, and takes the
// page and its campaign (utm_campaign) from the page's link so the chat is counted for it.
const buttonSnippet = (url: string, colour: string) => `<!-- Chat button -->
<div style="position:fixed;right:20px;bottom:20px;z-index:2147483000;text-align:right;font-family:sans-serif">
  <iframe id="chat-frame" data-src="${url}?embed=1" title="Chat with us" style="display:none;width:360px;height:520px;max-width:calc(100vw - 40px);max-height:calc(100vh - 110px);border:0;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.25);margin-bottom:12px;background:#fff"></iframe>
  <button type="button" onclick="var f=document.getElementById('chat-frame');if(!f.src){var c=new URLSearchParams(location.search).get('utm_campaign');f.src=f.dataset.src+'&amp;page='+encodeURIComponent(location.origin+location.pathname)+(c?'&amp;utm_campaign='+encodeURIComponent(c):'')}f.style.display=f.style.display==='none'?'block':'none'" style="background:${colour};color:#fff;border:0;border-radius:24px;padding:12px 18px;font-size:15px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.2)">Chat with us</button>
</div>`;

function ChatSettings() {
  const [form, setForm] = useState<any>(null);
  const [manager, setManager] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (field: string, value: any) => setForm({ ...form, [field]: value });

  useEffect(() => {
    Promise.all([api.get('/api/chatbot/settings'), api.get('/api/chatbot/overview')])
      .then(([settings, overview]) => {
        setForm(settings);
        setManager(overview.is_manager);
      })
      .catch((err) => setError(err.message));
  }, []);

  const { busy, run } = useSubmit();
  const save = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      setSaving(true);
      setError('');
      try {
        const saved = await api.put('/api/chatbot/settings', {
          enabled: form.enabled,
          bot_enabled: form.bot_enabled,
          welcome_message: form.welcome_message,
          handoff_message: form.handoff_message,
          opening_hours: form.opening_hours,
          colour: form.colour,
          hours_enabled: form.hours_enabled,
          hours_timezone: form.hours_timezone,
          weekly_hours: form.weekly_hours,
          offline_message: form.offline_message,
          ask_rating: form.ask_rating,
          sla_hours: form.sla_hours
        });
        setForm({ ...saved, whatsapp: form.whatsapp });
        toast.success('Chat settings saved');
      } catch (err: any) {
        setError(err.message);
      } finally {
        setSaving(false);
      }
    });
  };

  const newKey = () => run(async () => {
    if (!window.confirm('Get a new chat address? The old link and every embedded chat stop working, and visitors lose access to their earlier chats. You will need to update your website.')) return;
    try {
      const { public_key } = await api.post('/api/chatbot/settings/key', {});
      setForm({ ...form, public_key });
      toast.success('The chat has a new address', { detail: 'Update the link or code on your website.' });
    } catch (err: any) {
      setError(err.message);
    }
  });

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Copied', { detail: 'Paste it into your website.' });
    } catch {
      setError('Could not copy. Select the text and copy it yourself.');
    }
  };

  if (!form) {
    return (
      <div className="stack">
        <ChatNav />
        {error ? <p className="error">{error}</p> : (
          <div className="stack" role="status" aria-label="Loading settings">
            <Skeleton width={200} height={28} />
            <div className="card stack"><Skeleton width="40%" height={16} /><Skeleton height={64} /><Skeleton height={64} /><Skeleton width="60%" /></div>
          </div>
        )}
      </div>
    );
  }

  const url = linkFor(form.public_key);

  return (
    <div className="stack">
      <ChatNav />
      <div className="page-head">
        <div>
          <h1>Chat settings</h1>
          <p className="muted">How the chat looks and behaves for your visitors.</p>
        </div>
      </div>
      {!manager && <p className="muted">Only owners and admins can change these settings.</p>}

      <form className="card stack" onSubmit={save}>
        <fieldset disabled={!manager} className="chat-fieldset stack">
          <label className="check"><input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Chat is on (visitors can start chats)</label>
          <label className="check"><input type="checkbox" checked={form.bot_enabled} onChange={(e) => set('bot_enabled', e.target.checked)} /> The bot answers from your answers first</label>
          <p className="muted">With the bot off, every message goes straight to your team.</p>
          <label>Welcome message<textarea rows={2} maxLength={500} value={form.welcome_message} onChange={(e) => set('welcome_message', e.target.value)} /></label>
          <label>When the bot hands over to a person, it says<textarea rows={2} maxLength={500} required value={form.handoff_message} onChange={(e) => set('handoff_message', e.target.value)} /></label>
          <label>Opening hours (shown to visitors)<input maxLength={200} placeholder="Mon to Fri, 9am to 5pm" value={form.opening_hours} onChange={(e) => set('opening_hours', e.target.value)} /></label>
          <div className="form-grid" style={{ alignItems: 'end' }}>
            <label className="chat-colour">Colour<input type="color" value={form.colour} onChange={(e) => set('colour', e.target.value)} /></label>
            <div className={c.public} style={{ '--chat-colour': form.colour, padding: 0, minHeight: 0, background: 'none' } as CSSProperties} aria-label="Preview of the chat header">
              <div className={c.wHead} style={{ borderRadius: 'var(--r-lg)', padding: '10px 12px' }}>
                <span className={c.wLogo} style={{ width: 32, height: 32, fontSize: 14 }} aria-hidden="true">A</span>
                <div style={{ display: 'grid', gap: 2 }}><strong>Preview</strong><span className={c.wStatus}>Online now</span></div>
              </div>
            </div>
          </div>

          <h2>When your team is in</h2>
          <label className="check"><input type="checkbox" checked={form.hours_enabled} onChange={(e) => set('hours_enabled', e.target.checked)} /> Use these hours</label>
          <p className="muted">Outside them, the chat page says you're away and the bot asks for a name and email with the message below. The bot still answers what it can.</p>
          {form.hours_enabled && (
            <>
              <label>Time zone
                <input list="chat-time-zones" maxLength={64} value={form.hours_timezone} onChange={(e) => set('hours_timezone', e.target.value)} />
              </label>
              <datalist id="chat-time-zones">{timeZones().map((zone) => <option key={zone} value={zone} />)}</datalist>
              <div className="chat-hours">
                {DAYS.map((day, index) => {
                  const hours = form.weekly_hours?.[index];
                  const setDay = (value: any) => set('weekly_hours', form.weekly_hours.map((old: any, at: number) => (at === index ? value : old)));
                  return (
                    <div key={day} className="chat-hours-row">
                      <label className="check"><input type="checkbox" checked={Boolean(hours)}
                        onChange={(e) => setDay(e.target.checked ? { from: '09:00', to: '17:00' } : null)} /> {day}</label>
                      {hours ? (
                        <>
                          <input type="time" aria-label={`${day} opens`} value={hours.from} onChange={(e) => setDay({ ...hours, from: e.target.value })} />
                          <span>to</span>
                          <input type="time" aria-label={`${day} closes`} value={hours.to === '24:00' ? '23:59' : hours.to}
                            onChange={(e) => setDay({ ...hours, to: e.target.value })} />
                        </>
                      ) : <span className="muted">Closed</span>}
                    </div>
                  );
                })}
              </div>
            </>
          )}
          <label>When your team is away, the chat says<textarea rows={2} maxLength={500} required value={form.offline_message} onChange={(e) => set('offline_message', e.target.value)} /></label>

          <h2>Ratings</h2>
          <label className="check"><input type="checkbox" checked={form.ask_rating} onChange={(e) => set('ask_rating', e.target.checked)} /> Ask visitors to rate the chat when it's closed</label>

          <h2>Ticket response targets</h2>
          <p className="muted">Hours to deal with a ticket, counted from when it was opened. 0 means no target.</p>
          <div className="form-grid">
            {Object.entries(PRIORITY).reverse().map(([level, label]) => (
              <label key={level}>{label}
                <input type="number" min={0} max={720} step={1} value={form.sla_hours?.[level] ?? 0}
                  onChange={(e) => set('sla_hours', { ...form.sla_hours, [level]: e.target.value })} />
              </label>
            ))}
          </div>
        </fieldset>
        {error && <p className="error">{error}</p>}
        {manager && <div className="form-actions"><button className="primary" disabled={busy || saving}>{saving ? 'Saving…' : 'Save settings'}</button></div>}
      </form>

      <div className="card stack">
        <h2>Put the chat on your website</h2>
        {!form.enabled && <p className="muted">Turn chat on above first, or visitors will see that it isn't available.</p>}
        <label>Link to the chat page
          <div className="chat-try"><input readOnly value={url} onFocus={(e) => e.target.select()} /><button type="button" className="always" onClick={() => copy(url)}><Icon name="copy" size={14} />Copy</button>
            <a className="button always" href={url} target="_blank" rel="noopener noreferrer"><Icon name="external" size={14} />Open</a></div>
        </label>
        <label>Chat box inside a page (paste where it should appear)
          <textarea readOnly rows={5} style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }} value={iframeSnippet(url)} onFocus={(e) => e.target.select()} />
        </label>
        <div><button type="button" className="always" onClick={() => copy(iframeSnippet(url))}><Icon name="copy" size={14} />Copy chat box code</button></div>
        <label>Floating "Chat with us" button (paste just before &lt;/body&gt;)
          <textarea readOnly rows={7} style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }} value={buttonSnippet(url, form.colour)} onFocus={(e) => e.target.select()} />
        </label>
        <div><button type="button" className="always" onClick={() => copy(buttonSnippet(url, form.colour))}><Icon name="copy" size={14} />Copy button code</button></div>
        <p className="muted">Anyone with this address can chat with you. If it is being misused, get a new address.</p>
        {manager && <div><button disabled={busy} type="button" className="danger" onClick={newKey}>Get a new address</button></div>}
      </div>

      <WhatsAppSettings form={form} manager={manager} onSaved={(saved) => setForm({ ...form, ...saved, whatsapp: form.whatsapp })} />
    </div>
  );
}

const WHATSAPP_WEBHOOK = 'https://api-gateway-production-7b38.up.railway.app/api/whatsapp/webhook';

// WhatsApp messages in the chat inbox, through Meta's WhatsApp Business Platform
function WhatsAppSettings({ form, manager, onSaved }: { form: any; manager: boolean; onSaved: (saved: any) => void }) {
  const [phoneId, setPhoneId] = useState(form.whatsapp_phone_number_id || '');
  const [error, setError] = useState('');
  const { busy, run } = useSubmit();
  const status = form.whatsapp || {};
  const connected = Boolean(status.app_ready && form.whatsapp_phone_number_id);

  const save = (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      setError('');
      try {
        const saved = await api.put('/api/chatbot/settings', { whatsapp_phone_number_id: phoneId.trim() });
        onSaved(saved);
        if (saved.whatsapp_phone_number_id) toast.success('WhatsApp number saved');
        else toast.info('WhatsApp is disconnected from this company');
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <form className="card stack" onSubmit={save}>
      <div className="section-head">
        <div><h2>WhatsApp</h2><p className="muted">Answer WhatsApp messages from the same inbox.</p></div>
        <span className={`badge ${connected ? 'connected' : 'inactive'}`}>{connected ? 'Connected' : 'Not connected'}</span>
      </div>
      <p>
        {status.last_received_at && <span className="muted"> Last message received {new Date(status.last_received_at).toLocaleString()}</span>}
      </p>
      <p className="muted">Messages to your WhatsApp Business number show up in the inbox with a WhatsApp label, and your
        team's replies go back on WhatsApp. WhatsApp only allows free replies for 24 hours after the customer's last message.</p>
      {!status.app_ready && (
        <p className="notice">WhatsApp isn't switched on for this app yet. Whoever runs the app needs to add the WhatsApp
          keys on the server (step 4 below){status.secret_saved ? '' : ' and save the app secret in the database'}.</p>
      )}
      <fieldset disabled={!manager} className="chat-fieldset stack">
        <label>Phone number ID
          <input inputMode="numeric" maxLength={30} placeholder="For example 106540352242922" value={phoneId}
            onChange={(e) => setPhoneId(e.target.value)} />
        </label>
        <p className="muted">Not your phone number: the long ID Meta shows next to it. Leave empty to disconnect.</p>
      </fieldset>
      {error && <p className="error">{error}</p>}
      {manager && <div className="form-actions"><button className="primary" disabled={busy}>Save WhatsApp number</button></div>}

      <h3>How to set it up</h3>
      <ol className="stack">
        <li>Go to developers.facebook.com, create an app of the Business type, and add the WhatsApp product to it.</li>
        <li>In WhatsApp, API Setup, add your business phone number. Copy the Phone number ID shown with it, paste it above and save.</li>
        <li>In WhatsApp, Configuration, edit the webhook. Callback URL:
          <div className="chat-try"><input readOnly value={WHATSAPP_WEBHOOK} onFocus={(e) => e.target.select()} /></div>
          For the Verify token, use the one set on the server. Then subscribe to the "messages" field.</li>
        <li>Whoever runs the app adds, on the server: a permanent access token (from a System User with the
          whatsapp_business_messaging permission), the app secret (App settings, Basic), and the verify token.</li>
        <li>Send a WhatsApp message to your business number. It should appear in the inbox within a few seconds.</li>
      </ol>
    </form>
  );
}
