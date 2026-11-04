import Link from 'next/link';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import ChatNav, { stars, timeText } from '@/components/ChatNav';
import EmptyState from '@/components/EmptyState';
import { SkeletonStats, SkeletonTable } from '@/components/Skeleton';
import { api } from '@/lib/api';
import c from '@/styles/chat.module.css';

export default function ChatRatings() {
  return <AppShell><Ratings /></AppShell>;
}

const RANGES = [7, 30, 90, 365];

// What visitors said when their chat was closed, overall and for each person
function Ratings() {
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setStats(null);
    api.get(`/api/chatbot/ratings?days=${days}`).then(setStats).catch((err: any) => setError(err.message));
  }, [days]);

  const most = stats ? Math.max(1, ...Object.values(stats.scores || {}).map(Number)) : 1;

  return (
    <div className="stack">
      <ChatNav />
      <div className="page-head">
        <div>
          <h1>Ratings</h1>
          <p className="muted">How visitors felt about their chats.</p>
        </div>
        <select style={{ width: 'auto' }} aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {RANGES.map((value) => <option key={value} value={value}>Last {value} days</option>)}
        </select>
      </div>
      <p className="muted small">When a chat is closed, the visitor can rate it from 1 to 5 and leave a comment. A rating of 1 or 2 alerts the person who had the chat. You can turn ratings off in Settings.</p>
      {error && <p className="error">{error}</p>}
      {!stats && !error && <><SkeletonStats count={3} /><SkeletonTable rows={5} columns={3} /></>}
      {stats && !stats.count && (
        <div className="card"><EmptyState icon="star" title="No ratings in this period" line="When a chat closes, the visitor can rate it. Their scores show up here." /></div>
      )}
      {stats && stats.count > 0 && (
        <>
          <div className="stats">
            <div className="card"><div className="stat-label">Average</div><div className="stat-value">{Number(stats.average).toFixed(1)} <span className={c.rating} style={{ fontSize: 'var(--text-md)' }}>{stars(Math.round(Number(stats.average)))}</span></div></div>
            <div className="card"><div className="stat-label">Ratings</div><div className="stat-value">{stats.count}</div>
              <small className="muted">of {stats.closed} chats closed</small></div>
            <div className="card"><div className="stat-label">Happy (4 or 5)</div><div className="stat-value">{stats.happy_percent}%</div></div>
          </div>
          <div className="card stack">
            <h2>Scores</h2>
            {[5, 4, 3, 2, 1].map((score) => (
              <div key={score} className={c.scoreRow}>
                <span className={c.rating}>{stars(score)}</span>
                <div className={c.scoreBar}><span style={{ width: `${(Number(stats.scores[score]) / most) * 100}%` }} /></div>
                <span className="num">{stats.scores[score]}</span>
              </div>
            ))}
          </div>
          <div className="card table-wrap">
            <table>
              <thead><tr><th>Person</th><th className="num">Ratings</th><th className="num">Average</th></tr></thead>
              <tbody>
                {stats.by_person.length === 0 && <tr><td colSpan={3} className="empty">No ratings yet</td></tr>}
                {stats.by_person.map((row: any) => (
                  <tr key={row.user_id || 'nobody'}><td>{row.email || 'Nobody had the chat'}</td><td className="num">{row.count}</td><td className="num">{Number(row.average).toFixed(1)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card table-wrap">
            <table>
              <thead><tr><th>When</th><th>Visitor</th><th>Rating</th><th>Comment</th></tr></thead>
              <tbody>
                {stats.recent.length === 0 && <tr><td colSpan={4} className="empty">No ratings yet</td></tr>}
                {stats.recent.map((row: any) => (
                  <tr key={row.conversation_id}>
                    <td>{timeText(row.rated_at)}</td>
                    <td><Link href={`/saas/chat?c=${row.conversation_id}`}>{row.visitor}</Link></td>
                    <td title={`${row.rating} of 5`} className={c.rating}>{stars(row.rating)}</td>
                    <td className="wrap">{row.comment || <span className="muted">No comment</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
