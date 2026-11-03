import { FormEvent, useState } from 'react';
import Modal from '@/components/Modal';
import { api } from '@/lib/api';
import { withTracking } from '@/lib/campaign';
import { getSupabase } from '@/lib/supabase';

// Nothing here posts for you. Each platform needs its own approved developer app to post
// automatically, so people post from the platform and record the live link here.

export const PLATFORMS: Record<string, { name: string; limit: number }> = {
  x: { name: 'X', limit: 280 },
  linkedin: { name: 'LinkedIn', limit: 3000 },
  facebook: { name: 'Facebook', limit: 63206 },
  instagram: { name: 'Instagram', limit: 2200 }
};

export const IMAGE_BUCKET = 'social-media';
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp'
};

// Characters as the platforms count them: an emoji is one
export const charCount = (text: string) => Array.from(text || '').length;
const HASHTAG = new RegExp('#[\\p{L}\\p{N}_]+', 'gu');
export const hashtagCount = (text: string) => (text || '').match(HASHTAG)?.length || 0;

export const statusLabel = (status: string, approvalOn: boolean) => ({
  draft: 'Draft',
  needs_approval: 'Needs approval',
  approved: approvalOn ? 'Approved' : 'Ready',
  scheduled: 'Scheduled',
  posted: 'Posted'
} as Record<string, string>)[status] || status;

export const statusClass = (status: string) =>
  status === 'posted' ? 'paid' : status === 'needs_approval' ? 'open' : status === 'scheduled' ? 'sent' : '';

export const imageUrl = (path: string) => getSupabase().storage.from(IMAGE_BUCKET).getPublicUrl(path).data.publicUrl;

export const formatWhen = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'No date yet';

// <input type="datetime-local"> works in local time with no zone
export const toLocalInput = (value: string | null | undefined) => {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

const fromLocalInput = (value: string) => (value ? new Date(value).toISOString() : null);

export const memberName = (members: any[], userId: string | null) =>
  members.find((member) => member.user_id === userId)?.email || (userId ? 'Someone who left' : '—');

const extensionOf = (fileName: string) => (fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '');
const safeFileName = (fileName: string) =>
  fileName.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+/, '').slice(-100) || 'image';
export const fileSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const removeImage = (path: string | null | undefined) =>
  path ? getSupabase().storage.from(IMAGE_BUCKET).remove([path]).catch(() => null) : null;

export const accountLabel = (account: any) => `${PLATFORMS[account?.platform]?.name || ''} · ${account?.handle || ''}`;

// The platform's own page for writing a post. X and LinkedIn take the text; Facebook takes a link.
const composeUrl = (platform: string, body: string, link: string | null) => {
  if (platform === 'x') {
    return `https://twitter.com/intent/tweet?text=${encodeURIComponent(body)}${link && !body.includes(link) ? `&url=${encodeURIComponent(link)}` : ''}`;
  }
  if (platform === 'linkedin') return `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(body)}`;
  if (platform === 'facebook') {
    return link ? `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(link)}` : 'https://www.facebook.com/';
  }
  return 'https://www.instagram.com/';
};

const POST_HINT: Record<string, string> = {
  x: 'X opens with your text filled in. Add the image if there is one, then post.',
  linkedin: 'LinkedIn opens a new post. If the text isn’t there, paste it (it’s copied). Add the image if there is one.',
  facebook: 'Facebook opens. Paste the text (it’s copied) and add the image if there is one.',
  instagram: 'Instagram opens. Choose Create, add the image (download it below first), and paste the text as the caption.'
};

function TextCounter({ platform, body }: { platform: string; body: string }) {
  const limit = PLATFORMS[platform]?.limit || 0;
  const used = charCount(body);
  const tags = hashtagCount(body);
  return (
    <small className={used > limit ? 'error' : 'muted'}>
      {used.toLocaleString()} / {limit.toLocaleString()} characters · {tags} hashtag{tags === 1 ? '' : 's'}
      {platform === 'instagram' && tags > 30 ? ' (Instagram allows 30)' : ''}
      {platform === 'x' && /https?:\/\//.test(body) ? ' · X counts each link as 23' : ''}
    </small>
  );
}

export function PostForm({ overview, accounts, post, startDate, onClose, onSaved }: {
  overview: any; accounts: any[]; post?: any; startDate?: string; onClose: () => void; onSaved: (post: any) => void;
}) {
  const existing = new Map<string, string>((post?.targets || []).map((target: any) => [target.account_id, target.body]));
  const usable = accounts.filter((account) => account.is_active || existing.has(account.id));
  const [form, setForm] = useState({
    title: post?.title || '',
    campaign: post?.campaign || '',
    tags: (post?.tags || []).join(', '),
    link_url: post?.link_url || '',
    scheduled_at: post ? toLocalInput(post.scheduled_at) : startDate || '',
    assigned_to: post?.assigned_to || '',
    notes: post?.notes || ''
  });
  const [bodies, setBodies] = useState<Record<string, string>>(Object.fromEntries(existing));
  const [chosen, setChosen] = useState<string[]>(Array.from(existing.keys()));
  const [keepImage, setKeepImage] = useState(Boolean(post?.image_path));
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm({ ...form, [field]: value });

  const toggle = (accountId: string) =>
    setChosen(chosen.includes(accountId) ? chosen.filter((value) => value !== accountId) : [...chosen, accountId]);

  const copyToAll = (from: string) =>
    setBodies(Object.fromEntries(chosen.map((accountId) => [accountId, bodies[from] || ''])));

  const choose = (picked: File | null) => {
    setError('');
    setFile(null);
    if (!picked) return;
    if (!IMAGE_TYPES[extensionOf(picked.name)]) return setError('Choose a JPEG, PNG, GIF or WebP image.');
    if (picked.size > IMAGE_MAX_BYTES) return setError(`That image is ${fileSize(picked.size)}. Images can be up to 5 MB.`);
    if (picked.size === 0) return setError('That file is empty.');
    setFile(picked);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const over = chosen.map((accountId) => accounts.find((account) => account.id === accountId))
      .find((account) => account && charCount(bodies[account.id] || '') > PLATFORMS[account.platform].limit);
    if (over) return setError(`The text for ${over.handle} is too long for ${PLATFORMS[over.platform].name}.`);
    setBusy(true);
    setError('');
    const storage = getSupabase().storage.from(IMAGE_BUCKET);
    let uploaded: string | null = null;
    try {
      if (file) {
        uploaded = `${overview.tenant_id}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
        const { error: uploadError } = await storage.upload(uploaded, file, { upsert: false, contentType: IMAGE_TYPES[extensionOf(file.name)] });
        if (uploadError) {
          uploaded = null;
          throw new Error('The image couldn’t be uploaded. Check it’s a JPEG, PNG, GIF or WebP up to 5 MB, and that your company has image space left.');
        }
      }
      const body = {
        ...form,
        tags: form.tags.split(/[\s,]+/).filter(Boolean),
        scheduled_at: fromLocalInput(form.scheduled_at),
        assigned_to: form.assigned_to || null,
        image_path: uploaded || (keepImage ? post?.image_path : null),
        targets: chosen.map((accountId) => ({
          account_id: accountId,
          platform: accounts.find((account) => account.id === accountId)?.platform,
          body: bodies[accountId] || ''
        }))
      };
      let result;
      try {
        result = post ? await api.put(`/api/social-media/posts/${post.id}`, body) : await api.post('/api/social-media/posts', body);
      } catch (err) {
        // Don't leave an image behind that no post points to
        await removeImage(uploaded);
        throw err;
      }
      await removeImage(result.removed_image);
      if (result.approval_reset) window.alert('You changed what was approved, so this post is back in draft. Send it for approval again.');
      onSaved(result.post);
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={post ? 'Edit post' : 'New post'}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Name (only your team sees this)<input required maxLength={200} value={form.title} onChange={(e) => set('title', e.target.value)} /></label>
          <label>Date and time<input type="datetime-local" value={form.scheduled_at} onChange={(e) => set('scheduled_at', e.target.value)} /></label>
          <label>Looked after by
            <select value={form.assigned_to} onChange={(e) => set('assigned_to', e.target.value)}>
              <option value="">No one yet</option>
              {overview.members.filter((member: any) => member.role !== 'viewer' || member.user_id === form.assigned_to)
                .map((member: any) => <option key={member.user_id} value={member.user_id}>{member.email}</option>)}
            </select>
          </label>
          <label>Campaign<input maxLength={100} list="social-campaigns" value={form.campaign} onChange={(e) => set('campaign', e.target.value)} /></label>
          <label>Tags (comma separated)<input value={form.tags} onChange={(e) => set('tags', e.target.value)} placeholder="launch, offers" /></label>
          <label>Link to share (optional)<input type="url" maxLength={500} placeholder="https://" value={form.link_url} onChange={(e) => set('link_url', e.target.value)} /></label>
        </div>
        <datalist id="social-campaigns">{overview.campaigns.map((name: string) => <option key={name} value={name} />)}</datalist>

        <h3 className="social-heading">Accounts and text</h3>
        {usable.length === 0 && <p className="muted">Add your accounts under Accounts first.</p>}
        <div className="social-accounts">
          {usable.map((account) => (
            <label key={account.id} className="check">
              <input type="checkbox" checked={chosen.includes(account.id)} onChange={() => toggle(account.id)} />
              {accountLabel(account)}{account.is_active ? '' : ' (turned off)'}
            </label>
          ))}
        </div>
        {chosen.map((accountId) => {
          const account = accounts.find((row) => row.id === accountId);
          if (!account) return null;
          return (
            <div key={accountId} className="social-target">
              <label>{accountLabel(account)}
                <textarea rows={account.platform === 'x' ? 3 : 5} value={bodies[accountId] || ''}
                  onChange={(e) => setBodies({ ...bodies, [accountId]: e.target.value })} />
              </label>
              <div className="social-target-foot">
                <TextCounter platform={account.platform} body={bodies[accountId] || ''} />
                {chosen.length > 1 && <button type="button" className="link" onClick={() => copyToAll(accountId)}>Use this text for all</button>}
              </div>
            </div>
          );
        })}

        <h3 className="social-heading">Image (optional)</h3>
        {keepImage && post?.image_path && !file ? (
          <div className="social-image-row">
            <img src={imageUrl(post.image_path)} alt="" className="social-thumb" />
            <button type="button" onClick={() => setKeepImage(false)}>Remove image</button>
          </div>
        ) : (
          <input type="file" accept="image/jpeg,image/png,image/gif,image/webp" onChange={(e) => choose(e.target.files?.[0] || null)} />
        )}
        <p className="muted">JPEG, PNG, GIF or WebP up to 5 MB. Images are public to anyone who has the link, so platforms can show them.</p>

        <label style={{ marginTop: 12 }}>Notes for the team<textarea rows={2} maxLength={2000} value={form.notes} onChange={(e) => set('notes', e.target.value)} /></label>
        {post && overview.require_approval && !overview.is_manager && ['approved', 'scheduled'].includes(post.status) && (
          <p className="muted">Changing the text, image, link or date sends this post back to draft for approval again.</p>
        )}
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

// One post: its text for each account, the steps to get it out, and recording the live links
export function PostView({ post, overview, onClose, onEdit, onChanged }: {
  post: any; overview: any; onClose: () => void; onEdit: () => void; onChanged: () => void;
}) {
  const [links, setLinks] = useState<Record<string, string>>({});
  const [opened, setOpened] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const approvalOn = overview.require_approval;
  const canEdit = overview.can_edit;
  const waiting = approvalOn && ['draft', 'needs_approval'].includes(post.status);

  const act = async (work: () => Promise<any>, done?: string) => {
    setError('');
    setNotice('');
    try {
      await work();
      if (done) setNotice(done);
      onChanged();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const submitLabel = approvalOn && !overview.is_manager ? 'Send for approval' : post.scheduled_at ? 'Schedule' : 'Mark ready';

  // The link carries the campaign (utm_ tags) so leads, contacts and chats it brings in are counted
  const postNow = async (target: any) => {
    setError('');
    const link = withTracking(post.link_url, target.platform, post.campaign);
    const body = post.link_url && link !== post.link_url ? (target.body || '').split(post.link_url).join(link) : target.body;
    try {
      await navigator.clipboard.writeText(body);
      setNotice('Text copied.');
    } catch {
      setNotice('Copy the text yourself, then paste it on the platform.');
    }
    window.open(composeUrl(target.platform, body, link || null), '_blank', 'noopener');
    setOpened(target.id);
  };

  const sendBack = () => {
    const note = window.prompt('What needs changing? (optional)');
    if (note === null) return;
    act(() => api.post(`/api/social-media/posts/${post.id}/decide`, { approve: false, note }), 'Sent back to draft.');
  };

  const remove = async () => {
    if (!window.confirm(`Delete “${post.title}”? This can’t be undone. Anything already on the platforms stays there.`)) return;
    setError('');
    try {
      const result = await api.delete(`/api/social-media/posts/${post.id}`);
      await removeImage(result.removed_image);
      onChanged();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title={post.title}>
      <div className="stack">
        <div className="facts">
          <div><div className="stat-label">Status</div><span className={`badge ${statusClass(post.status)}`}>{statusLabel(post.status, approvalOn)}</span></div>
          <div><div className="stat-label">When</div>{formatWhen(post.scheduled_at)}</div>
          <div><div className="stat-label">Looked after by</div>{memberName(overview.members, post.assigned_to)}</div>
          <div><div className="stat-label">Campaign</div>{post.campaign || '—'}{post.tags?.length ? <div className="muted">{post.tags.map((tag: string) => `#${tag}`).join(' ')}</div> : null}</div>
        </div>
        {post.review_note && <p className="muted">Note from approval: {post.review_note}</p>}
        {post.notes && <p className="muted wrap">Notes: {post.notes}</p>}
        {post.link_url && <p>Link: <a href={post.link_url} target="_blank" rel="noopener noreferrer">{post.link_url}</a></p>}
        {post.link_url && post.campaign && withTracking(post.link_url, 'x', post.campaign) !== post.link_url && (
          <p className="muted">“Post now” adds the campaign to the link for each platform, so the Results view can count who it brings in.</p>
        )}
        {post.image_path && (
          <div className="social-image-row">
            <img src={imageUrl(post.image_path)} alt="" className="social-thumb" />
            <a href={imageUrl(post.image_path)} target="_blank" rel="noopener noreferrer" download>Open or download image</a>
          </div>
        )}

        <p className="muted">You post from each platform yourself: “Post now” copies the text and opens the platform. Then paste the live post’s link to mark it as posted.</p>
        {waiting && <p className="muted">This post needs approval before it goes out.</p>}

        {post.targets.map((target: any) => (
          <div key={target.id} className="social-target">
            <div className="social-target-foot">
              <strong>{accountLabel(target.account)}</strong>
              {target.posted_at ? <span className="badge paid">Posted</span> : null}
            </div>
            <p className="social-body">{target.body || <span className="muted">No text</span>}</p>
            <TextCounter platform={target.platform} body={target.body} />
            {target.posted_at ? (
              <div className="row-actions social-left">
                <a href={target.post_url} target="_blank" rel="noopener noreferrer">View live post</a>
                {canEdit && <button onClick={() => act(() => api.delete(`/api/social-media/targets/${target.id}/posted`))}>Undo posted</button>}
              </div>
            ) : canEdit && !waiting ? (
              <>
                {opened === target.id && <p className="muted">{POST_HINT[target.platform]}</p>}
                <div className="social-mark">
                  <button className="primary" type="button" onClick={() => postNow(target)}>Post now</button>
                  <input type="url" placeholder="Paste the live post link" value={links[target.id] || ''}
                    onChange={(e) => setLinks({ ...links, [target.id]: e.target.value })} />
                  <button type="button" disabled={!links[target.id]}
                    onClick={() => act(() => api.post(`/api/social-media/targets/${target.id}/posted`, { post_url: links[target.id] }), 'Marked as posted.')}>
                    Mark as posted
                  </button>
                </div>
              </>
            ) : null}
          </div>
        ))}
        {post.targets.length === 0 && <p className="muted">No accounts chosen yet.</p>}

        {error && <p className="error">{error}</p>}
        {notice && <p className="notice">{notice}</p>}
        <div className="form-actions social-actions">
          {canEdit && post.status !== 'posted' && <button onClick={onEdit}>Edit</button>}
          {canEdit && (post.status === 'draft' || (post.status === 'needs_approval' && !approvalOn)) && (
            <button className="primary" onClick={() => act(() => api.post(`/api/social-media/posts/${post.id}/submit`, {}),
              approvalOn && !overview.is_manager ? 'Sent for approval.' : 'Done.')}>
              {submitLabel}
            </button>
          )}
          {overview.is_manager && post.status === 'needs_approval' && approvalOn && (
            <>
              <button className="primary" onClick={() => act(() => api.post(`/api/social-media/posts/${post.id}/decide`, { approve: true }), 'Approved.')}>Approve</button>
              <button onClick={sendBack}>Send back</button>
            </>
          )}
          {canEdit && ['needs_approval', 'approved', 'scheduled'].includes(post.status) && (
            <button onClick={() => act(() => api.post(`/api/social-media/posts/${post.id}/draft`, {}), 'Back in draft.')}>Back to draft</button>
          )}
          {canEdit && <button className="danger" onClick={remove}>Delete</button>}
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </Modal>
  );
}
