import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import EmptyState from '@/components/EmptyState';
import Skeleton, { SkeletonTable } from '@/components/Skeleton';
import SocialNav from '@/components/SocialNav';
import { PLATFORMS, PlatformMark } from '@/components/SocialForms';
import { api, money } from '@/lib/api';

export default function SocialResults() {
  return <AppShell><Results /></AppShell>;
}

type Row = {
  name: string;
  has_posts: boolean;
  posts: number;
  posted: number;
  leads: number;
  contacts: number;
  chats: number;
  won_deals: number;
  won_value: number;
};

function Results() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/social-media/campaign-results')
      .then(setRows)
      .catch((err: any) => setError(err.message));
  }, []);

  return (
    <div className="stack">
      <SocialNav />
      <div className="page-head">
        <div>
          <h1>Results</h1>
          <p className="muted">What each campaign brought in, from posted links to leads and won deals.</p>
        </div>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        When you press “Post now”, the post’s link gets the campaign added, so people who fill in your web form, start a chat
        or book a meeting from it are counted here. Names match whatever the capitals.
      </p>
      {error && <p className="error">{error}</p>}
      {!rows && !error && <SkeletonTable rows={4} columns={6} />}
      {rows?.length === 0 && (
        <div className="card">
          <EmptyState icon="social" title="No campaigns yet" line="Give a post a campaign name and its leads, chats and deals will add up here."
            action={{ label: 'Open the planner', href: '/saas/social' }} />
        </div>
      )}
      {rows && rows.length > 0 && (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Campaign</th><th className="num">Posts posted</th><th className="num">Leads</th><th className="num">Contacts</th><th className="num">Chats</th><th className="num">Won deals</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name.toLowerCase()}>
                  <td>{row.name}{!row.has_posts && <div className="muted">No posts with this campaign</div>}</td>
                  <td className="num">{row.has_posts ? `${row.posted} of ${row.posts}` : '—'}</td>
                  <td className="num">{row.leads}</td>
                  <td className="num">{row.contacts}</td>
                  <td className="num">{row.chats}</td>
                  <td className="num">{row.won_deals ? `${money(row.won_value)} (${row.won_deals})` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <BestTimes />
    </div>
  );
}

const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const hourBlock = (hour: number) => `${String(hour).padStart(2, '0')}:00–${String(hour + 3).padStart(2, '0')}:00`;

// When the company's own posts got the most interactions (likes, comments, shares and clicks typed
// in on each posted account), in the planner's time zone
function BestTimes() {
  const [platform, setPlatform] = useState('');
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setData(null);
    api.get(`/api/social-media/best-times${platform ? `?platform=${platform}` : ''}`)
      .then(setData)
      .catch((err: any) => setError(err.message));
  }, [platform]);

  const most = data ? Math.max(1, ...data.by_weekday.map((row: any) => Number(row.average) || 0)) : 1;

  return (
    <div className="card stack">
      <div className="page-head">
        <h2>Best times to post</h2>
        <select aria-label="Platform" style={{ width: 'auto' }} value={platform} onChange={(e) => setPlatform(e.target.value)}>
          <option value="">All platforms</option>
          {Object.entries(PLATFORMS).map(([key, value]) => <option key={key} value={key}>{value.name}</option>)}
        </select>
      </div>
      {error && <p className="error">{error}</p>}
      {!data && !error && <div style={{ display: 'grid', gap: 10 }}><Skeleton width="70%" /><Skeleton height={180} radius={8} /></div>}
      {data && (
        <>
          <p className="muted">
            From your posts in the last year ({data.posted} posted, {data.with_stats} with results), in {data.timezone} time.
            Open a posted post and type in its likes, comments, shares and clicks from the platform to fill this in.
          </p>
          {!data.enough && <p className="notice">Add results to at least 5 posted accounts for a reliable picture. Until then, treat this as a hint.</p>}
          {data.best.length > 0 && (
            <ol className="social-best">
              {data.best.map((slot: any) => (
                <li key={`${slot.weekday}-${slot.hour}`}>
                  <strong>{DAY_NAMES[slot.weekday]}, {hourBlock(slot.hour)}</strong> · {slot.average} interactions a post on average ({slot.with_stats} post{slot.with_stats === 1 ? '' : 's'})
                </li>
              ))}
            </ol>
          )}
          <div className="table-wrap">
            <table>
              <thead><tr><th>Day</th><th>Posts</th><th>Interactions a post</th><th /></tr></thead>
              <tbody>
                {data.by_weekday.map((row: any) => (
                  <tr key={row.weekday}>
                    <td>{DAY_NAMES[row.weekday]}</td>
                    <td>{row.posts}</td>
                    <td>{row.average ?? '—'}</td>
                    <td style={{ width: '40%' }}><div className="social-meter"><span style={{ width: `${((Number(row.average) || 0) / most) * 100}%` }} /></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.by_platform.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Platform</th><th>Posted</th><th>With results</th><th>Interactions a post</th><th>Views</th></tr></thead>
                <tbody>
                  {data.by_platform.map((row: any) => (
                    <tr key={row.platform}>
                      <td><span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><PlatformMark platform={row.platform} />{PLATFORMS[row.platform]?.name || row.platform}</span></td>
                      <td>{row.posts}</td>
                      <td>{row.with_stats}</td>
                      <td>{row.average ?? '—'}</td>
                      <td>{row.views ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
