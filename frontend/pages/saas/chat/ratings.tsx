import Link from 'next/link';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import ChatNav, { stars, timeText } from '@/components/ChatNav';
import { api } from '@/lib/api';

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
        <h1>Ratings</h1>
        <select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {RANGES.map((value) => <option key={value} value={value}>Last {value} days</option>)}
        </select>
      </div>
      <p className="muted">When a chat is closed, the visitor can rate it from 1 to 5 and leave a comment. A rating of 1 or 2 alerts the person who had the chat. You can turn ratings off in Settings.</p>
      {error && <p className="error">{error}</p>}
      {!stats && !error && <p className="empty">Loading…</p>}
      {stats && (
        <>
          <div className="stats">
            <div className="card"><div className="stat-label">Average</div><div className="stat-value">{stats.count ? `${Number(stats.average).toFixed(1)} / 5` : '—'}</div></div>
            <div className="card"><div className="stat-label">Ratings</div><div className="stat-value">{stats.count}</div>
              <small className="muted">of {stats.closed} chats closed</small></div>
            <div className="card"><div className="stat-label">Happy (4 or 5)</div><div className="stat-value">{stats.count ? `${stats.happy_percent}%` : '—'}</div></div>
          </div>
          <div className="card stack">
            <h2>Scores</h2>
            {[5, 4, 3, 2, 1].map((score) => (
              <div key={score} className="chat-score-row">
                <span>{stars(score)}</span>
                <div className="social-meter"><span style={{ width: `${(Number(stats.scores[score]) / most) * 100}%` }} /></div>
                <span>{stats.scores[score]}</span>
              </div>
            ))}
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Person</th><th>Ratings</th><th>Average</th></tr></thead>
              <tbody>
                {stats.by_person.length === 0 && <tr><td colSpan={3} className="empty">No ratings yet</td></tr>}
                {stats.by_person.map((row: any) => (
                  <tr key={row.user_id || 'nobody'}><td>{row.email || 'Nobody had the chat'}</td><td>{row.count}</td><td>{Number(row.average).toFixed(1)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Visitor</th><th>Rating</th><th>Comment</th></tr></thead>
              <tbody>
                {stats.recent.length === 0 && <tr><td colSpan={4} className="empty">No ratings yet</td></tr>}
                {stats.recent.map((row: any) => (
                  <tr key={row.conversation_id}>
                    <td>{timeText(row.rated_at)}</td>
                    <td><Link href={`/saas/chat?c=${row.conversation_id}`}>{row.visitor}</Link></td>
                    <td title={`${row.rating} of 5`}>{stars(row.rating)}</td>
                    <td className="wrap">{row.comment || '—'}</td>
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
