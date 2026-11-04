import { FormEvent, useEffect, useState } from 'react';
import AccountingNav from '@/components/AccountingNav';
import AppShell from '@/components/AppShell';
import Modal from '@/components/Modal';
import { api, formatDate, money, today } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

const TABS = ['Companies', 'Intercompany', 'Profit and loss', 'Balance sheet'];
const KINDS: Record<string, string> = { loan: 'Loan', charge: 'Charge for goods or services', repayment: 'Repayment' };

export default function Group() {
  return <AppShell><GroupApp /></AppShell>;
}

function GroupApp() {
  const [overview, setOverview] = useState<any>(null);
  const [tab, setTab] = useState(TABS[0]);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setOverview(await api.get('/api/accounting/group'));
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="stack">
      <AccountingNav />
      <div className="page-head"><h1>Company group</h1></div>
      {error && <p className="error">{error}</p>}
      {overview && !overview.group && <CreateGroup overview={overview} onSaved={load} />}
      {overview?.group && overview.access === false && (
        <div className="card"><p>This company is in {overview.group.name}. You need to be an owner or admin of every company in the group to open it.</p></div>
      )}
      {overview?.group && overview.access && (
        <>
          <div className="tabs no-print">
            {TABS.map((name) => <button key={name} className={name === tab ? 'active' : ''} onClick={() => setTab(name)}>{name}</button>)}
          </div>
          {tab === 'Companies' && <Companies overview={overview} onSaved={load} />}
          {tab === 'Intercompany' && <Intercompany overview={overview} onSaved={load} />}
          {tab === 'Profit and loss' && <GroupProfit overview={overview} />}
          {tab === 'Balance sheet' && <GroupBalance overview={overview} />}
        </>
      )}
    </div>
  );
}

function CreateGroup({ overview, onSaved }: { overview: any; onSaved: () => void }) {
  const [form, setForm] = useState({ name: '', currency: overview.base });
  const [error, setError] = useState('');

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api.post('/api/accounting/group', form);
        await onSaved();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <div className="card">
      <h2>Start a group</h2>
      <p className="muted">A group reports several of your companies together, in one currency. Each company keeps its own books. Companies are treated as fully owned, so minority interests are not shown.</p>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Group name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>Reporting currency<input required maxLength={3} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} /></label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="form-actions"><button disabled={busy} className="primary">Start group</button></div>
      </form>
    </div>
  );
}

function Companies({ overview, onSaved }: { overview: any; onSaved: () => void }) {
  const [adding, setAdding] = useState('');
  const [rate, setRate] = useState({ currency: '', rate_date: today(), closing_rate: '', average_rate: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { group, companies, rates, addable } = overview;

  const { busy, run: once } = useSubmit();
  // One action at a time, so a double click cannot repeat it
  const run = (action: () => Promise<unknown>, done: string) => once(async () => {
    try {
      await action();
      setNotice(done);
      setError('');
      await onSaved();
    } catch (err: any) {
      setNotice('');
      setError(err.message);
    }
  });

  const remove = (company: any) => {
    if (window.confirm(`Take ${company.name} out of ${group.name}? Its books are not changed.`)) {
      run(() => api.delete(`/api/accounting/group/companies/${company.id}`), `${company.name} removed.`);
    }
  };

  const saveRate = (event: FormEvent) => {
    event.preventDefault();
    run(async () => {
      await api.post('/api/accounting/group/rates', rate);
      setRate({ ...rate, currency: '', closing_rate: '', average_rate: '' });
    }, `Saved the ${rate.currency} rate.`);
  };

  return (
    <>
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="card table-wrap">
        <h2>{group.name} · reports in {group.currency}</h2>
        <table>
          <thead><tr><th>Company</th><th>Currency</th><th /></tr></thead>
          <tbody>
            {companies.map((company: any) => (
              <tr key={company.id}>
                <td className="wrap">{company.name}</td>
                <td>{company.currency}</td>
                <td><div className="row-actions"><button className="danger" onClick={() => remove(company)}>Remove</button></div></td>
              </tr>
            ))}
          </tbody>
        </table>
        {addable.length > 0 && (
          <>
            <div className="report-filters" style={{ marginTop: 12 }}>
              <label>Add a company
                <select value={adding} onChange={(e) => setAdding(e.target.value)}>
                  <option value="">Choose a company</option>
                  {addable.map((company: any) => <option key={company.id} value={company.id}>{company.name}</option>)}
                </select>
              </label>
            </div>
            <div className="form-actions">
              <button className="primary" disabled={!adding} onClick={() => run(async () => {
                await api.post('/api/accounting/group/companies', { company_id: adding });
                setAdding('');
              }, 'Company added.')}>Add company</button>
            </div>
          </>
        )}
      </div>

      <div className="card table-wrap">
        <h2>Reporting rates</h2>
        <p className="muted">One unit of a company's currency in {group.currency}. Assets and liabilities use the closing rate, income, expenses and equity the average rate. A report uses the latest rate on or before its date.</p>
        <form onSubmit={saveRate}>
          <div className="form-grid">
            <label>Currency code<input required maxLength={3} placeholder="EUR" value={rate.currency} onChange={(e) => setRate({ ...rate, currency: e.target.value.toUpperCase() })} /></label>
            <label>Date<input required type="date" value={rate.rate_date} onChange={(e) => setRate({ ...rate, rate_date: e.target.value })} /></label>
            <label>Closing rate<input required type="number" min="0.00000001" step="any" value={rate.closing_rate} onChange={(e) => setRate({ ...rate, closing_rate: e.target.value })} /></label>
            <label>Average rate<input required type="number" min="0.00000001" step="any" value={rate.average_rate} onChange={(e) => setRate({ ...rate, average_rate: e.target.value })} /></label>
          </div>
          <div className="form-actions"><button disabled={busy} className="primary">Save rate</button></div>
        </form>
        <table>
          <thead><tr><th>Currency</th><th>Date</th><th className="num">Closing</th><th className="num">Average</th></tr></thead>
          <tbody>
            {rates.length === 0 && <tr><td colSpan={4} className="empty">No rates yet</td></tr>}
            {rates.map((row: any) => (
              <tr key={`${row.currency}:${row.rate_date}`}>
                <td>{row.currency}</td>
                <td>{formatDate(row.rate_date)}</td>
                <td className="num">{Number(row.closing_rate)}</td>
                <td className="num">{Number(row.average_rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Intercompany({ overview, onSaved }: { overview: any; onSaved: () => void }) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const { companies, entries } = overview;

  const currencyOf = (id: string) => companies.find((company: any) => company.id === id)?.currency;

  const { busy, run: once } = useSubmit();
  const voidEntry = (entry: any) => once(async () => {
    if (!window.confirm(`Void "${entry.memo}"? Both companies' ledger entries will be reversed.`)) return;
    try {
      await api.post(`/api/accounting/group/intercompany/${entry.id}/void`, {});
      setError('');
      await onSaved();
    } catch (err: any) {
      setError(err.message);
    }
  });

  return (
    <>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button className="primary" disabled={companies.length < 2} onClick={() => setAdding(true)}>New intercompany entry</button>
      </div>
      {companies.length < 2 && <p className="muted">Add a second company to the group first.</p>}
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Type</th><th>From</th><th>To</th><th>Description</th><th className="num">Amount</th><th /></tr></thead>
          <tbody>
            {entries.length === 0 && <tr><td colSpan={7} className="empty">No intercompany entries yet</td></tr>}
            {entries.map((entry: any) => (
              <tr key={entry.id}>
                <td>{formatDate(entry.entry_date)}</td>
                <td>{entry.kind}</td>
                <td className="wrap">{entry.from_name}</td>
                <td className="wrap">{entry.to_name}</td>
                <td className="wrap">{entry.memo}</td>
                <td className="num">{money(entry.from_amount, currencyOf(entry.from_tenant))}</td>
                <td>
                  {entry.voided_at
                    ? <span className="badge void">void</span>
                    : <div className="row-actions"><button disabled={busy} className="danger" onClick={() => voidEntry(entry)}>Void</button></div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adding && <EntryForm companies={companies} onClose={() => setAdding(false)} onSaved={onSaved} />}
    </>
  );
}

function EntryForm({ companies, onClose, onSaved }: { companies: any[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    kind: 'loan', from_company: '', to_company: '', entry_date: today(), amount: '', exchange_rate: '', from_account: '', to_account: '', memo: ''
  });
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm({ ...form, [field]: value });

  const from = companies.find(({ id }) => id === form.from_company);
  const to = companies.find(({ id }) => id === form.to_company);
  const charge = form.kind === 'charge';
  const fromAccounts = (from?.accounts || []).filter((account: any) => (charge ? account.type === 'revenue' : account.is_cash));
  const toAccounts = (to?.accounts || []).filter((account: any) => (charge ? account.type === 'expense' : account.is_cash));
  const needsRate = from && to && from.currency !== to.currency;

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api.post('/api/accounting/group/intercompany', form);
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title="New intercompany entry" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Type
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value, from_account: '', to_account: '' })}>
              {Object.entries(KINDS).map(([kind, name]) => <option key={kind} value={kind}>{name}</option>)}
            </select>
          </label>
          <label>Date<input required type="date" value={form.entry_date} onChange={(e) => set('entry_date', e.target.value)} /></label>
          <label>{charge ? 'Seller' : 'Lender'}
            <select required value={form.from_company} onChange={(e) => setForm({ ...form, from_company: e.target.value, from_account: '' })}>
              <option value="">Choose a company</option>
              {companies.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
          <label>{charge ? 'Buyer' : 'Borrower'}
            <select required value={form.to_company} onChange={(e) => setForm({ ...form, to_company: e.target.value, to_account: '' })}>
              <option value="">Choose a company</option>
              {companies.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
          <label>{charge ? "Seller's income account" : "Lender's bank account"}
            <select required value={form.from_account} onChange={(e) => set('from_account', e.target.value)}>
              <option value="">Choose an account</option>
              {fromAccounts.map((account: any) => <option key={account.id} value={account.id}>{account.code} {account.name}</option>)}
            </select>
          </label>
          <label>{charge ? "Buyer's expense account" : "Borrower's bank account"}
            <select required value={form.to_account} onChange={(e) => set('to_account', e.target.value)}>
              <option value="">Choose an account</option>
              {toAccounts.map((account: any) => <option key={account.id} value={account.id}>{account.code} {account.name}</option>)}
            </select>
          </label>
          <label>Amount{from ? ` in ${from.currency}` : ''}<input required type="number" min="0.01" step="0.01" value={form.amount} onChange={(e) => set('amount', e.target.value)} /></label>
          {needsRate && (
            <label>Rate (1 {from.currency} in {to.currency})
              <input required type="number" min="0.00000001" step="any" value={form.exchange_rate} onChange={(e) => set('exchange_rate', e.target.value)} />
            </label>
          )}
        </div>
        <label style={{ marginTop: 12 }}>Description<input required value={form.memo} onChange={(e) => set('memo', e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">Post to both companies</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function useReport(path: string) {
  const [loaded, setLoaded] = useState<{ path: string; data: any } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    api.get(path)
      .then((data) => {
        if (current) {
          setLoaded({ path, data });
          setError('');
        }
      })
      .catch((err) => current && setError(err.message));
    return () => {
      current = false;
    };
  }, [path]);

  return { data: loaded?.path === path ? loaded.data : null, error };
}

function Rows({ rows, companies, currency }: { rows: any[]; companies: any[]; currency: string }) {
  return (
    <>
      {rows.map((row) => (
        <tr key={row.code}>
          <td className="wrap">{row.code} {row.name}</td>
          {companies.map(({ id }) => <td key={id} className="num">{money(row.amounts[id], currency)}</td>)}
          <td className="num">{Number(row.elimination) ? money(-row.elimination, currency) : '—'}</td>
          <td className="num">{money(row.total, currency)}</td>
        </tr>
      ))}
    </>
  );
}

function ReportHead({ companies }: { companies: any[] }) {
  return (
    <thead>
      <tr>
        <th>Account</th>
        {companies.map(({ id, name }) => <th key={id} className="num">{name}</th>)}
        <th className="num">Eliminated</th>
        <th className="num">Group</th>
      </tr>
    </thead>
  );
}

const Section = ({ title, span }: { title: string; span: number }) => <tr className="section"><td colSpan={span}>{title}</td></tr>;

const Total = ({ label, value, span, currency }: { label: string; value: number; span: number; currency: string }) => (
  <tr className="total"><td colSpan={span - 1}>{label}</td><td className="num">{money(value, currency)}</td></tr>
);

function GroupProfit({ overview }: { overview: any }) {
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today());
  const { data, error } = useReport(`/api/accounting/group/profit-and-loss?from=${from}&to=${to}`);
  const { group } = overview;
  const span = (data?.companies.length || 0) + 3;

  return (
    <>
      <div className="report-filters no-print">
        <label>From<input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <label>To<input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="card table-wrap">
        <h2>{group.name} · Consolidated profit and loss</h2>
        <p className="muted">{formatDate(from)} to {formatDate(to)}, in {group.currency}</p>
        {!data ? !error && <p className="empty">Loading…</p> : (
          <table>
            <ReportHead companies={data.companies} />
            <tbody>
              <Section title="Revenue" span={span} />
              <Rows rows={data.revenue} companies={data.companies} currency={group.currency} />
              <Total label="Total revenue" value={data.total_revenue} span={span} currency={group.currency} />
              <Section title="Expenses" span={span} />
              <Rows rows={data.expenses} companies={data.companies} currency={group.currency} />
              <Total label="Total expenses" value={data.total_expenses} span={span} currency={group.currency} />
              {Number(data.elimination_difference) !== 0 && (
                <Total label="Rate difference on eliminated charges" value={data.elimination_difference} span={span} currency={group.currency} />
              )}
              <Total label="Net income" value={data.net_income} span={span} currency={group.currency} />
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function GroupBalance({ overview }: { overview: any }) {
  const [asOf, setAsOf] = useState(today());
  const { data, error } = useReport(`/api/accounting/group/balance-sheet?as_of=${asOf}`);
  const { group } = overview;
  const span = (data?.companies.length || 0) + 3;

  return (
    <>
      <div className="report-filters no-print">
        <label>As of<input type="date" value={asOf} onChange={(e) => e.target.value && setAsOf(e.target.value)} /></label>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="card table-wrap">
        <h2>{group.name} · Consolidated balance sheet</h2>
        <p className="muted">As of {formatDate(asOf)}, in {group.currency}</p>
        {!data ? !error && <p className="empty">Loading…</p> : (
          <>
            <p><span className={`badge ${data.balanced ? 'paid' : 'void'}`}>{data.balanced ? 'In balance' : 'Out of balance'}</span></p>
            <table>
              <ReportHead companies={data.companies} />
              <tbody>
                <Section title="Assets" span={span} />
                <Rows rows={data.assets} companies={data.companies} currency={group.currency} />
                <Total label="Total assets" value={data.total_assets} span={span} currency={group.currency} />
                <Section title="Liabilities" span={span} />
                <Rows rows={data.liabilities} companies={data.companies} currency={group.currency} />
                <Total label="Total liabilities" value={data.total_liabilities} span={span} currency={group.currency} />
                <Section title="Equity" span={span} />
                <Rows rows={data.equity} companies={data.companies} currency={group.currency} />
                <tr>
                  <td>Earnings to date</td>
                  {data.companies.map(({ id }: any) => <td key={id} className="num">{money(data.earnings[id], group.currency)}</td>)}
                  <td className="num">—</td>
                  <td className="num">{money(data.total_earnings, group.currency)}</td>
                </tr>
                {Number(data.translation) !== 0 && (
                  <Total label="Currency translation difference" value={data.translation} span={span} currency={group.currency} />
                )}
                {Number(data.intercompany_difference) !== 0 && (
                  <Total label="Intercompany difference from rates or unmatched entries" value={data.intercompany_difference} span={span} currency={group.currency} />
                )}
                <Total label="Total equity" value={data.total_equity} span={span} currency={group.currency} />
                <Total label="Total liabilities and equity" value={Number(data.total_liabilities) + Number(data.total_equity)} span={span} currency={group.currency} />
              </tbody>
            </table>
          </>
        )}
      </div>
    </>
  );
}
