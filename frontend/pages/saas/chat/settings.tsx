import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import ChatNav from '@/components/ChatNav';
import { api } from '@/lib/api';

export default function ChatSettingsPage() {
  return <AppShell><ChatSettings /></AppShell>;
}

const linkFor = (key: string) => (typeof window === 'undefined' ? '' : `${window.location.origin}/chat/${key}`);

const iframeSnippet = (url: string) =>
  `<iframe src="${url}?embed=1" title="Chat with us" style="width:100%;max-width:400px;height:560px;border:0;border-radius:12px"></iframe>`;

// A floating button that opens the chat. The chat only loads when someone clicks it.
const buttonSnippet = (url: string, colour: string) => `<!-- Chat button -->
<div style="position:fixed;right:20px;bottom:20px;z-index:2147483000;text-align:right;font-family:sans-serif">
  <iframe id="chat-frame" data-src="${url}?embed=1" title="Chat with us" style="display:none;width:360px;height:520px;max-width:calc(100vw - 40px);max-height:calc(100vh - 110px);border:0;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.25);margin-bottom:12px;background:#fff"></iframe>
  <button type="button" onclick="var f=document.getElementById('chat-frame');if(!f.src)f.src=f.dataset.src;f.style.display=f.style.display==='none'?'block':'none'" style="background:${colour};color:#fff;border:0;border-radius:24px;padding:12px 18px;font-size:15px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.2)">Chat with us</button>
</div>`;

function ChatSettings() {
  const [form, setForm] = useState<any>(null);
  const [manager, setManager] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const set = (field: string, value: any) => setForm({ ...form, [field]: value });

  useEffect(() => {
    Promise.all([api.get('/api/chatbot/settings'), api.get('/api/chatbot/overview')])
      .then(([settings, overview]) => {
        setForm(settings);
        setManager(overview.is_manager);
      })
      .catch((err) => setError(err.message));
  }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const saved = await api.put('/api/chatbot/settings', {
        enabled: form.enabled,
        bot_enabled: form.bot_enabled,
        welcome_message: form.welcome_message,
        handoff_message: form.handoff_message,
        opening_hours: form.opening_hours,
        colour: form.colour
      });
      setForm(saved);
      setNotice('Saved');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const newKey = async () => {
    if (!window.confirm('Get a new chat address? The old link and every embedded chat stop working, and visitors lose access to their earlier chats. You will need to update your website.')) return;
    try {
      const { public_key } = await api.post('/api/chatbot/settings/key', {});
      setForm({ ...form, public_key });
      setNotice('The chat has a new address. Update the link or code on your website.');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice('Copied');
    } catch {
      setError('Could not copy. Select the text and copy it yourself.');
    }
  };

  if (!form) return <div className="stack"><ChatNav />{error ? <p className="error">{error}</p> : <p className="empty">Loading…</p>}</div>;

  const url = linkFor(form.public_key);

  return (
    <div className="stack">
      <ChatNav />
      <div className="page-head"><h1>Chat settings</h1></div>
      {!manager && <p className="muted">Only owners and admins can change these settings.</p>}

      <form className="card stack" onSubmit={save}>
        <fieldset disabled={!manager} className="chat-fieldset stack">
          <label className="check"><input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Chat is on (visitors can start chats)</label>
          <label className="check"><input type="checkbox" checked={form.bot_enabled} onChange={(e) => set('bot_enabled', e.target.checked)} /> The bot answers from your answers first</label>
          <p className="muted">With the bot off, every message goes straight to your team.</p>
          <label>Welcome message<textarea rows={2} maxLength={500} value={form.welcome_message} onChange={(e) => set('welcome_message', e.target.value)} /></label>
          <label>When the bot hands over to a person, it says<textarea rows={2} maxLength={500} required value={form.handoff_message} onChange={(e) => set('handoff_message', e.target.value)} /></label>
          <label>Opening hours (shown to visitors)<input maxLength={200} placeholder="Mon to Fri, 9am to 5pm" value={form.opening_hours} onChange={(e) => set('opening_hours', e.target.value)} /></label>
          <label className="chat-colour">Colour<input type="color" value={form.colour} onChange={(e) => set('colour', e.target.value)} /></label>
        </fieldset>
        {error && <p className="error">{error}</p>}
        {notice && <p className="notice">{notice}</p>}
        {manager && <div className="form-actions"><button className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></div>}
      </form>

      <div className="card stack">
        <h2>Put the chat on your website</h2>
        {!form.enabled && <p className="muted">Turn chat on above first, or visitors will see that it isn't available.</p>}
        <label>Link to the chat page
          <div className="chat-try"><input readOnly value={url} onFocus={(e) => e.target.select()} /><button type="button" className="always" onClick={() => copy(url)}>Copy</button></div>
        </label>
        <label>Chat box inside a page (paste where it should appear)
          <textarea readOnly rows={3} value={iframeSnippet(url)} onFocus={(e) => e.target.select()} />
        </label>
        <div><button type="button" className="always" onClick={() => copy(iframeSnippet(url))}>Copy chat box code</button></div>
        <label>Floating "Chat with us" button (paste just before &lt;/body&gt;)
          <textarea readOnly rows={7} value={buttonSnippet(url, form.colour)} onFocus={(e) => e.target.select()} />
        </label>
        <div><button type="button" className="always" onClick={() => copy(buttonSnippet(url, form.colour))}>Copy button code</button></div>
        <p className="muted">Anyone with this address can chat with you. If it is being misused, get a new address.</p>
        {manager && <div><button type="button" className="danger" onClick={newKey}>Get a new address</button></div>}
      </div>
    </div>
  );
}
