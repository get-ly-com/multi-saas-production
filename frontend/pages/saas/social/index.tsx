import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import AppShell from '@/components/AppShell';
import SocialNav from '@/components/SocialNav';
import {
  PLATFORMS, PostForm, PostView, formatWhen, memberName, statusClass, statusLabel, toLocalInput
} from '@/components/SocialForms';
import { api } from '@/lib/api';

export default function Social() {
  return <AppShell><Planner /></AppShell>;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const STATUSES = ['draft', 'needs_approval', 'approved', 'scheduled', 'posted'];

const dayKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

// Six weeks from the Monday on or before the 1st, in local time
const monthGrid = (month: Date) => {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index));
};

function Planner() {
  const router = useRouter();
  const [overview, setOverview] = useState<any>(null);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [posts, setPosts] = useState<any[]>([]);
  const [undated, setUndated] = useState<any[]>([]);
  const [view, setView] = useState<'calendar' | 'list'>('calendar');
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [filters, setFilters] = useState({ campaign: '', tag: '', status: '', account_id: '' });
  const [open, setOpen] = useState<any>(null);
  const [editing, setEditing] = useState<any>(null);
  const [error, setError] = useState('');
  const latest = useRef(0);

  const loadSetup = async () => {
    const [summary, list] = await Promise.all([api.get('/api/social-media/overview'), api.get('/api/social-media/accounts')]);
    setOverview(summary);
    setAccounts(list);
  };

  const query = (extra: Record<string, string>) => {
    const params = new URLSearchParams();
    Object.entries({ ...filters, ...extra }).forEach(([key, value]) => value && params.set(key, value));
    return params.toString();
  };

  const loadPosts = async () => {
    // Only the newest load is shown, so quick filter changes can't be overwritten by an older answer
    const mine = ++latest.current;
    try {
      if (view === 'calendar') {
        const days = monthGrid(month);
        const end = new Date(days[41]);
        end.setDate(end.getDate() + 1);
        const [inMonth, noDate] = await Promise.all([
          api.get(`/api/social-media/posts?${query({ from: days[0].toISOString(), to: end.toISOString() })}`),
          api.get(`/api/social-media/posts?${query({ undated: '1' })}`)
        ]);
        if (mine !== latest.current) return;
        setPosts(inMonth);
        setUndated(noDate);
      } else {
        const all = await api.get(`/api/social-media/posts?${query({})}`);
        if (mine !== latest.current) return;
        setPosts(all);
        setUndated([]);
      }
      setError('');
    } catch (err: any) {
      if (mine === latest.current) setError(err.message);
    }
  };

  const refresh = async () => {
    await Promise.all([loadPosts(), loadSetup().catch(() => null)]);
    if (open) setOpen(await api.get(`/api/social-media/posts/${open.id}`).catch(() => null));
  };

  useEffect(() => {
    loadSetup().catch((err) => setError(err.message));
    // Bell alerts for posts due today, in case the scheduled check hasn't run yet
    api.post('/api/social-media/check-due', {}).catch(() => null);
  }, []);

  useEffect(() => {
    loadPosts();
  }, [view, month, filters]);

  // Opening a post from an alert: /saas/social?post=<id>
  useEffect(() => {
    const postId = router.query.post;
    if (typeof postId !== 'string') return;
    api.get(`/api/social-media/posts/${postId}`).then(setOpen).catch((err) => setError(err.message));
  }, [router.query.post]);

  const close = () => {
    setOpen(null);
    if (router.query.post) router.replace('/saas/social', undefined, { shallow: true });
  };

  if (!overview) return <div className="stack"><SocialNav />{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</div>;

  const counts = overview.counts || {};
  const approvalOn = overview.require_approval;
  const today = dayKey(new Date());
  const byDay = new Map<string, any[]>();
  posts.forEach((post) => {
    if (!post.scheduled_at) return;
    const key = dayKey(new Date(post.scheduled_at));
    byDay.set(key, [...(byDay.get(key) || []), post]);
  });

  const newOn = (date?: Date) => {
    const start = date ? new Date(date.getFullYear(), date.getMonth(), date.getDate(), 9, 0) : null;
    setEditing({ post: null, startDate: start ? toLocalInput(start.toISOString()) : '' });
  };

  const setFilter = (field: string, value: string) => setFilters({ ...filters, [field]: value });
  const moveMonth = (by: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + by, 1));

  const chip = (post: any) => (
    <button key={post.id} className={`social-chip ${post.status}`} onClick={() => setOpen(post)}
      title={`${post.title} · ${statusLabel(post.status, approvalOn)}`}>
      <span>{new Date(post.scheduled_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span> {post.title}
    </button>
  );

  return (
    <div className="stack">
      <SocialNav />
      <div className="page-head">
        <h1>Social planner</h1>
        {overview.can_edit && <button className="primary" onClick={() => newOn()} disabled={accounts.length === 0}>New post</button>}
      </div>
      <p className="muted">Plan and approve posts here, then publish them yourself from each platform. This app doesn’t post to your accounts and never asks for their passwords.</p>
      {accounts.length === 0 && (
        <p className="notice">Start by listing your company’s accounts under <Link href="/saas/social/accounts">Accounts</Link>.</p>
      )}
      {error && <p className="error">{error}</p>}

      <div className="stats">
        {approvalOn && <div className="card"><div className="stat-label">Needs approval</div><div className="stat-value">{counts.needs_approval || 0}</div></div>}
        <div className="card"><div className="stat-label">Scheduled</div><div className="stat-value">{counts.scheduled || 0}</div></div>
        <div className="card"><div className="stat-label">{approvalOn ? 'Approved, no date' : 'Ready, no date'}</div><div className="stat-value">{counts.approved || 0}</div></div>
        <div className="card"><div className="stat-label">Drafts</div><div className="stat-value">{counts.draft || 0}</div></div>
        <div className="card"><div className="stat-label">Posted</div><div className="stat-value">{counts.posted || 0}</div></div>
      </div>

      <div className="card">
        <div className="social-toolbar">
          <div className="tabs">
            <button className={view === 'calendar' ? 'active' : ''} onClick={() => setView('calendar')}>Calendar</button>
            <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>List</button>
          </div>
          <div className="report-filters">
            <label>Campaign
              <select value={filters.campaign} onChange={(e) => setFilter('campaign', e.target.value)}>
                <option value="">All</option>
                {overview.campaigns.map((name: string) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <label>Tag
              <select value={filters.tag} onChange={(e) => setFilter('tag', e.target.value)}>
                <option value="">All</option>
                {overview.tags.map((tag: string) => <option key={tag} value={tag}>#{tag}</option>)}
              </select>
            </label>
            <label>Account
              <select value={filters.account_id} onChange={(e) => setFilter('account_id', e.target.value)}>
                <option value="">All</option>
                {accounts.map((account) => <option key={account.id} value={account.id}>{PLATFORMS[account.platform].name} · {account.handle}</option>)}
              </select>
            </label>
            <label>Status
              <select value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
                <option value="">All</option>
                {STATUSES.filter((status) => approvalOn || status !== 'needs_approval')
                  .map((status) => <option key={status} value={status}>{statusLabel(status, approvalOn)}</option>)}
              </select>
            </label>
          </div>
        </div>

        {view === 'calendar' ? (
          <>
            <div className="page-head social-month">
              <button onClick={() => moveMonth(-1)} aria-label="Previous month">‹</button>
              <h2>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
              <button onClick={() => moveMonth(1)} aria-label="Next month">›</button>
              <button className="link" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>This month</button>
            </div>
            <div className="social-calendar">
              {WEEKDAYS.map((name) => <div key={name} className="social-weekday">{name}</div>)}
              {monthGrid(month).map((date) => {
                const key = dayKey(date);
                const items = byDay.get(key) || [];
                return (
                  <div key={key} className={`social-day${date.getMonth() !== month.getMonth() ? ' other' : ''}${key === today ? ' today' : ''}`}>
                    <div className="social-day-head">
                      <span>{date.getDate()}</span>
                      {overview.can_edit && accounts.length > 0 && (
                        <button className="link social-add" onClick={() => newOn(date)} aria-label={`New post on ${date.toLocaleDateString()}`}>+</button>
                      )}
                    </div>
                    {items.map(chip)}
                  </div>
                );
              })}
            </div>
            {undated.length > 0 && (
              <div className="social-undated">
                <h2>No date yet</h2>
                {undated.map((post) => (
                  <button key={post.id} className={`social-chip ${post.status}`} onClick={() => setOpen(post)}>{post.title}</button>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Post</th><th>Accounts</th><th>Campaign</th><th>Looked after by</th><th>Status</th></tr></thead>
              <tbody>
                {posts.length === 0 && <tr><td colSpan={6} className="empty">No posts yet</td></tr>}
                {posts.map((post) => (
                  <tr key={post.id}>
                    <td>{formatWhen(post.scheduled_at)}</td>
                    <td><button className="link" onClick={() => setOpen(post)}>{post.title}</button></td>
                    <td className="wrap">{post.targets.map((target: any) => `${PLATFORMS[target.platform].name}${target.posted_at ? ' ✓' : ''}`).join(', ') || '—'}</td>
                    <td>{post.campaign || '—'}</td>
                    <td>{memberName(overview.members, post.assigned_to)}</td>
                    <td><span className={`badge ${statusClass(post.status)}`}>{statusLabel(post.status, approvalOn)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {open && !editing && (
        <PostView post={open} overview={overview} onClose={close} onChanged={refresh}
          onEdit={() => setEditing({ post: open })} />
      )}
      {editing && (
        <PostForm overview={overview} accounts={accounts} post={editing.post} startDate={editing.startDate}
          onClose={() => setEditing(null)}
          onSaved={async (saved) => {
            await refresh();
            setOpen(await api.get(`/api/social-media/posts/${saved.id}`).catch(() => null));
          }} />
      )}
    </div>
  );
}
