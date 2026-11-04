import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import Skeleton from '@/components/Skeleton';
import SocialNav from '@/components/SocialNav';
import { toast } from '@/components/Toast';
import { fileSize } from '@/components/SocialForms';
import { api } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

export default function SocialSettings() {
  return <AppShell><Settings /></AppShell>;
}

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

const zones = (): string[] => {
  try {
    return (Intl as any).supportedValuesOf('timeZone');
  } catch {
    return [];
  }
};

function Settings() {
  const [overview, setOverview] = useState<any>(null);
  const [form, setForm] = useState({ require_approval: false, timezone: 'UTC' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    try {
      const summary = await api.get('/api/social-media/overview');
      setOverview(summary);
      // A company that never saved settings starts with this browser's time zone
      setForm({ require_approval: summary.require_approval, timezone: summary.timezone === 'UTC' ? browserZone() : summary.timezone });
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      setError('');
      setNotice('');
      try {
        await api.put('/api/social-media/settings', form);
        toast.success('Settings saved');
        await load();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  if (!overview) return <div className="stack"><SocialNav />{error ? <p className="error">{error}</p> : <div className="stack" aria-busy="true"><Skeleton width={200} height={28} /><div className="card"><Skeleton width="40%" height={18} /><Skeleton height={80} style={{ marginTop: 12 }} /></div></div>}</div>;

  const list = zones();
  const used = Number(overview.space_used || 0);
  const limit = Number(overview.space_limit || 1);

  return (
    <div className="stack">
      <SocialNav />
      <div className="page-head"><div><h1>Social settings</h1><p className="muted">How posts get approved, and how much image space you have.</p></div></div>

      <form className="card" onSubmit={submit}>
        <h2>Approval and time zone</h2>
        <label className="check">
          <input type="checkbox" checked={form.require_approval} disabled={!overview.is_manager}
            onChange={(e) => setForm({ ...form, require_approval: e.target.checked })} />
          Posts need approval from an owner or admin before they go out
        </label>
        <p className="muted">When this is on, posts from other team members wait for approval, and changing an approved post’s text, image, link or date sends it back for approval. Owners’ and admins’ own posts don’t need approving.</p>
        <label style={{ marginTop: 12, maxWidth: 320 }}>Company time zone (for “due today” alerts)
          {list.length ? (
            <select value={form.timezone} disabled={!overview.is_manager} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              {!list.includes(form.timezone) && <option value={form.timezone}>{form.timezone}</option>}
              {list.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
            </select>
          ) : (
            <input value={form.timezone} disabled={!overview.is_manager} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
          )}
        </label>
        {error && <p className="error">{error}</p>}
        {notice && <p className="notice">{notice}</p>}
        {overview.is_manager ? (
          <div className="form-actions"><button disabled={busy} className="primary" type="submit">Save</button></div>
        ) : (
          <p className="muted">Only owners and admins can change these settings.</p>
        )}
      </form>

      <div className="card">
        <h2>Image space</h2>
        <p>{fileSize(used)} of {fileSize(limit)} used ({Math.min(100, Math.round((used / limit) * 100))}%).</p>
        <div className="social-meter"><span style={{ width: `${Math.min(100, (used / limit) * 100)}%` }} /></div>
        <p className="muted">Each company has 100 MB for post images. Removing an image from a post, or deleting the post, frees its space.</p>
      </div>

      <div className="card">
        <h2>How posting works</h2>
        <p className="muted">Posting straight to Facebook, Instagram, LinkedIn or X needs an approved developer app with each platform, so this planner doesn’t post for you. On the day, open the post, press “Post now” to copy the text and open the platform, post it there, then paste the live link and mark it as posted.</p>
      </div>
    </div>
  );
}
