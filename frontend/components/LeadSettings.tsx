import { FormEvent, useEffect, useState } from 'react';
import { useTeam } from '@/components/CrmForms';
import { toast } from '@/components/Toast';
import { api } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

const RULE_KINDS = [
  { id: 'email', name: 'Has an email' },
  { id: 'phone', name: 'Has a phone number' },
  { id: 'company', name: 'Has a company' },
  { id: 'title_contains', name: 'Job title contains' },
  { id: 'source_is', name: 'Source is' },
  { id: 'activity', name: 'Each timeline entry, up to 5' }
];

const usesWords = (kind: string) => ['title_contains', 'source_is'].includes(kind);

export default function LeadSettings() {
  const members = useTeam().filter(({ role }) => role !== 'viewer');
  const [settings, setSettings] = useState<any>(null);
  const [origin, setOrigin] = useState('');
  const [error, setError] = useState('');
  // Finished actions show as a toast
  const setNotice = (message: string) => { if (message) toast.success(message.replace(/\.$/, '')); };
  const set = (field: string, value: unknown) => setSettings({ ...settings, [field]: value });

  const load = async () => {
    try {
      setSettings(await api.get('/api/crm/lead-settings'));
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    setOrigin(window.location.origin);
    load();
  }, []);

  const setRule = (index: number, field: string, value: unknown) =>
    set('rules', settings.rules.map((rule: any, i: number) => (i === index ? { ...rule, [field]: value } : rule)));

  const toggle = (id: string) =>
    set('assignees', settings.assignees.includes(id) ? settings.assignees.filter((user: string) => user !== id) : [...settings.assignees, id]);

  const { busy, run } = useSubmit();
  const save = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api.post('/api/crm/lead-settings', settings);
        toast.success('Lead settings saved', { detail: 'Open leads have been scored again.' });
        await load();
      } catch (err: any) {
        setNotice('');
        setError(err.message);
      }
    });
  };

  const newKey = () => run(async () => {
    if (!window.confirm('Create a new form address? The old address stops working, including on your website.')) return;
    try {
      await api.post('/api/crm/lead-settings/form-key', {});
      setNotice('New form address created.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  });

  if (!settings) return error ? <p className="error">{error}</p> : null;

  const address = `${origin}/form/${settings.form_key}`;
  // A tiny script writes the form so the campaign (utm_campaign) in the host page's link reaches it;
  // browsers usually hide the rest of that link from an embedded page
  const embed = `<!-- Contact form -->
<script>(function(s){var c=new URLSearchParams(location.search).get('utm_campaign'),f=document.createElement('iframe');f.src='${address}'+(c?'?utm_campaign='+encodeURIComponent(c):'');f.title='Contact form';f.style.cssText='width:100%;height:620px;border:0';s.parentNode.insertBefore(f,s)})(document.currentScript);</script>
<noscript><iframe src="${address}" title="Contact form" style="width:100%;height:620px;border:0"></iframe></noscript>`;

  return (
    <form className="stack" onSubmit={save}>
      <h2>Leads</h2>
      {error && <p className="error">{error}</p>}

      <div className="card stack">
        <h2>Assignment</h2>
        <label>New leads go to
          <select value={settings.assign_mode} onChange={(e) => set('assign_mode', e.target.value)}>
            <option value="creator">The person who adds them. Form leads stay unassigned</option>
            <option value="round_robin">The team, taking turns</option>
          </select>
        </label>
        {settings.assign_mode === 'round_robin' && members.map((member) => (
          <label className="check" key={member.user_id}>
            <input type="checkbox" checked={settings.assignees.includes(member.user_id)} onChange={() => toggle(member.user_id)} />{member.email}
          </label>
        ))}
      </div>

      <div className="card stack">
        <h2>Scoring</h2>
        <p className="muted">Points add up to a score from 0 to 100. 60 or more is Hot and 30 or more is Warm.</p>
        <div className="lines">
          {settings.rules.map((rule: any, index: number) => (
            <div className="score-rule" key={rule.id || index}>
              <select aria-label="Rule" value={rule.kind} onChange={(e) => setRule(index, 'kind', e.target.value)}>
                {RULE_KINDS.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
              </select>
              <input aria-label="Words to match" disabled={!usesWords(rule.kind)} required={usesWords(rule.kind)} value={rule.match || ''} onChange={(e) => setRule(index, 'match', e.target.value)} />
              <input aria-label="Points" required type="number" min="-100" max="100" value={rule.points} onChange={(e) => setRule(index, 'points', e.target.value)} />
              <button type="button" aria-label="Remove rule" onClick={() => set('rules', settings.rules.filter((_: any, i: number) => i !== index))}>×</button>
            </div>
          ))}
        </div>
        <div><button type="button" onClick={() => set('rules', [...settings.rules, { kind: 'title_contains', match: '', points: 10 }])}>Add rule</button></div>
      </div>

      <div className="card stack">
        <h2>Web form</h2>
        <label className="check"><input type="checkbox" checked={settings.form_enabled} onChange={(e) => set('form_enabled', e.target.checked)} />Accept leads from the web form</label>
        <div className="form-grid">
          <label>Source for these leads<input required maxLength={100} value={settings.form_source} onChange={(e) => set('form_source', e.target.value)} /></label>
          <label>Thank you message<input required maxLength={500} value={settings.form_thanks} onChange={(e) => set('form_thanks', e.target.value)} /></label>
        </div>
        <label>Form address<input readOnly value={address} onFocus={(e) => e.target.select()} /></label>
        <label>Code for your website<textarea readOnly rows={5} value={embed} onFocus={(e) => e.target.select()} /></label>
        <div><button disabled={busy} type="button" onClick={newKey}>New form address</button></div>
      </div>

      <div><button disabled={busy} className="primary">Save lead settings</button></div>
    </form>
  );
}
