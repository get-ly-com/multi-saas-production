import Link from 'next/link';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import CrmNav from '@/components/CrmNav';
import { toast } from '@/components/Toast';
import EmptyState from '@/components/EmptyState';
import { SkeletonTable } from '@/components/Skeleton';
import { api } from '@/lib/api';

const REASONS: Record<string, string> = { email: 'Same email', phone: 'Same phone', name: 'Same name' };

export default function Duplicates() {
  return <AppShell><DuplicatesApp /></AppShell>;
}

function DuplicatesApp() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');


  const load = async () => {
    try {
      setData(await api.get('/api/crm/duplicates'));
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const merge = async (kind: string, group: any, keep: any) => {
    const others = group.rows.filter((row: any) => row.id !== keep.id);
    if (!window.confirm(`Keep ${keep.name} and merge ${others.map((row: any) => row.name).join(', ')} into it? This can't be undone.`)) return;
    try {
      for (const other of others) {
        await api.post(`/api/crm/${kind}/${keep.id}/merge`, { drop_id: other.id });
      }
      toast.success(`Merged into ${keep.name}`, { detail: `${others.length} ${others.length === 1 ? 'record' : 'records'} combined. Their timelines moved across.` });
    } catch (err: any) {
      toast.error('Could not merge', { detail: err.message });
    }
    await load().catch(() => null);
  };

  const empty = data && !data.contacts.length && !data.leads.length && !data.leads_in_contacts.length;

  return (
    <div className="stack">
      <CrmNav />
      <div className="page-head">
        <div>
          <h1>Duplicates</h1>
          <p className="muted">People who look like they're in here twice. Keep the best one and merge the rest into it.</p>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {!data && !error && <SkeletonTable rows={4} columns={4} />}
      {empty && (
        <div className="card">
          <EmptyState tone="done" icon="inbox" title="No duplicates" line="Every contact and lead is here once. Nice and tidy."
            action={{ label: 'See contacts', href: '/saas/crm/contacts' }} />
        </div>
      )}

      {data && data.contacts.length > 0 && <Groups title="Contacts" kind="contacts" path="contact" groups={data.contacts} merge={merge} />}
      {data && data.leads.length > 0 && <Groups title="Leads" kind="leads" path="lead" groups={data.leads} merge={merge} />}

      {data && data.leads_in_contacts.length > 0 && (
        <div className="card table-wrap">
          <h2>Leads that are already contacts</h2>
          <p className="muted">Open the lead and convert it to add it to the contact.</p>
          <table>
            <thead><tr><th>Lead</th><th>Email or phone</th><th>Contact</th></tr></thead>
            <tbody>
              {data.leads_in_contacts.map((row: any) => (
                <tr key={`${row.id}-${row.contact_id}`}>
                  <td className="wrap"><Link href={`/saas/crm/lead/${row.id}`}>{row.name}</Link></td>
                  <td>{row.email || row.phone}</td>
                  <td className="wrap"><Link href={`/saas/crm/contact/${row.contact_id}`}>{row.contact_name}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Groups({ title, kind, path, groups, merge }: { title: string; kind: string; path: string; groups: any[]; merge: (kind: string, group: any, keep: any) => void }) {
  return (
    <div className="card table-wrap">
      <h2>{title}</h2>
      {groups.map((group) => (
        <table key={group.rows.map((row: any) => row.id).join()} className="duplicate-group">
          <thead><tr><th colSpan={4}>{REASONS[group.reason]}</th></tr></thead>
          <tbody>
            {group.rows.map((row: any) => (
              <tr key={row.id}>
                <td className="wrap"><Link href={`/saas/crm/${path}/${row.id}`}>{row.name}</Link></td>
                <td>{row.email || '—'}</td>
                <td>{row.company_name || row.phone || '—'}</td>
                <td><div className="row-actions"><button onClick={() => merge(kind, group, row)}>Keep this one</button></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </div>
  );
}
