import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import SocialNav from '@/components/SocialNav';
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
        <h1>Results</h1>
      </div>
      <p className="muted">
        What each campaign brought in. When you press “Post now”, the post’s link gets the campaign added, so people who
        fill in your web form, start a chat or book a meeting from it are counted here. Names match whatever the capitals.
      </p>
      {error && <p className="error">{error}</p>}
      {!rows && !error && <p className="empty">Loading…</p>}
      {rows && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Campaign</th><th>Posts posted</th><th>Leads</th><th>Contacts</th><th>Chats</th><th>Won deals</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={6} className="empty">No campaigns yet. Give a post a campaign name to see its results.</td></tr>}
              {rows.map((row) => (
                <tr key={row.name.toLowerCase()}>
                  <td>{row.name}{!row.has_posts && <div className="muted">No posts with this campaign</div>}</td>
                  <td>{row.has_posts ? `${row.posted} of ${row.posts}` : '—'}</td>
                  <td>{row.leads}</td>
                  <td>{row.contacts}</td>
                  <td>{row.chats}</td>
                  <td>{row.won_deals ? `${money(row.won_value)} (${row.won_deals})` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
