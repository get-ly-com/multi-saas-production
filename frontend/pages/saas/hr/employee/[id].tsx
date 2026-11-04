import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import EmptyState from '@/components/EmptyState';
import { Avatar, Balances, EMPLOYMENT_TYPES, EmployeeForm, LEAVE_WORDS, LeaveForm, PersonCell, employeeForm, fullName, leaveBadge, leaveDates } from '@/components/HrForms';
import HrNav from '@/components/HrNav';
import { EmployeeChecklists } from '@/components/HrWork';
import Icon from '@/components/Icon';
import Skeleton, { SkeletonTable } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api, formatDate, money, queryId, today } from '@/lib/api';
import { getSupabase } from '@/lib/supabase';
import useSubmit from '@/lib/useSubmit';
import styles from '@/styles/hr.module.css';

export default function EmployeePage() {
  return <AppShell><EmployeeApp /></AppShell>;
}

type Tab = 'overview' | 'leave' | 'pay' | 'checklists' | 'documents';

function EmployeeApp() {
  const router = useRouter();
  const id = queryId(router.query.id);
  const [person, setPerson] = useState<any>(null);
  const [people, setPeople] = useState<any[]>([]);
  const [manager, setManager] = useState(false);
  const [payroll, setPayroll] = useState(false);
  const [isMe, setIsMe] = useState(false);
  const [myId, setMyId] = useState('');
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  const [error, setError] = useState('');

  const load = async () => {
    if (!id) return;
    try {
      const [row, rows, summary, mine] = await Promise.all([
        api.get(`/api/hr/employees/${id}`), api.get('/api/hr/employees'), api.get('/api/hr/overview'), api.get('/api/hr/me')
      ]);
      setPerson(row);
      setPeople(rows);
      setManager(summary.is_manager);
      setPayroll(summary.is_payroll);
      setIsMe(mine.employee?.id === row.id);
      setMyId(mine.employee?.id || '');
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, [id]);

  const { busy, run: once } = useSubmit();
  const remove = () => once(async () => {
    if (!window.confirm(`Delete ${fullName(person)} and their leave history? This can't be undone.`)) return;
    try {
      await api.delete(`/api/hr/employees/${person.id}`);
      toast.success('Employee deleted', { detail: `${fullName(person)} is off the people list.` });
      router.push('/saas/hr');
    } catch (err: any) {
      toast.error('Could not delete', { detail: err.message });
    }
  });

  if (!person) {
    return (
      <div className="stack">
        <HrNav />
        {error ? <p className="error">{error}</p> : (
          <div className="stack" role="status" aria-label="Loading">
            <div className={styles.profile}>
              <Skeleton width={64} height={64} radius={999} />
              <div style={{ display: 'grid', gap: 8, flex: 1 }}>
                <Skeleton width={220} height={26} />
                <Skeleton width={320} height={14} />
              </div>
            </div>
            <SkeletonTable rows={4} columns={3} />
          </div>
        )}
      </div>
    );
  }

  const setProbation = () => once(async () => {
    const value = window.prompt('Probation ends on (YYYY-MM-DD). Leave empty for no probation.', person.terms?.probation_end_date || '');
    if (value === null) return;
    try {
      await api.put(`/api/hr/employees/${person.id}/probation`, { probation_end_date: value.trim() || null });
      await load();
      toast.success(value.trim() ? 'Probation set' : 'Probation removed', { detail: value.trim() ? `Ends ${formatDate(value.trim())}.` : undefined });
    } catch (err: any) {
      toast.error('Could not change probation', { detail: err.message });
    }
  });

  const setPin = () => once(async () => {
    const value = window.prompt(`New kiosk PIN for ${fullName(person)} (4 to 8 numbers). Tell them in person.`, '');
    if (!value) return;
    try {
      await api.post('/api/hr/attendance/pin', { employee_id: person.id, pin: value.trim() });
      toast.success('Kiosk PIN saved', { detail: `${fullName(person)} can clock in with it now.` });
    } catch (err: any) {
      toast.error('Could not save the PIN', { detail: err.message });
    }
  });

  const pay = person.pay;
  const reports = people.filter((row) => row.manager_id === person.id);
  const now = today();
  const state = person.start_date > now ? { label: 'Starting', style: 'new' }
    : person.end_date && person.end_date < now ? { label: 'Left', style: 'inactive' } : { label: 'Active', style: 'active' };
  const slips = (person.payslips || []).filter((slip: any) => slip.run);
  const waiting = (person.leave || []).filter((row: any) => row.status === 'pending').length;

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'overview', label: 'Overview' },
    ...(person.balances ? [{ id: 'leave' as Tab, label: 'Leave', count: waiting || undefined }] : []),
    ...(payroll ? [{ id: 'pay' as Tab, label: 'Pay' }] : []),
    { id: 'checklists', label: 'Checklists' },
    ...(manager || isMe ? [{ id: 'documents' as Tab, label: 'Documents' }] : [])
  ];
  const shown = tabs.some((row) => row.id === tab) ? tab : 'overview';

  return (
    <div className="stack">
      <HrNav />

      <header className={styles.profile}>
        <Avatar person={person} size="large" gone={state.label === 'Left'} />
        <div className={styles.profileText}>
          <h1>{fullName(person)}</h1>
          <div className="muted">{person.job_title || 'No job title'}{person.manager ? ` · reports to ${fullName(person.manager)}` : ''}</div>
          <div className={styles.chips}>
            <span className={`badge ${state.style}`}>{state.label}</span>
            {person.department && <span className="chip">{person.department.name}</span>}
            <span className="chip">{EMPLOYMENT_TYPES[person.employment_type]}</span>
            <span className="chip">#{person.employee_number}</span>
          </div>
        </div>
        <div className={styles.profileActions}>
          {(manager || isMe) && <button className="always" onClick={() => setAsking(true)}>Request leave</button>}
          {manager && <button onClick={() => setEditing(true)}>Edit</button>}
          {manager && <button disabled={busy} className="danger" onClick={remove}>Delete</button>}
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      <div className="tabs" role="tablist" aria-label="Sections">
        {tabs.map((row) => (
          <button key={row.id} type="button" role="tab" aria-selected={shown === row.id} className={`always ${shown === row.id ? 'active' : ''}`} onClick={() => setTab(row.id)}>
            {row.label}{row.count ? <> <span className="count-pill">{row.count}</span></> : null}
          </button>
        ))}
      </div>

      {shown === 'overview' && (
        <>
          <div className="card">
            <dl className={styles.facts}>
              <div><dt>Email</dt><dd>{person.email ? <a href={`mailto:${person.email}`}>{person.email}</a> : <span className="muted">None</span>}</dd></div>
              <div><dt>Phone</dt><dd>{person.phone ? <a href={`tel:${person.phone}`}>{person.phone}</a> : <span className="muted">None</span>}</dd></div>
              <div><dt>Started</dt><dd>{formatDate(person.start_date)}</dd></div>
              <div><dt>Last day</dt><dd>{person.end_date ? formatDate(person.end_date) : <span className="muted">Not set</span>}</dd></div>
              <div><dt>Probation ends</dt><dd>{person.terms?.probation_end_date ? formatDate(person.terms.probation_end_date) : <span className="muted">No probation</span>}</dd></div>
              <div><dt>Reports to</dt><dd>{person.manager ? <Link href={`/saas/hr/employee/${person.manager.id}`}>{fullName(person.manager)}</Link> : 'No one'}</dd></div>
            </dl>
            {manager && (
              <div className="row-actions" style={{ justifyContent: 'flex-start', marginTop: 16 }}>
                <button className="small" disabled={busy} onClick={setProbation}>{person.terms?.probation_end_date ? 'Change probation' : 'Set probation'}</button>
                <button className="small" disabled={busy} onClick={setPin}>Set kiosk PIN</button>
              </div>
            )}
          </div>

          {reports.length > 0 && (
            <div className="card">
              <h2>{plural(reports.length)} to them</h2>
              <div className={styles.balanceGrid} style={{ marginTop: 12 }}>
                {reports.map((row) => (
                  <Link key={row.id} href={`/saas/hr/employee/${row.id}`} className="org-card">
                    <PersonCell person={row} sub={row.job_title || 'No job title'} size="small" />
                  </Link>
                ))}
              </div>
            </div>
          )}

          {person.balances && (
            <div className="card">
              <h2>Leave this year</h2>
              <div style={{ marginTop: 12 }}><Balances rows={person.balances} /></div>
            </div>
          )}
        </>
      )}

      {shown === 'leave' && person.balances && (
        <>
          <div className="card"><Balances rows={person.balances} /></div>
          {person.leave.length === 0 ? (
            <div className="card">
              <EmptyState compact icon="leave" title="No leave yet" line="Time off they ask for shows up here."
                action={manager || isMe ? { label: 'Request leave', onClick: () => setAsking(true) } : undefined} />
            </div>
          ) : (
            <div className="card table-wrap">
              <table>
                <thead><tr><th>Dates</th><th>Type</th><th className="num">Days</th><th>Status</th><th>Reason</th></tr></thead>
                <tbody>
                  {person.leave.map((row: any) => (
                    <tr key={row.id}>
                      <td>{leaveDates(row)}</td>
                      <td>{row.leave_type?.name}</td>
                      <td className="num">{Number(row.days)}</td>
                      <td><span className={`badge ${leaveBadge(row.status)}`}>{LEAVE_WORDS[row.status] || row.status}</span></td>
                      <td className="wrap">{row.reason || '—'}{row.decision_note ? <div className="muted">{row.decision_note}</div> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {shown === 'pay' && payroll && (
        <>
          <div className="stats">
            <div className="card">
              <div className="stat-label">{pay?.pay_type === 'hourly' ? 'Hourly rate' : 'Salary'}</div>
              <div className="stat-value">{pay && Number(pay.amount) ? money(pay.amount) : '—'}</div>
              <div className="muted">{pay ? (pay.pay_type === 'salary' ? 'a year' : `an hour, ${pay.hours_per_week} hours a week`) : 'Not set'}</div>
            </div>
            {slips[0] && (
              <Link href={`/saas/hr/payslip/${slips[0].id}`} className="card stat-link">
                <div className="stat-label">Last take-home</div>
                <div className="stat-value">{money(slips[0].net)}</div>
                <div className="muted">{slips[0].run.period_start.slice(0, 7)}</div>
              </Link>
            )}
          </div>
          {pay?.notes && <p className="muted" style={{ whiteSpace: 'pre-wrap' }}>{pay.notes}</p>}
          {slips.length === 0 ? (
            <div className="card">
              <EmptyState compact icon="money" title="No payslips yet" line="Their payslips appear here after their first pay run."
                action={{ label: 'Go to payroll', href: '/saas/hr/payroll' }} />
            </div>
          ) : (
            <div className="card table-wrap">
              <table>
                <thead><tr><th>Month</th><th>Paid on</th><th>Status</th><th className="num">Gross</th><th className="num">Take-home</th></tr></thead>
                <tbody>
                  {slips.map((slip: any) => (
                    <tr key={slip.id}>
                      <td><Link href={`/saas/hr/payslip/${slip.id}`}>{slip.run.period_start.slice(0, 7)}</Link></td>
                      <td>{formatDate(slip.run.pay_date)}</td>
                      <td><span className={`badge ${slip.run.status === 'approved' ? 'approved_run' : slip.run.status}`}>{slip.run.status}</span></td>
                      <td className="num">{money(slip.gross)}</td>
                      <td className="num"><strong>{money(slip.net)}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small"><Icon name="info" size={13} /> Only people who run payroll see this tab.</p>
        </>
      )}

      {shown === 'checklists' && (
        <EmployeeChecklists employee={person} manager={manager} isMe={isMe} isTheirManager={Boolean(myId) && person.manager_id === myId} />
      )}

      {shown === 'documents' && (manager || isMe) && <EmployeeDocuments employee={person} manager={manager} />}

      {editing && (
        <EmployeeForm initial={employeeForm(person)} people={people} onClose={() => setEditing(false)}
          onSaved={async () => { await load(); toast.success('Saved', { detail: `${fullName(person)}'s record is up to date.` }); }} />
      )}
      {asking && (
        <LeaveForm people={[person]} employeeId={person.id} onClose={() => setAsking(false)}
          onSaved={async () => { await load(); toast.success('Leave requested', { detail: 'It is waiting for a decision.' }); }} />
      )}
    </div>
  );
}

const plural = (n: number) => (n === 1 ? '1 person reports' : `${n} people report`);

// Contracts, IDs and certificates. Files go straight to private storage; the HR service records them.
const DOCUMENT_BUCKET = 'hr-documents';
const DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;
const DOCUMENT_KINDS: Record<string, string> = { contract: 'Contract', id: 'ID', certificate: 'Certificate', other: 'Other' };
const DOCUMENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};

const extensionOf = (fileName: string) => (fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '');

const safeFileName = (fileName: string) =>
  fileName.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+/, '').slice(-100) || 'file';

const fileSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

function EmployeeDocuments({ employee, manager }: { employee: any; manager: boolean }) {
  const [documents, setDocuments] = useState<any[] | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('contract');
  const [inputKey, setInputKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setDocuments(await api.get(`/api/hr/employees/${employee.id}/documents`));
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, [employee.id]);

  const choose = (chosen: File | null) => {
    setError('');
    setFile(null);
    if (!chosen) return;
    if (!DOCUMENT_TYPES[extensionOf(chosen.name)]) {
      setError('That type of file can’t be added. Choose a PDF, JPEG, PNG or Word file.');
      return;
    }
    if (chosen.size > DOCUMENT_MAX_BYTES) {
      setError(`That file is ${fileSize(chosen.size)}. Files can be up to 5 MB.`);
      return;
    }
    if (chosen.size === 0) {
      setError('That file is empty.');
      return;
    }
    setFile(chosen);
    setName(chosen.name.replace(/\.[^.]+$/, '').slice(0, 200));
  };

  const upload = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file) {
      setError('Choose a file first.');
      return;
    }
    const contentType = DOCUMENT_TYPES[extensionOf(file.name)];
    const path = `${employee.tenant_id}/${employee.id}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
    const storage = getSupabase().storage.from(DOCUMENT_BUCKET);
    setBusy(true);
    setError('');
    try {
      const { error: uploadError } = await storage.upload(path, file, { upsert: false, contentType });
      if (uploadError) throw new Error('The file couldn’t be uploaded. Check it’s a PDF, JPEG, PNG or Word file up to 5 MB and try again.');
      try {
        await api.post(`/api/hr/employees/${employee.id}/documents`, {
          name: name.trim() || file.name, kind, storage_path: path, size_bytes: file.size, mime_type: contentType
        });
      } catch (err) {
        // Don't leave a file behind that no record points to
        await storage.remove([path]).catch(() => null);
        throw err;
      }
      setFile(null);
      setName('');
      setInputKey((key) => key + 1);
      await load();
      toast.success('Document added', { detail: name.trim() || file.name });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const download = async (doc: any) => {
    setError('');
    const extension = extensionOf(doc.storage_path);
    const downloadName = extensionOf(doc.name) === extension ? doc.name : `${doc.name}.${extension}`;
    const { data, error: urlError } = await getSupabase().storage.from(DOCUMENT_BUCKET)
      .createSignedUrl(doc.storage_path, 60, { download: downloadName });
    if (urlError || !data?.signedUrl) {
      setError('That file couldn’t be opened. Please try again.');
      return;
    }
    window.location.assign(data.signedUrl);
  };

  const remove = async (doc: any) => {
    if (!window.confirm(`Delete ${doc.name}? This can't be undone.`)) return;
    setError('');
    try {
      const { error: removeError } = await getSupabase().storage.from(DOCUMENT_BUCKET).remove([doc.storage_path]);
      if (removeError) throw new Error('The file couldn’t be deleted. Please try again.');
      await api.delete(`/api/hr/documents/${doc.id}`);
      await load();
      toast.success('Document deleted', { detail: doc.name });
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="card table-wrap">
      <h2>Documents</h2>
      {error && <p className="error">{error}</p>}
      {documents === null && !error && <div style={{ display: 'grid', gap: 10, marginTop: 12 }}><Skeleton height={14} /><Skeleton height={14} width="70%" /></div>}
      {documents?.length === 0 && (
        <EmptyState compact icon="invoice" title="No documents yet"
          line={manager ? 'Keep contracts, IDs and certificates here, private to this person and admins.' : 'Contracts and certificates an admin adds show up here.'} />
      )}
      {documents && documents.length > 0 && <table>
        <thead><tr><th>Name</th><th>Type</th><th className="num">Size</th><th>Added</th><th /></tr></thead>
        <tbody>
          {documents.map((doc) => (
            <tr key={doc.id}>
              <td className="wrap"><span className={styles.person}><Icon name="invoice" size={16} /> {doc.name}</span></td>
              <td><span className="chip">{DOCUMENT_KINDS[doc.kind] || doc.kind}</span></td>
              <td className="num">{fileSize(Number(doc.size_bytes))}</td>
              <td>{formatDate(doc.created_at)}</td>
              <td>
                <div className="row-actions">
                  <button type="button" onClick={() => download(doc)}>Download</button>
                  {manager && <button type="button" className="danger" onClick={() => remove(doc)}>Delete</button>}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>}
      {manager && (
        <form onSubmit={upload} style={{ marginTop: 12 }}>
          <div className="form-grid">
            <label>File
              <input key={inputKey} type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                onChange={(e) => choose(e.target.files?.[0] || null)} />
            </label>
            <label>Type
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                {Object.entries(DOCUMENT_KINDS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label>Name<input maxLength={200} value={name} onChange={(e) => setName(e.target.value)} /></label>
          </div>
          <p className="muted">PDF, JPEG, PNG or Word, up to 5 MB. Only owners, admins and this person can see documents.</p>
          <div className="form-actions">
            <button className="primary" disabled={busy || !file}>{busy ? 'Uploading…' : 'Upload'}</button>
          </div>
        </form>
      )}
    </div>
  );
}
