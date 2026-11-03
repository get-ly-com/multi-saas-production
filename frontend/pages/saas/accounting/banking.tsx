import { FormEvent, useEffect, useState } from 'react';
import AccountingNav from '@/components/AccountingNav';
import AppShell from '@/components/AppShell';
import BankImport from '@/components/BankImport';
import Modal from '@/components/Modal';
import { api, formatDate, money, today } from '@/lib/api';

export default function Banking() {
  return <AppShell><BankingApp /></AppShell>;
}

function BankingApp() {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [accountId, setAccountId] = useState('');
  const [tab, setTab] = useState<'lines' | 'reconcile' | 'rules'>('lines');
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/accounting/accounts')
      .then((rows) => {
        const banks = rows.filter((account: any) => account.is_cash && account.is_active);
        setAccounts(rows.filter((account: any) => account.is_active));
        if (banks[0]) setAccountId(banks[0].id);
      })
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div className="stack">
      <AccountingNav />
      <div className="page-head"><h1>Banking</h1></div>

      <label>Account
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.filter((account) => account.is_cash).map((account) => (
            <option key={account.id} value={account.id}>{account.code} {account.name}</option>
          ))}
        </select>
      </label>

      <div className="tabs">
        <button className={tab === 'lines' ? 'active' : ''} onClick={() => setTab('lines')}>Statement lines</button>
        <button className={tab === 'reconcile' ? 'active' : ''} onClick={() => setTab('reconcile')}>Reconcile</button>
        <button className={tab === 'rules' ? 'active' : ''} onClick={() => setTab('rules')}>Rules</button>
      </div>

      {error && <p className="error">{error}</p>}

      {accountId && tab === 'lines' && <StatementLines key={accountId} accountId={accountId} accounts={accounts} />}
      {accountId && tab === 'reconcile' && <Reconcile key={accountId} accountId={accountId} />}
      {tab === 'rules' && <Rules accounts={accounts} />}
    </div>
  );
}

function StatementLines({ accountId, accounts }: { accountId: string; accounts: any[] }) {
  const [lines, setLines] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [importing, setImporting] = useState(false);
  const [posting, setPosting] = useState<any>(null);
  const [ruleHits, setRuleHits] = useState<Record<string, any>>({});

  const load = async () => {
    try {
      const [lineRows, hits] = await Promise.all([
        api.get(`/api/accounting/bank/lines?account_id=${accountId}`),
        api.get(`/api/accounting/bank/rules/matches?account_id=${accountId}`)
      ]);
      setLines(lineRows);
      setRuleHits(Object.fromEntries(hits.map((hit: any) => [hit.line_id, hit])));
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

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <>
      <div className="page-head">
        <span className="muted">{lines.filter((line) => line.status === 'unmatched').length} lines to review</span>
        <div className="row-actions">
          {Object.keys(ruleHits).length > 0 && (
            <button onClick={() => {
              if (window.confirm(`Post ${Object.keys(ruleHits).length} lines using your bank rules?`)) {
                run(async () => {
                  const result = await api.post('/api/accounting/bank/rules/apply', { account_id: accountId });
                  setNotice(`Posted ${result.posted} lines${result.skipped ? `. ${result.skipped} could not be posted, for example because their date is locked.` : '.'}`);
                });
              }
            }}>Post {Object.keys(ruleHits).length} with rules</button>
          )}
          <button className="primary" onClick={() => setImporting(true)}>Import statement</button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="card table-wrap">
        {loading ? <p className="empty">Loading…</p> : (
          <table>
            <thead><tr><th>Date</th><th>Description</th><th className="num">Amount</th><th>Status</th><th /></tr></thead>
            <tbody>
              {lines.length === 0 && <tr><td colSpan={5} className="empty">No statement lines yet</td></tr>}
              {lines.map((line) => (
                <tr key={line.id}>
                  <td>{formatDate(line.line_date)}</td>
                  <td className="wrap">
                    {line.description}
                    {line.status === 'matched' && <div className="muted">{line.matched_memo}</div>}
                    {line.suggested_line_id && <div className="muted">Looks like: {line.suggested_memo}, {formatDate(line.suggested_date)}</div>}
                    {ruleHits[line.id] && <div className="muted">Rule “{ruleHits[line.id].rule_name}”: post to {ruleHits[line.id].account_label}</div>}
                  </td>
                  <td className="num">{money(line.amount)}</td>
                  <td><span className={`badge ${line.status === 'matched' ? 'paid' : ''}`}>{line.reconciled ? 'reconciled' : line.status}</span></td>
                  <td>
                    <div className="row-actions">
                      {line.suggested_line_id && (
                        <button onClick={() => run(() => api.post(`/api/accounting/bank/lines/${line.id}/match`, { journal_line_id: line.suggested_line_id }))}>Match</button>
                      )}
                      {ruleHits[line.id] && (
                        <button onClick={() => run(() => api.post('/api/accounting/bank/rules/apply', { account_id: accountId, line_ids: [line.id] }))}>Use rule</button>
                      )}
                      {line.status === 'unmatched' && (
                        <>
                          <button onClick={() => setPosting(line)}>Post</button>
                          <button onClick={() => run(() => api.post(`/api/accounting/bank/lines/${line.id}/ignore`, { ignored: true }))}>Ignore</button>
                        </>
                      )}
                      {line.status === 'ignored' && (
                        <button onClick={() => run(() => api.post(`/api/accounting/bank/lines/${line.id}/ignore`, { ignored: false }))}>Restore</button>
                      )}
                      {line.status === 'matched' && !line.reconciled && (
                        <button onClick={() => run(() => api.post(`/api/accounting/bank/lines/${line.id}/unmatch`, {}))}>Unmatch</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {importing && (
        <BankImport
          accountId={accountId}
          onClose={() => setImporting(false)}
          onSaved={async (message) => {
            setNotice(message);
            await load();
          }}
        />
      )}
      {posting && (
        <PostForm
          line={posting}
          accounts={accounts.filter((account) => account.id !== accountId && !['1200', '2000'].includes(account.code))}
          onClose={() => setPosting(null)}
          onSaved={load}
        />
      )}
    </>
  );
}

function PostForm({ line, accounts, onClose, onSaved }: { line: any; accounts: any[]; onClose: () => void; onSaved: () => void }) {
  const [accountId, setAccountId] = useState('');
  const [memo, setMemo] = useState(line.description);
  const [error, setError] = useState('');

  const save = async () => {
    try {
      await api.post(`/api/accounting/bank/lines/${line.id}/post`, { account_id: accountId, memo });
      await onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title={`Post ${money(line.amount)} to the books`}>
      <p className="muted">Use this for money the books don't have yet, such as a bank fee. Customer and vendor money should be matched to its payment instead.</p>
      <div className="form-grid">
        <label>Account
          <select required value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Choose an account</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.code} {account.name}</option>)}
          </select>
        </label>
        <label>Description<input value={memo} onChange={(e) => setMemo(e.target.value)} /></label>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button className="primary" disabled={!accountId} onClick={save}>Post</button>
        <button type="button" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

function Reconcile({ accountId }: { accountId: string }) {
  const [asOf, setAsOf] = useState(today());
  const [balance, setBalance] = useState('');
  const [status, setStatus] = useState<any>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    try {
      setStatus(await api.get(`/api/accounting/bank/reconcile?account_id=${accountId}&as_of=${asOf}`));
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, [asOf]);

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const unclear = (item: any) => {
    if (window.confirm('Unclear this item? If it was posted from a statement line, that entry is reversed.')) {
      run(() => api.post(`/api/accounting/bank/lines/${item.bank_line_id}/unmatch`, {}));
    }
  };

  const finish = () =>
    run(async () => {
      await api.post('/api/accounting/bank/reconcile', { account_id: accountId, statement_date: asOf, statement_balance: balance });
      setNotice(`Reconciled to ${formatDate(asOf)}. Cleared items up to that date are now locked.`);
      setBalance('');
    });

  if (!status) return error ? <p className="error">{error}</p> : <p className="empty">Loading…</p>;

  const cents = (value: unknown) => Math.round(Number(value) * 100);
  const difference = (cents(balance) - cents(status.cleared_balance)) / 100;

  return (
    <>
      <div className="report-filters">
        <label>Statement date<input type="date" value={asOf} onChange={(e) => e.target.value && setAsOf(e.target.value)} /></label>
        <label>Statement ending balance<input type="number" step="0.01" value={balance} onChange={(e) => setBalance(e.target.value)} /></label>
      </div>

      {status.last_reconciled && <p className="muted">Last reconciled to {formatDate(status.last_reconciled)}</p>}
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="stats">
        <div className="card"><div className="stat-label">Book balance</div><div className="stat-value">{money(status.book_balance)}</div></div>
        <div className="card"><div className="stat-label">Cleared</div><div className="stat-value">{money(status.cleared_balance)}</div></div>
        <div className="card"><div className="stat-label">Difference</div><div className="stat-value">{balance === '' ? '—' : money(difference)}</div></div>
      </div>

      <div className="form-actions">
        <button className="primary" disabled={balance === '' || difference !== 0} onClick={finish}>Finish reconciliation</button>
      </div>

      <div className="card table-wrap">
        <h2>Not cleared yet</h2>
        <table>
          <thead><tr><th>#</th><th>Date</th><th>Description</th><th className="num">Amount</th><th /></tr></thead>
          <tbody>
            {status.uncleared.length === 0 && <tr><td colSpan={5} className="empty">Everything has cleared</td></tr>}
            {status.uncleared.map((item: any) => (
              <tr key={item.id}>
                <td>{item.entry_number}</td>
                <td>{formatDate(item.entry_date)}</td>
                <td className="wrap">{item.memo}</td>
                <td className="num">{money(item.amount)}</td>
                <td className="num"><button onClick={() => run(() => api.post('/api/accounting/bank/clear', { journal_line_id: item.id }))}>Clear</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card table-wrap">
        <h2>Cleared</h2>
        <table>
          <thead><tr><th>#</th><th>Date</th><th>Description</th><th className="num">Amount</th><th /></tr></thead>
          <tbody>
            {status.cleared.length === 0 && <tr><td colSpan={5} className="empty">Nothing cleared since the last reconciliation</td></tr>}
            {status.cleared.map((item: any) => (
              <tr key={item.bank_line_id}>
                <td>{item.entry_number}</td>
                <td>{formatDate(item.entry_date)}</td>
                <td className="wrap">{item.memo}</td>
                <td className="num">{money(item.amount)}</td>
                <td className="num"><button onClick={() => unclear(item)}>Unclear</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

const DIRECTIONS: Record<string, string> = { any: 'Money in or out', in: 'Money in', out: 'Money out' };
const blankRule = { name: '', match_text: '', direction: 'out', min_amount: '', max_amount: '', bank_account_id: '', account_id: '', memo: '', position: '100', is_active: true };

// Rules post routine statement lines, such as bank fees or subscriptions, without choosing an account each time
function Rules({ accounts }: { accounts: any[] }) {
  const [rules, setRules] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState<any>(null);

  const load = async () => {
    try {
      setRules(await api.get('/api/accounting/bank/rules'));
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

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const amounts = (rule: any) => {
    if (rule.min_amount === null && rule.max_amount === null) return 'Any amount';
    if (rule.min_amount === null) return `Up to ${money(rule.max_amount)}`;
    if (rule.max_amount === null) return `${money(rule.min_amount)} or more`;
    return `${money(rule.min_amount)} to ${money(rule.max_amount)}`;
  };

  return (
    <>
      <div className="page-head">
        <span className="muted">Statement lines whose description contains the words you give are suggested for posting to the rule&apos;s account. Rules are tried in order and the first that fits wins. Lines that look like a recorded payment are always left for matching.</span>
        <button className="primary" onClick={() => setForm(blankRule)}>New rule</button>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="card table-wrap">
        {loading ? <p className="empty">Loading…</p> : (
          <table>
            <thead><tr><th>Order</th><th>Rule</th><th>Description contains</th><th>When</th><th>Post to</th><th /></tr></thead>
            <tbody>
              {rules.length === 0 && <tr><td colSpan={6} className="empty">No rules yet. Add one for bank fees, card charges or other lines that come every month.</td></tr>}
              {rules.map((rule) => (
                <tr key={rule.id}>
                  <td>{rule.position}</td>
                  <td className="wrap">{rule.name}{!rule.is_active && <span className="muted"> (paused)</span>}</td>
                  <td className="wrap">&ldquo;{rule.match_text}&rdquo;</td>
                  <td className="wrap">
                    {DIRECTIONS[rule.direction]} · {amounts(rule)}
                    {rule.bank_account && <div className="muted">Only {rule.bank_account.code} {rule.bank_account.name}</div>}
                  </td>
                  <td className="wrap">{rule.account?.code} {rule.account?.name}{rule.memo && <div className="muted">As &ldquo;{rule.memo}&rdquo;</div>}</td>
                  <td>
                    <div className="row-actions">
                      <button onClick={() => setForm({
                        ...rule,
                        min_amount: rule.min_amount ?? '',
                        max_amount: rule.max_amount ?? '',
                        bank_account_id: rule.bank_account_id || '',
                        memo: rule.memo || '',
                        position: String(rule.position)
                      })}>Edit</button>
                      <button onClick={() => run(() => api.post('/api/accounting/bank/rules', { ...rule, is_active: !rule.is_active }))}>{rule.is_active ? 'Pause' : 'Resume'}</button>
                      <button className="danger" onClick={() => {
                        if (window.confirm(`Delete the rule "${rule.name}"? Lines already posted stay as they are.`)) {
                          run(() => api.delete(`/api/accounting/bank/rules/${rule.id}`));
                        }
                      }}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {form && <RuleForm initial={form} accounts={accounts} onClose={() => setForm(null)} onSaved={load} />}
    </>
  );
}

function RuleForm({ initial, accounts, onClose, onSaved }: { initial: any; accounts: any[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<any>(initial);
  const [error, setError] = useState('');
  const set = (field: string, value: unknown) => setForm({ ...form, [field]: value });
  const banks = accounts.filter((account) => account.is_cash);
  const targets = accounts.filter((account) => account.id !== form.bank_account_id && !['1200', '2000'].includes(account.code));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const { id, name, match_text, direction, min_amount, max_amount, bank_account_id, account_id, memo, position, is_active } = form;
      await api.post('/api/accounting/bank/rules', { id, name, match_text, direction, min_amount, max_amount, bank_account_id, account_id, memo, position, is_active });
      await onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title={form.id ? 'Edit bank rule' : 'New bank rule'}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Name<input required maxLength={80} placeholder="Bank fees" value={form.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label>Description contains<input required maxLength={120} placeholder="fee" value={form.match_text} onChange={(e) => set('match_text', e.target.value)} /></label>
          <label>Applies to
            <select value={form.direction} onChange={(e) => set('direction', e.target.value)}>
              {Object.entries(DIRECTIONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>Bank account
            <select value={form.bank_account_id} onChange={(e) => set('bank_account_id', e.target.value)}>
              <option value="">Any bank account</option>
              {banks.map((account) => <option key={account.id} value={account.id}>{account.code} {account.name}</option>)}
            </select>
          </label>
          <label>Smallest amount<input type="number" min="0" step="0.01" placeholder="Any" value={form.min_amount} onChange={(e) => set('min_amount', e.target.value)} /></label>
          <label>Largest amount<input type="number" min="0" step="0.01" placeholder="Any" value={form.max_amount} onChange={(e) => set('max_amount', e.target.value)} /></label>
          <label>Post to account
            <select required value={form.account_id} onChange={(e) => set('account_id', e.target.value)}>
              <option value="">Choose an account</option>
              {targets.map((account) => <option key={account.id} value={account.id}>{account.code} {account.name}</option>)}
            </select>
          </label>
          <label>Description in the books<input maxLength={200} placeholder="Keep the bank's wording" value={form.memo} onChange={(e) => set('memo', e.target.value)} /></label>
          <label>Order<input type="number" min="0" max="9999" step="1" value={form.position} onChange={(e) => set('position', e.target.value)} /></label>
        </div>
        <p className="muted">Amounts are compared without their sign, so 50 matches both 50 coming in and 50 going out.</p>
        <label className="check">
          <input type="checkbox" checked={form.is_active} onChange={(e) => set('is_active', e.target.checked)} />
          Active
        </label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary">Save rule</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
