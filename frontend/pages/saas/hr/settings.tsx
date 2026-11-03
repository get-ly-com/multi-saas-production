import { FormEvent, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import HrNav from '@/components/HrNav';
import { api, formatDate } from '@/lib/api';

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
  const [notice, setNotice] = useState('');

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

  const run = async (work: () => Promise<unknown>, done = '') => {
    setNotice('');
    try {
      await work();
      await load();
      setNotice(done);
      return true;
    } catch (err: any) {
      setError(err.message);
      return false;
    }
  };

  if (manager === false) {
    return (
      <div className="stack">
        <HrNav />
        <h1>HR settings</h1>
        <p className="muted">Only owners and admins can change HR settings.</p>
      </div>
    );
  }
  if (!rates) return <div className="stack"><HrNav />{error ? <p className="error">{error}</p> : <p className="empty">Loading…</p>}</div>;

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
      {notice && <p className="notice">{notice}</p>}

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
        <div className="form-actions"><button className="primary">Save rates</button></div>
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
      </div>

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

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (await onAdd(form)) setForm(blank);
  };

  return (
    <form className="row-actions" style={{ justifyContent: 'flex-start', marginTop: 12 }} onSubmit={submit}>
      {fields.map(({ name, label, type }) => (
        <input key={name} aria-label={label} placeholder={label} type={type || 'text'} required value={form[name]} onChange={(e) => setForm({ ...form, [name]: e.target.value })} />
      ))}
      <button>Add</button>
    </form>
  );
}

function NewLeaveType({ onAdd }: { onAdd: (body: any) => Promise<boolean> }) {
  const blank = { name: '', days_per_year: '0', max_carry_over: '0', paid: true };
  const [form, setForm] = useState<any>(blank);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (await onAdd(form)) setForm(blank);
  };

  return (
    <form className="row-actions" style={{ justifyContent: 'flex-start', marginTop: 12 }} onSubmit={submit}>
      <input aria-label="Name" placeholder="Name, like Parental leave" required maxLength={60} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <label className="check" style={{ marginTop: 0 }}>Days a year <input aria-label="Days a year" type="number" min="0" max="366" step="0.5" value={form.days_per_year} onChange={(e) => setForm({ ...form, days_per_year: e.target.value })} /></label>
      <label className="check" style={{ marginTop: 0 }}>Carry over <input aria-label="Days that carry over to next year" title="Unused days that move to next year (0 for none)" type="number" min="0" max="366" step="0.5" value={form.max_carry_over} onChange={(e) => setForm({ ...form, max_carry_over: e.target.value })} /></label>
      <label className="check" style={{ marginTop: 0 }}><input type="checkbox" checked={form.paid} onChange={(e) => setForm({ ...form, paid: e.target.checked })} /> Paid</label>
      <button>Add</button>
    </form>
  );
}
