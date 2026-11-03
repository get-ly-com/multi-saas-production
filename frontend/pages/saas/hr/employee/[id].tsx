import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { EMPLOYMENT_TYPES, EmployeeForm, LeaveForm, employeeForm, fullName, leaveDates } from '@/components/HrForms';
import HrNav from '@/components/HrNav';
import { EmployeeChecklists } from '@/components/HrWork';
import { api, formatDate, money } from '@/lib/api';
import { getSupabase } from '@/lib/supabase';

export default function EmployeePage() {
  return <AppShell><EmployeeApp /></AppShell>;
}

function EmployeeApp() {
  const router = useRouter();
  const id = router.query.id as string | undefined;
  const [person, setPerson] = useState<any>(null);
  const [people, setPeople] = useState<any[]>([]);
  const [manager, setManager] = useState(false);
  const [payroll, setPayroll] = useState(false);
  const [isMe, setIsMe] = useState(false);
  const [myId, setMyId] = useState('');
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
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

  const remove = async () => {
    if (!window.confirm(`Delete ${fullName(person)} and their leave history? This can't be undone.`)) return;
    try {
      await api.delete(`/api/hr/employees/${person.id}`);
      router.push('/saas/hr');
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (!person) return <div className="stack"><HrNav />{error ? <p className="error">{error}</p> : <p className="empty">Loading…</p>}</div>;

  const setProbation = async () => {
    const value = window.prompt('Probation ends on (YYYY-MM-DD). Leave empty for no probation.', person.terms?.probation_end_date || '');
    if (value === null) return;
    try {
      await api.put(`/api/hr/employees/${person.id}/probation`, { probation_end_date: value.trim() || null });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const setPin = async () => {
    const value = window.prompt(`New kiosk PIN for ${fullName(person)} (4 to 8 numbers). Tell them in person.`, '');
    if (!value) return;
    try {
      await api.post('/api/hr/attendance/pin', { employee_id: person.id, pin: value.trim() });
      window.alert('Kiosk PIN saved.');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const pay = person.pay;
  const reports = people.filter((row) => row.manager_id === person.id);

  return (
    <div className="stack">
      <HrNav />
      <div className="page-head">
        <div>
          <h1>{fullName(person)}</h1>
          <p className="muted">#{person.employee_number}{person.job_title ? ` · ${person.job_title}` : ''}{person.department ? ` · ${person.department.name}` : ''}</p>
        </div>
        <div className="row-actions">
          {(manager || isMe) && <button onClick={() => setAsking(true)}>Request leave</button>}
          {manager && <button onClick={() => setEditing(true)}>Edit</button>}
          {manager && <button className="danger" onClick={remove}>Delete</button>}
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="stats">
        <div className="card">
          <div className="stat-label">Contact</div>
          <div>{person.email || 'No email'}</div>
          <div>{person.phone || 'No phone'}</div>
        </div>
        <div className="card">
          <div className="stat-label">Employment</div>
          <div>{EMPLOYMENT_TYPES[person.employment_type]}</div>
          <div>Started {formatDate(person.start_date)}</div>
          {person.end_date && <div>Leaves {formatDate(person.end_date)}</div>}
          {person.terms?.probation_end_date && <div>Probation ends {formatDate(person.terms.probation_end_date)}</div>}
          {manager && <div className="row-actions" style={{ justifyContent: 'flex-start' }}>
            <button onClick={setProbation}>{person.terms?.probation_end_date ? 'Change probation' : 'Set probation'}</button>
            <button onClick={setPin}>Set kiosk PIN</button>
          </div>}
        </div>
        <div className="card">
          <div className="stat-label">Reports to</div>
          <div>{person.manager ? <Link href={`/saas/hr/employee/${person.manager.id}`}>{fullName(person.manager)}</Link> : 'No one'}</div>
          {reports.length > 0 && <div className="muted">{reports.length} {reports.length === 1 ? 'person reports' : 'people report'} to them</div>}
        </div>
        {payroll && pay && (
          <div className="card">
            <div className="stat-label">Pay (only those who run payroll see this)</div>
            <div>{pay.pay_type === 'salary' ? `${money(pay.amount)} a year` : `${money(pay.amount)} an hour, ${pay.hours_per_week} hours a week`}</div>
            {pay.notes && <div className="muted" style={{ whiteSpace: 'pre-wrap' }}>{pay.notes}</div>}
          </div>
        )}
      </div>

      {person.balances && (
        <div className="card">
          <h2>Leave this year</h2>
          <div className="stats">
            {person.balances.map((row: any) => (
              <div key={row.leave_type_id}>
                <div className="stat-label">{row.name}</div>
                <div className="stat-value">{row.limited ? `${row.left} left` : `${row.taken} taken`}</div>
                {row.limited && <div className="muted">{row.taken} taken of {row.allowance}{Number(row.carried_over) > 0 ? ` + ${row.carried_over} carried over` : ''}{Number(row.pending) > 0 ? `, ${row.pending} waiting` : ''}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {person.balances && (
        <div className="card table-wrap">
          <h2>Leave requests</h2>
          <table>
            <thead><tr><th>Dates</th><th>Type</th><th className="num">Days</th><th>Status</th><th>Reason</th></tr></thead>
            <tbody>
              {person.leave.length === 0 && <tr><td colSpan={5} className="empty">No leave yet</td></tr>}
              {person.leave.map((row: any) => (
                <tr key={row.id}>
                  <td>{leaveDates(row)}</td>
                  <td>{row.leave_type?.name}</td>
                  <td className="num">{Number(row.days)}</td>
                  <td><span className={`badge ${row.status === 'approved' ? 'paid' : row.status === 'pending' ? 'open' : 'void'}`}>{row.status}</span></td>
                  <td className="wrap">{row.reason || '—'}{row.decision_note ? ` · ${row.decision_note}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {payroll && person.payslips.length > 0 && (
        <div className="card table-wrap">
          <h2>Payslips</h2>
          <table>
            <thead><tr><th>Month</th><th>Paid on</th><th>Status</th><th className="num">Gross</th><th className="num">Take-home</th></tr></thead>
            <tbody>
              {person.payslips.filter((slip: any) => slip.run).map((slip: any) => (
                <tr key={slip.id}>
                  <td><Link href={`/saas/hr/payslip/${slip.id}`}>{slip.run.period_start.slice(0, 7)}</Link></td>
                  <td>{formatDate(slip.run.pay_date)}</td>
                  <td><span className={`badge ${slip.run.status}`}>{slip.run.status}</span></td>
                  <td className="num">{money(slip.gross)}</td>
                  <td className="num">{money(slip.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <EmployeeChecklists employee={person} manager={manager} isMe={isMe} isTheirManager={Boolean(myId) && person.manager_id === myId} />

      {(manager || isMe) && <EmployeeDocuments employee={person} manager={manager} />}

      {editing && <EmployeeForm initial={employeeForm(person)} people={people} onClose={() => setEditing(false)} onSaved={load} />}
      {asking && <LeaveForm people={[person]} employeeId={person.id} onClose={() => setAsking(false)} onSaved={load} />}
    </div>
  );
}

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
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="card table-wrap">
      <h2>Documents</h2>
      {error && <p className="error">{error}</p>}
      <table>
        <thead><tr><th>Name</th><th>Type</th><th className="num">Size</th><th>Added</th><th /></tr></thead>
        <tbody>
          {documents === null && <tr><td colSpan={5} className="empty">Loading…</td></tr>}
          {documents?.length === 0 && <tr><td colSpan={5} className="empty">No documents yet</td></tr>}
          {documents?.map((doc) => (
            <tr key={doc.id}>
              <td className="wrap">{doc.name}</td>
              <td>{DOCUMENT_KINDS[doc.kind] || doc.kind}</td>
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
      </table>
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
