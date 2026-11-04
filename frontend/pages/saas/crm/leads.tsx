import Link from 'next/link';
import { ChangeEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import CrmNav from '@/components/CrmNav';
import { RecordDrawer, openInDrawer } from '@/components/CrmRecord';
import EmptyState from '@/components/EmptyState';
import { SkeletonTable } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { useTeam } from '@/components/CrmForms';
import { useCustomFields } from '@/components/CustomFields';
import { LeadForm, SOURCES, scoreBadge, scoreLabel, statusBadge, statusLabel } from '@/components/LeadForms';
import SavedViews, { Filters, ListFilters, matchesFilters } from '@/components/SavedViews';
import BulkBar, { useSelection } from '@/components/BulkBar';
import { TagChips, TagFilter, tagNames, useTags } from '@/components/Tags';
import { api, formatDate, today } from '@/lib/api';
import styles from '@/styles/crm.module.css';
import { downloadCsv, readPeople } from '@/lib/csv';

export default function Leads() {
  return <AppShell><LeadsApp /></AppShell>;
}

function LeadsApp() {
  const members = useTeam();
  const fields = useCustomFields('lead');
  const tags = useTags();
  const [leads, setLeads] = useState<any[]>([]);
  const [filters, setFilters] = useState<Filters>({ status: 'open' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [opened, setOpened] = useState<any>(null);
  const [adding, setAdding] = useState(false);

  const load = async () => {
    try {
      setLeads(await api.get('/api/crm/leads'));
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const result = await api.post('/api/crm/leads/import', { rows: readPeople(await file.text()) });
      toast.success(`Imported ${result.created} leads`, { detail: `Skipped ${result.skipped} with no name or an email already here.` });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const set = (name: string, value: string) => setFilters({ ...filters, [name]: value });
  const sources = Array.from(new Set([...SOURCES, ...leads.map((lead) => lead.source).filter(Boolean)]));

  const visible = leads
    .filter((lead) => {
      if (filters.status === 'open' && !['new', 'working'].includes(lead.status)) return false;
      if (filters.status && filters.status !== 'open' && lead.status !== filters.status) return false;
      if (filters.source && lead.source !== filters.source) return false;
      if (filters.temperature && scoreLabel(lead.score) !== filters.temperature) return false;
      return matchesFilters(lead, filters, fields, [lead.name, lead.email, lead.company_name, lead.phone]);
    })
    .sort((a, b) => b.score - a.score);
  const selection = useSelection(visible.map(({ id }) => id));
  const ownerName = (id: string) => members.find(({ user_id }) => user_id === id)?.email || (id ? 'Former member' : 'Unassigned');

  const exportCsv = () => {
    const rows = selection.selected.length ? visible.filter(({ id }) => selection.has(id)) : visible;
    downloadCsv(`leads-${today()}.csv`, [
      ['Name', 'Company', 'Job title', 'Email', 'Phone', 'Score', 'Status', 'Source', 'Campaign', 'Owner', 'Tags', 'Added'],
      ...rows.map((row) => [row.name, row.company_name, row.job_title, row.email, row.phone, row.score, statusLabel[row.status], row.source, row.campaign, ownerName(row.owner_id), tagNames(row.tags, tags), formatDate(row.created_at)])
    ]);
  };

  return (
    <div className="stack">
      <CrmNav />
      <div className="page-head">
        <h1>Leads</h1>
        <div className="row-actions">
          <label className="button">Import CSV<input type="file" accept=".csv,text/csv" hidden onChange={importFile} /></label>
          <button disabled={!visible.length} onClick={exportCsv}>{selection.selected.length ? 'Export selected' : 'Export CSV'}</button>
          <button className="primary" onClick={() => setAdding(true)}>New lead</button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="card stack">
        <SavedViews entity="lead" filters={filters} onApply={setFilters} />
        <div className="form-grid">
          <label>Search<input value={filters.search || ''} onChange={(e) => set('search', e.target.value)} /></label>
          <label>Status
            <select value={filters.status || ''} onChange={(e) => set('status', e.target.value)}>
              <option value="open">New and working</option>
              <option value="">All</option>
              <option value="new">New</option>
              <option value="working">Working</option>
              <option value="disqualified">Disqualified</option>
              <option value="converted">Converted</option>
            </select>
          </label>
          <label>Rating
            <select value={filters.temperature || ''} onChange={(e) => set('temperature', e.target.value)}>
              <option value="">Any</option>
              <option>Hot</option>
              <option>Warm</option>
              <option>Cold</option>
            </select>
          </label>
          <label>Source
            <select value={filters.source || ''} onChange={(e) => set('source', e.target.value)}>
              <option value="">Any</option>
              {sources.map((source) => <option key={source}>{source}</option>)}
            </select>
          </label>
          <TagFilter value={filters.tag || ''} onChange={(tag) => set('tag', tag)} tags={tags} />
          <ListFilters filters={filters} onChange={setFilters} members={members} fields={fields} />
        </div>
      </div>

      <BulkBar entity="lead" selected={selection.selected} onClear={selection.clear} tags={tags} members={members}
        onDone={async (message) => { toast.success('Done', { detail: message }); await load(); }} />

      {loading ? <SkeletonTable rows={8} columns={8} /> : (
        <div className="card table-wrap">
          <table>
            <thead><tr><th className="pick"><input type="checkbox" aria-label="Select all shown" checked={selection.all} onChange={selection.toggleAll} /></th><th>Name</th><th>Company</th><th className="num">Score</th><th>Status</th><th>Source</th><th>Owner</th><th>Tags</th><th>Added</th></tr></thead>
            <tbody>
              {visible.length === 0 && (
                <tr><td colSpan={9}>
                  {leads.length
                    ? <EmptyState compact icon="search" title="No leads match" line="Try a different search or clear a filter." />
                    : <EmptyState compact icon="lead" title="No leads yet" line="Add a lead by hand, import a CSV, or connect a web form in settings." action={{ label: 'New lead', onClick: () => setAdding(true) }} />}
                </td></tr>
              )}
              {visible.map((lead) => (
                <tr key={lead.id} className={selection.has(lead.id) ? 'picked' : ''}>
                  <td className="pick"><input type="checkbox" aria-label={`Select ${lead.name}`} checked={selection.has(lead.id)} onChange={() => selection.toggle(lead.id)} /></td>
                  <td className="wrap"><Link href={`/saas/crm/lead/${lead.id}`} className={styles.rowOpen} onClick={openInDrawer(() => setOpened(lead))}>{lead.name}</Link></td>
                  <td className="wrap">{lead.company_name || '—'}</td>
                  <td className="num">{lead.score} <span className={`badge ${scoreBadge(lead.score)}`}>{scoreLabel(lead.score)}</span></td>
                  <td><span className={`badge ${statusBadge[lead.status]}`}>{statusLabel[lead.status]}</span></td>
                  <td>{lead.source || '—'}</td>
                  <td>{ownerName(lead.owner_id)}</td>
                  <td className="wrap"><TagChips ids={lead.tags} tags={tags} /></td>
                  <td>{formatDate(lead.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && <LeadForm onClose={() => setAdding(false)} onSaved={async () => { toast.success('Lead added'); await load(); }} />}
      <RecordDrawer kind="lead" record={opened} onClose={() => setOpened(null)} onChanged={load} ownerName={ownerName} tags={tags} />
    </div>
  );
}
