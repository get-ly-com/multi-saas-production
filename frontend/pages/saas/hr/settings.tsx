import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import HrNav from '@/components/HrNav';
import Modal from '@/components/Modal';
import { SkeletonPage } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api, formatDate } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

export default function HrSettings() {
  return <AppShell><SettingsApp /></AppShell>;
}

function SettingsApp() {
  const [manager, setManager] = useState<boolean | null>(null);
  const [rates, setRates] = useState<any>(null);
  const [departments, setDepartments] = useState<any[]>([]);
  const [types, setTypes] = useState<any[]>([]);
  const [holidays, setHolidays] = useState<any[]>([]);
  const [error, setError] = useState('');
  const setNotice = (text: string) => { if (text) toast.success(text); };

  const load = async () => {
    try {
      const [summary, settings, depts, leaveTypes, days] = await Promise.all([
        api.get('/api/hr/overview'), api.get('/api/hr/settings'), api.get('/api/hr/departments'),
        api.get('/api/hr/leave-types'), api.get('/api/hr/holidays')
      ]);
      setManager(summary.is_manager);
      setRates(settings || { income_tax_rate: 0, employee_rate: 0, employer_rate: 0 });
      setDepartments(depts);
      setTypes(leaveTypes);
      setHolidays(days);
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const { busy, run: once } = useSubmit();
  // One action at a time, so a double click cannot repeat it
  const run = (work: () => Promise<unknown>, done = '') => once(async () => {
    try {
      await work();
      await load();
      if (done) setNotice(done);
      return true;
    } catch (err: any) {
      toast.error('That did not go through', { detail: err.message });
      return false;
    }
  });

  if (manager === false) {
    return (
      <div className="stack">
        <HrNav />
        <h1>HR settings</h1>
        <p className="muted">Only owners and admins can change HR settings.</p>
      </div>
    );
  }
  if (!rates) return <div className="stack"><HrNav />{error ? <p className="error">{error}</p> : <SkeletonPage />}</div>;

  const saveRates = (event: FormEvent) => {
    event.preventDefault();
    run(async () => {
      await api.put('/api/hr/settings', rates);
      await api.put('/api/hr/settings/payroll-access', { accountants_run_payroll: Boolean(rates.accountants_run_payroll) });
    }, 'Payroll rates saved. New and recalculated pay runs use them.');
  };

  return (
    <div className="stack">
      <HrNav />
      <h1>HR settings</h1>
      {error && <p className="error">{error}</p>}

      <form className="card" onSubmit={saveRates}>
        <h2>Payroll rates</h2>
        <p className="muted">
          Simple percentages of gross pay, used as a starting point on each pay run. Tax rules differ by country,
          so check each run and change any line where the real amount is different.
        </p>
        <div className="form-grid">
          <label>Income tax withheld (%)<input type="number" min="0" max="100" step="0.01" value={rates.income_tax_rate} onChange={(e) => setRates({ ...rates, income_tax_rate: e.target.value })} /></label>
          <label>Employee contributions (%)<input type="number" min="0" max="100" step="0.01" value={rates.employee_rate} onChange={(e) => setRates({ ...rates, employee_rate: e.target.value })} /></label>
          <label>Employer contributions (%)<input type="number" min="0" max="100" step="0.01" value={rates.employer_rate} onChange={(e) => setRates({ ...rates, employer_rate: e.target.value })} /></label>
        </div>
        <label className="check">
          <input type="checkbox" checked={Boolean(rates.accountants_run_payroll)} onChange={(e) => setRates({ ...rates, accountants_run_payroll: e.target.checked })} />
          Let accountants run payroll and see pay
        </label>
        <p className="muted">Accountants can then see everyone's pay, run, approve and pay payroll, and pay payroll tax. Only owners and admins can change people, rates and this setting.</p>
        <div className="form-actions"><button disabled={busy} className="primary">Save rates</button></div>
      </form>

      <div className="card table-wrap">
        <h2>Leave types</h2>
        <table>
          <thead><tr><th>Name</th><th className="num">Days a year</th><th className="num">Carry over</th><th>Paid</th><th>In use</th><th /></tr></thead>
          <tbody>
            {types.map((row) => (
              <tr key={row.id}>
                <td>{row.name}</td>
                <td className="num">{Number(row.days_per_year) ? Number(row.days_per_year) : 'No limit'}</td>
                <td className="num">{Number(row.max_carry_over) ? `Up to ${Number(row.max_carry_over)}` : 'None'}</td>
                <td>{row.paid ? 'Paid' : 'Unpaid'}</td>
                <td>{row.is_active ? 'Yes' : 'Turned off'}</td>
                <td>
                  <div className="row-actions">
                    <button onClick={() => {
                      const days = window.prompt(`Days a year for ${row.name} (0 for no limit)`, String(Number(row.days_per_year)));
                      if (days === null) return;
                      // Leave with no limit has nothing to carry over
                      const carry = Number(days)
                        ? window.prompt(`Unused days of ${row.name} that move to next year (0 for none)`, String(Number(row.max_carry_over || 0)))
                        : '0';
                      if (carry !== null) run(() => api.put(`/api/hr/leave-types/${row.id}`, { days_per_year: days, max_carry_over: carry }));
                    }}>Change days</button>
                    <button onClick={() => run(() => api.put(`/api/hr/leave-types/${row.id}`, { is_active: !row.is_active }))}>{row.is_active ? 'Turn off' : 'Turn on'}</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <NewLeaveType onAdd={(body) => run(() => api.post('/api/hr/leave-types', body))} />
        <p className="muted">Someone who starts or leaves during the year gets that share of the days. Unpaid leave is taken off salary on the pay run. Carry over is how many unused days from last year can be used this year.</p>
      </div>

      <div className="card table-wrap">
        <h2>Company holidays</h2>
        <table>
          <thead><tr><th>Date</th><th>Name</th><th /></tr></thead>
          <tbody>
            {holidays.length === 0 && <tr><td colSpan={3} className="empty">No holidays yet</td></tr>}
            {holidays.map((row) => (
              <tr key={row.id}>
                <td>{formatDate(row.holiday_date)}</td>
                <td>{row.name}</td>
                <td><div className="row-actions"><button className="danger" onClick={() => run(() => api.delete(`/api/hr/holidays/${row.id}`))}>Remove</button></div></td>
              </tr>
            ))}
          </tbody>
        </table>
        <NewNamed fields={[{ name: 'holiday_date', type: 'date', label: 'Date' }, { name: 'name', label: 'Name' }]} onAdd={(body) => run(() => api.post('/api/hr/holidays', body))} />
        <p className="muted">Holidays aren't counted as leave days or working days.</p>
        <PublicHolidays onImport={(body) => run(async () => {
          const result = await api.post('/api/hr/public-holidays/import', body);
          setNotice(`Added ${result.added} holidays${result.skipped ? `, ${result.skipped} were already there` : ''}.`);
        })} />
      </div>

      <ExpenseCategories />
      <Checklists />
      <KioskSignIn current={rates.kiosk_user_id || ''} onSave={(userId) => run(() => api.put('/api/hr/settings/kiosk', { user_id: userId || null }), 'Kiosk sign-in saved.')} />

      <div className="card table-wrap">
        <h2>Departments</h2>
        <table>
          <thead><tr><th>Name</th><th /></tr></thead>
          <tbody>
            {departments.length === 0 && <tr><td colSpan={2} className="empty">No departments yet</td></tr>}
            {departments.map((row) => (
              <tr key={row.id}>
                <td>{row.name}</td>
                <td>
                  <div className="row-actions">
                    <button onClick={() => {
                      const name = window.prompt('New name', row.name);
                      if (name) run(() => api.put(`/api/hr/departments/${row.id}`, { name }));
                    }}>Rename</button>
                    <button className="danger" onClick={() => window.confirm(`Delete ${row.name}? People in it will have no department.`) && run(() => api.delete(`/api/hr/departments/${row.id}`))}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <NewNamed fields={[{ name: 'name', label: 'Name' }]} onAdd={(body) => run(() => api.post('/api/hr/departments', body))} />
      </div>
    </div>
  );
}

function NewNamed({ fields, onAdd }: { fields: { name: string; label: string; type?: string }[]; onAdd: (body: any) => Promise<boolean> }) {
  const blank = Object.fromEntries(fields.map(({ name }) => [name, '']));
  const [form, setForm] = useState<any>(blank);

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      if (await onAdd(form)) setForm(blank);
    });
  };

  return (
    <form className="row-actions" style={{ justifyContent: 'flex-start', marginTop: 12 }} onSubmit={submit}>
      {fields.map(({ name, label, type }) => (
        <input key={name} aria-label={label} placeholder={label} type={type || 'text'} required value={form[name]} onChange={(e) => setForm({ ...form, [name]: e.target.value })} />
      ))}
      <button disabled={busy}>Add</button>
    </form>
  );
}

function NewLeaveType({ onAdd }: { onAdd: (body: any) => Promise<boolean> }) {
  const blank = { name: '', days_per_year: '0', max_carry_over: '0', paid: true };
  const [form, setForm] = useState<any>(blank);

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      if (await onAdd(form)) setForm(blank);
    });
  };

  return (
    <form className="row-actions" style={{ justifyContent: 'flex-start', marginTop: 12 }} onSubmit={submit}>
      <input aria-label="Name" placeholder="Name, like Parental leave" required maxLength={60} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <label className="check" style={{ marginTop: 0 }}>Days a year <input aria-label="Days a year" type="number" min="0" max="366" step="0.5" value={form.days_per_year} onChange={(e) => setForm({ ...form, days_per_year: e.target.value })} /></label>
      <label className="check" style={{ marginTop: 0 }}>Carry over <input aria-label="Days that carry over to next year" title="Unused days that move to next year (0 for none)" type="number" min="0" max="366" step="0.5" value={form.max_carry_over} onChange={(e) => setForm({ ...form, max_carry_over: e.target.value })} /></label>
      <label className="check" style={{ marginTop: 0 }}><input type="checkbox" checked={form.paid} onChange={(e) => setForm({ ...form, paid: e.target.checked })} /> Paid</label>
      <button disabled={busy}>Add</button>
    </form>
  );
}

// Works out a country's public holidays for a year and adds the chosen ones
function PublicHolidays({ onImport }: { onImport: (body: any) => Promise<boolean> }) {
  const [countries, setCountries] = useState<any[]>([]);
  const [country, setCountry] = useState('');
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [list, setList] = useState<any[] | null>(null);
  const [skip, setSkip] = useState<string[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/hr/public-holidays/countries').then((rows) => {
      setCountries(rows);
      setCountry(rows[0]?.code || '');
    }).catch((err) => setError(err.message));
  }, []);

  const { busy, run } = useSubmit();
  const preview = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      setError('');
      try {
        setList(await api.get(`/api/hr/public-holidays?country=${country}&year=${year}`));
        setSkip([]);
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  const add = async () => {
    if (await onImport({ country, year: Number(year), skip })) setList(null);
  };

  return (
    <div style={{ marginTop: 16 }}>
      <h3>Add public holidays</h3>
      <form className="row-actions" style={{ justifyContent: 'flex-start' }} onSubmit={preview}>
        <select aria-label="Country" value={country} onChange={(e) => setCountry(e.target.value)}>
          {countries.map((row) => <option key={row.code} value={row.code}>{row.name}</option>)}
        </select>
        <input aria-label="Year" type="number" min="2000" max="2100" value={year} onChange={(e) => setYear(e.target.value)} />
        <button disabled={busy}>Show holidays</button>
      </form>
      {error && <p className="error">{error}</p>}
      {list && (
        <>
          <table>
            <tbody>
              {list.map((row) => (
                <tr key={row.date}>
                  <td><input type="checkbox" aria-label={`Add ${row.name}`} checked={!skip.includes(row.date)}
                    onChange={(e) => setSkip(e.target.checked ? skip.filter((value) => value !== row.date) : [...skip, row.date])} /></td>
                  <td>{formatDate(row.date)}</td>
                  <td>{row.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="form-actions">
            <button className="primary" disabled={skip.length === list.length} onClick={add}>Add {list.length - skip.length} holidays</button>
            <button onClick={() => setList(null)}>Cancel</button>
          </div>
        </>
      )}
      <p className="muted">National holidays only. Add regional ones (like a German state&apos;s or a US state&apos;s) by hand. Dates already on your list are left as they are.</p>
    </div>
  );
}

// Expense claim categories and the ledger account each one books to
function ExpenseCategories() {
  const [rows, setRows] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setRows(await api.get('/api/hr/expense-categories'));
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
    api.get('/api/accounting/accounts')
      .then((list) => setAccounts(list.filter((row: any) => row.type === 'expense' && row.is_active !== false)))
      .catch(() => setAccounts([]));
  }, []);

  const save = async (row: any, changes: any) => {
    setError('');
    try {
      await api.put(`/api/hr/expense-categories/${row.id}`, { name: row.name, account_id: row.account_id || null, ...changes });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const { busy, run } = useSubmit();
  const add = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      setError('');
      try {
        await api.post('/api/hr/expense-categories', { name });
        setName('');
        await load();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <div className="card table-wrap">
      <h2>Expense categories</h2>
      {error && <p className="error">{error}</p>}
      <table>
        <thead><tr><th>Name</th><th>Books to</th><th>In use</th><th /></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.name}</td>
              <td>
                <select aria-label={`Account for ${row.name}`} value={row.account_id || ''} onChange={(e) => save(row, { account_id: e.target.value || null })}>
                  <option value="">6000 General Expenses</option>
                  {accounts.filter((account) => account.code !== '6000').map((account) => <option key={account.id} value={account.id}>{account.code} {account.name}</option>)}
                </select>
              </td>
              <td>{row.is_active ? 'Yes' : 'Turned off'}</td>
              <td><div className="row-actions">
                <button onClick={() => { const next = window.prompt('New name', row.name); if (next) save(row, { name: next }); }}>Rename</button>
                <button onClick={() => save(row, { is_active: !row.is_active })}>{row.is_active ? 'Turn off' : 'Turn on'}</button>
              </div></td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="row-actions" style={{ justifyContent: 'flex-start', marginTop: 12 }} onSubmit={add}>
        <input aria-label="Name" placeholder="Name, like Mileage" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        <button disabled={busy}>Add</button>
      </form>
      <p className="muted">When a claim is approved, its category&apos;s account is charged and 2510 Expenses to Reimburse shows what you owe the person until it&apos;s paid.</p>
    </div>
  );
}

const STEP_WHO: Record<string, string> = { hr: 'HR', manager: 'Their manager', employee: 'The person' };

// Onboarding and offboarding checklists that can be started on anyone's record
function Checklists() {
  const [rows, setRows] = useState<any[]>([]);
  const [editing, setEditing] = useState<any>(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setRows(await api.get('/api/hr/checklists'));
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const { busy, run: once } = useSubmit();
  const remove = (row: any) => once(async () => {
    if (!window.confirm(`Delete the ${row.name} checklist? Steps already started on people stay.`)) return;
    try {
      await api.delete(`/api/hr/checklists/${row.id}`);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  });

  return (
    <div className="card table-wrap">
      <h2>Onboarding and offboarding checklists</h2>
      {error && <p className="error">{error}</p>}
      <table>
        <thead><tr><th>Name</th><th>For</th><th className="num">Steps</th><th /></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={4} className="empty">No checklists yet</td></tr>}
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.name}</td>
              <td>{row.kind === 'onboarding' ? 'New starters' : 'Leavers'}</td>
              <td className="num">{row.items.length}</td>
              <td><div className="row-actions">
                <button onClick={() => setEditing(row)}>Edit</button>
                <button disabled={busy} className="danger" onClick={() => remove(row)}>Delete</button>
              </div></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="form-actions"><button onClick={() => setEditing({ kind: 'onboarding', name: '', items: [{ title: '', days: 0, who: 'hr' }] })}>New checklist</button></div>
      <p className="muted">Start one from a person&apos;s record. Each step is due a number of days before (minus) or after their start date or last day.</p>
      {editing && <ChecklistForm initial={editing} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}

function ChecklistForm({ initial, onClose, onSaved }: { initial: any; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<any>({ ...initial, items: initial.items.map((item: any) => ({ ...item })) });
  const [error, setError] = useState('');
  const setItem = (index: number, field: string, value: any) =>
    setForm({ ...form, items: form.items.map((item: any, at: number) => (at === index ? { ...item, [field]: value } : item)) });

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      const body = { kind: form.kind, name: form.name, items: form.items.filter((item: any) => String(item.title).trim()) };
      try {
        if (form.id) await api.put(`/api/hr/checklists/${form.id}`, body);
        else await api.post('/api/hr/checklists', body);
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title={form.id ? `Edit ${initial.name}` : 'New checklist'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Name<input required maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>For
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="onboarding">New starters (days from the start date)</option>
              <option value="offboarding">Leavers (days from the last day)</option>
            </select>
          </label>
        </div>
        <h3>Steps</h3>
        {form.items.map((item: any, index: number) => (
          <div className="row-actions" key={index} style={{ justifyContent: 'flex-start', marginBottom: 8 }}>
            <input aria-label="Step" placeholder="Step" maxLength={200} value={item.title} onChange={(e) => setItem(index, 'title', e.target.value)} style={{ flex: 1 }} />
            <input aria-label="Days" title="Days before (minus) or after" type="number" min="-90" max="365" value={item.days} onChange={(e) => setItem(index, 'days', e.target.value)} style={{ width: 80 }} />
            <select aria-label="Who" value={item.who} onChange={(e) => setItem(index, 'who', e.target.value)}>
              {Object.entries(STEP_WHO).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <button type="button" onClick={() => setForm({ ...form, items: form.items.filter((_: any, at: number) => at !== index) })}>Remove</button>
          </div>
        ))}
        <button type="button" onClick={() => setForm({ ...form, items: [...form.items, { title: '', days: 0, who: 'hr' }] })}>Add a step</button>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

// Besides owners and admins, one team member's sign-in may run the shared clock-in kiosk
function KioskSignIn({ current, onSave }: { current: string; onSave: (userId: string) => Promise<boolean> }) {
  const [members, setMembers] = useState<any[]>([]);
  const [chosen, setChosen] = useState(current);

  useEffect(() => {
    api.get('/api/team').then((team) => setMembers(team.members || [])).catch(() => setMembers([]));
  }, []);

  useEffect(() => setChosen(current), [current]);

  return (
    <form className="card" onSubmit={(event) => { event.preventDefault(); onSave(chosen); }}>
      <h2>Clock-in kiosk</h2>
      <p className="muted">
        Open <Link href="/saas/hr/kiosk">the kiosk</Link> on a tablet by the door. Staff clock in with their employee number and PIN.
        For a shared tablet, invite a separate team member as a viewer, sign the tablet in with it and choose it here,
        so the tablet isn&apos;t signed in as an owner or admin.
      </p>
      <div className="row-actions" style={{ justifyContent: 'flex-start' }}>
        <select aria-label="Kiosk sign-in" value={chosen} onChange={(e) => setChosen(e.target.value)}>
          <option value="">Only owners and admins</option>
          {members.filter((member) => !['owner', 'admin'].includes(member.role)).map((member) => (
            <option key={member.user_id} value={member.user_id}>{member.email} ({member.role})</option>
          ))}
        </select>
        <button className="primary">Save</button>
      </div>
    </form>
  );
}
