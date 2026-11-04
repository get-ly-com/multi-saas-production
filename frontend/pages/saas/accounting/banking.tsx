import { FormEvent, useEffect, useRef, useState } from 'react';
import { Amount, PageHead, StatusPill, styles } from '@/components/AccountingKit';
import AccountingNav from '@/components/AccountingNav';
import AppShell, { useAccount } from '@/components/AppShell';
import BankImport from '@/components/BankImport';
import { celebrate } from '@/components/Celebrate';
import EmptyState from '@/components/EmptyState';
import Modal from '@/components/Modal';
import { SkeletonStats, SkeletonTable } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api, formatDate, money, today } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

export default function Banking() {
  return <AppShell><BankingApp /></AppShell>;
}

function BankingApp() {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [accountId, setAccountId] = useState('');
  const [tab, setTab] = useState<'lines' | 'reconcile' | 'rules'>('lines');
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api.get('/api/accounting/accounts')
      .then((rows) => {
        const banks = rows.filter((account: any) => account.is_cash && account.is_active);
        setAccounts(rows.filter((account: any) => account.is_active));
        if (banks[0]) setAccountId(banks[0].id);
      })
      .catch((err) => setError(err.message))
      .finally(() => setReady(true));
  }, []);

  const banks = accounts.filter((account) => account.is_cash);

  return (
    <div className="stack">
      <AccountingNav />
      <PageHead title="Banking" line="Match your bank statement to your books, then reconcile to lock it in." />

      <div className="report-filters">
        <label>Account
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {banks.map((account) => (
              <option key={account.id} value={account.id}>{account.code} {account.name}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="tabs">
        <button className={tab === 'lines' ? 'active' : ''} onClick={() => setTab('lines')}>Statement lines</button>
        <button className={tab === 'reconcile' ? 'active' : ''} onClick={() => setTab('reconcile')}>Reconcile</button>
        <button className={tab === 'rules' ? 'active' : ''} onClick={() => setTab('rules')}>Rules</button>
      </div>

      {error && <p className="error">{error}</p>}

      {!ready && <SkeletonTable rows={6} columns={4} />}
      {ready && !accountId && tab !== 'rules' && (
        <div className="card">
          <EmptyState
            icon="bank"
            title="No bank account yet"
            line="Add a bank or cash account to your chart of accounts, then import its statement here."
            action={{ label: 'Open chart of accounts', href: '/saas/accounting/accounts' }}
          />
        </div>
      )}
      {accountId && tab === 'lines' && <StatementLines key={accountId} accountId={accountId} accounts={accounts} />}
      {accountId && tab === 'reconcile' && <Reconcile key={accountId} accountId={accountId} />}
      {tab === 'rules' && <Rules accounts={accounts} />}
    </div>
  );
}

const unmatchedIn = (rows: any[]) => rows.filter((line) => line.status === 'unmatched').length;

function StatementLines({ accountId, accounts }: { accountId: string; accounts: any[] }) {
  const account = useAccount();
  const canEdit = account?.canEdit !== false;
  const [lines, setLines] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [posting, setPosting] = useState<any>(null);
  const [ruleHits, setRuleHits] = useState<Record<string, any>>({});
  const head = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      const [lineRows, hits] = await Promise.all([
        api.get(`/api/accounting/bank/lines?account_id=${accountId}`),
        api.get(`/api/accounting/bank/rules/matches?account_id=${accountId}`)
      ]);
      setLines(lineRows);
      setRuleHits(Object.fromEntries(hits.map((hit: any) => [hit.line_id, hit])));
      setError('');
      return lineRows as any[];
    } catch (err: any) {
      setError(err.message);
      return null;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // The last line to sort out is a real win: the statement and the books agree
  const cheerIfDone = (before: number, after: any[] | null) => {
    if (!after || before === 0 || after.length === 0 || unmatchedIn(after) > 0) return false;
    celebrate({ from: head.current });
    toast.success('Statement fully matched', { detail: 'Every line is matched or sorted. Your books agree with the bank.' });
    return true;
  };

  const { busy, run: once } = useSubmit();
  // One action at a time, so a double click cannot repeat it
  const run = (action: () => Promise<unknown>, title?: string, detail?: string, undo?: () => void) => once(async () => {
    const before = unmatchedIn(lines);
    try {
      await action();
      const after = await load();
      if (cheerIfDone(before, after)) return;
      if (title) toast.success(title, { detail, action: undo ? { label: 'Undo', onClick: undo } : undefined });
    } catch (err: any) {
      setError(err.message);
    }
  });

  const match = (line: any) => run(
    () => api.post(`/api/accounting/bank/lines/${line.id}/match`, { journal_line_id: line.suggested_line_id }),
    'Matched', `${money(line.amount)} on ${formatDate(line.line_date)} now ties to ${line.suggested_memo || 'its entry'}.`,
    () => run(() => api.post(`/api/accounting/bank/lines/${line.id}/unmatch`, {}), 'Match undone')
  );
  const ignore = (line: any) => run(
    () => api.post(`/api/accounting/bank/lines/${line.id}/ignore`, { ignored: true }),
    'Line ignored', 'It stays out of matching. Restore it any time.',
    () => run(() => api.post(`/api/accounting/bank/lines/${line.id}/ignore`, { ignored: false }), 'Line restored')
  );

  const toReview = unmatchedIn(lines);
  const hitCount = Object.keys(ruleHits).length;

  return (
    <>
      <div className="page-head" ref={head}>
        <span className="muted">
          {loading ? '' : lines.length === 0 ? 'No lines yet' : toReview === 0 ? 'All caught up' : `${toReview} ${toReview === 1 ? 'line' : 'lines'} to review`}
        </span>
        <div className="row-actions">
          {hitCount > 0 && (
            <button disabled={busy} onClick={() => {
              if (window.confirm(`Post ${hitCount} lines using your bank rules?`)) {
                const before = unmatchedIn(lines);
                once(async () => {
                  try {
                    const result = await api.post('/api/accounting/bank/rules/apply', { account_id: accountId });
                    const after = await load();
                    if (cheerIfDone(before, after) && !result.skipped) return;
                    toast.success(`Posted ${result.posted} ${result.posted === 1 ? 'line' : 'lines'}`, {
                      detail: result.skipped ? `${result.skipped} could not be posted, for example because their date is locked.` : 'Your rules did the sorting.'
                    });
                  } catch (err: any) {
                    setError(err.message);
                  }
                });
              }
            }}>Post {hitCount} with rules</button>
          )}
          <button className="primary" onClick={() => setImporting(true)}>Import statement</button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {loading ? <SkeletonTable rows={6} columns={4} /> : lines.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="bank"
            title="No statement lines yet"
            line="Download a CSV statement from your bank and import it. We suggest a match for each line."
            action={canEdit ? { label: 'Import statement', onClick: () => setImporting(true) } : undefined}
          />
        </div>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Description</th><th className="num">Amount</th><th>Status</th><th /></tr></thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id}>
                  <td>{formatDate(line.line_date)}</td>
                  <td className="wrap">
                    {line.description}
                    {line.status === 'matched' && <span className={styles.rowSub}>{line.matched_memo}</span>}
                    {line.suggested_line_id && <span className={styles.rowSub}>Looks like: {line.suggested_memo}, {formatDate(line.suggested_date)}</span>}
                    {ruleHits[line.id] && <span className={styles.rowSub}>Rule “{ruleHits[line.id].rule_name}”: post to {ruleHits[line.id].account_label}</span>}
                  </td>
                  <td className="num"><Amount value={line.amount} /></td>
                  <td><StatusPill status={line.reconciled ? 'reconciled' : line.status} /></td>
                  <td>
                    <div className="row-actions">
                      {line.suggested_line_id && <button className="small" disabled={busy} onClick={() => match(line)}>Match</button>}
                      {ruleHits[line.id] && (
                        <button className="small" disabled={busy} onClick={() => run(
                          () => api.post('/api/accounting/bank/rules/apply', { account_id: accountId, line_ids: [line.id] }),
                          'Posted with your rule', `${money(line.amount)} went to ${ruleHits[line.id].account_label}.`
                        )}>Use rule</button>
                      )}
                      {line.status === 'unmatched' && (
                        <>
                          <button className="small" onClick={() => setPosting(line)}>Post</button>
                          <button className="small" disabled={busy} onClick={() => ignore(line)}>Ignore</button>
                        </>
                      )}
                      {line.status === 'ignored' && (
                        <button className="small" disabled={busy} onClick={() => run(() => api.post(`/api/accounting/bank/lines/${line.id}/ignore`, { ignored: false }), 'Line restored', 'It is back in the list to review.')}>Restore</button>
                      )}
                      {line.status === 'matched' && !line.reconciled && (
                        <button className="small" disabled={busy} onClick={() => run(() => api.post(`/api/accounting/bank/lines/${line.id}/unmatch`, {}), 'Match undone', 'The line is back in the list to review.')}>Unmatch</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {importing && (
        <BankImport
          accountId={accountId}
          onClose={() => setImporting(false)}
          onSaved={async (message) => {
            toast.success('Statement imported', { detail: message });
            await load();
          }}
        />
      )}
      {posting && (
        <PostForm
          line={posting}
          accounts={accounts.filter((account) => account.id !== accountId && !['1200', '2000'].includes(account.code))}
          onClose={() => setPosting(null)}
          onSaved={async () => {
            const before = unmatchedIn(lines);
            const after = await load();
            if (!cheerIfDone(before, after)) toast.success('Posted to the books', { detail: `${money(posting.amount)} on ${formatDate(posting.line_date)} is recorded.` });
          }}
        />
      )}
    </>
  );
}

function PostForm({ line, accounts, onClose, onSaved }: { line: any; accounts: any[]; onClose: () => void; onSaved: () => void }) {
  const [accountId, setAccountId] = useState('');
  const [memo, setMemo] = useState(line.description);
  const [error, setError] = useState('');

  const { busy, run: once } = useSubmit();
  const save = () => once(async () => {
    try {
      await api.post(`/api/accounting/bank/lines/${line.id}/post`, { account_id: accountId, memo });
      await onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  });

  return (
    <Modal title={`Post ${money(line.amount)} to the books`} onClose={onClose}>
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
        <button className="primary" disabled={busy || !accountId} onClick={save}>Post</button>
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
  const finishButton = useRef<HTMLButtonElement>(null);

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

  const { busy, run: once } = useSubmit();
  // One action at a time, so a double click cannot repeat it
  const run = (action: () => Promise<unknown>, title?: string, detail?: string) => once(async () => {
    try {
      await action();
      await load();
      if (title) toast.success(title, { detail });
    } catch (err: any) {
      setError(err.message);
    }
  });

  const unclear = (item: any) => {
    if (window.confirm('Unclear this item? If it was posted from a statement line, that entry is reversed.')) {
      run(() => api.post(`/api/accounting/bank/lines/${item.bank_line_id}/unmatch`, {}), 'Item uncleared', 'It is back in the list of items not cleared yet.');
    }
  };

  // Reconciling to the bank's own balance is a real win, so it gets a small celebration
  const finish = () =>
    once(async () => {
      try {
        await api.post('/api/accounting/bank/reconcile', { account_id: accountId, statement_date: asOf, statement_balance: balance });
        await load();
        celebrate({ from: finishButton.current });
        toast.success(`Reconciled to ${formatDate(asOf)}`, { detail: 'Your books match the bank. Cleared items up to that date are now locked.' });
        setBalance('');
      } catch (err: any) {
        setError(err.message);
      }
    });

  if (!status) return error ? <p className="error">{error}</p> : <><SkeletonStats count={3} /><SkeletonTable rows={4} columns={4} /></>;

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

      <div className="stats">
        <div className="card"><div className="stat-label">Book balance</div><div className="stat-value"><Amount value={status.book_balance} /></div></div>
        <div className="card"><div className="stat-label">Cleared</div><div className="stat-value"><Amount value={status.cleared_balance} /></div></div>
        <div className="card">
          <div className="stat-label">Difference</div>
          <div className="stat-value">{balance === '' ? <span className="muted">Enter the balance</span> : difference === 0 ? <span style={{ color: 'var(--good)' }}>{money(0)}</span> : <Amount value={difference} />}</div>
        </div>
      </div>

      <div className="form-actions">
        <button ref={finishButton} className="primary" disabled={busy || balance === '' || difference !== 0} onClick={finish}>Finish reconciliation</button>
        {balance !== '' && difference !== 0 && <span className="muted">Clear items until the difference is zero.</span>}
      </div>

      <div className="card table-wrap">
        <h2>Not cleared yet</h2>
        {status.uncleared.length === 0 ? (
          <EmptyState compact tone="done" icon="paid" title="Everything has cleared" line="Nothing is waiting on the bank." />
        ) : (
          <table>
            <thead><tr><th>#</th><th>Date</th><th>Description</th><th className="num">Amount</th><th /></tr></thead>
            <tbody>
              {status.uncleared.map((item: any) => (
                <tr key={item.id}>
                  <td>{item.entry_number}</td>
                  <td>{formatDate(item.entry_date)}</td>
                  <td className="wrap">{item.memo}</td>
                  <td className="num"><Amount value={item.amount} /></td>
                  <td className="num"><button className="small" disabled={busy} onClick={() => run(() => api.post('/api/accounting/bank/clear', { journal_line_id: item.id }), 'Cleared', `${money(item.amount)} counts toward the cleared balance.`)}>Clear</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card table-wrap">
        <h2>Cleared</h2>
        {status.cleared.length === 0 ? (
          <EmptyState compact icon="bank" title="Nothing cleared yet" line="Items you clear since the last reconciliation show up here." />
        ) : (
          <table>
            <thead><tr><th>#</th><th>Date</th><th>Description</th><th className="num">Amount</th><th /></tr></thead>
            <tbody>
              {status.cleared.map((item: any) => (
                <tr key={item.bank_line_id}>
                  <td>{item.entry_number}</td>
                  <td>{formatDate(item.entry_date)}</td>
                  <td className="wrap">{item.memo}</td>
                  <td className="num"><Amount value={item.amount} /></td>
                  <td className="num"><button className="small" disabled={busy} onClick={() => unclear(item)}>Unclear</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

const DIRECTIONS: Record<string, string> = { any: 'Money in or out', in: 'Money in', out: 'Money out' };
const blankRule = { name: '', match_text: '', direction: 'out', min_amount: '', max_amount: '', bank_account_id: '', account_id: '', memo: '', position: '100', is_active: true };

// Rules post routine statement lines, such as bank fees or subscriptions, without choosing an account each time
function Rules({ accounts }: { accounts: any[] }) {
  const account = useAccount();
  const canEdit = account?.canEdit !== false;
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

  const { busy, run: once } = useSubmit();
  // One action at a time, so a double click cannot repeat it
  const run = (action: () => Promise<unknown>, title?: string, detail?: string, undo?: () => void) => once(async () => {
    try {
      await action();
      await load();
      if (title) toast.success(title, { detail, action: undo ? { label: 'Undo', onClick: undo } : undefined });
    } catch (err: any) {
      setError(err.message);
    }
  });

  const setActive = (rule: any, is_active: boolean, undoing = false): Promise<unknown> => run(
    () => api.post('/api/accounting/bank/rules', { ...rule, is_active }),
    undoing ? (is_active ? 'Rule resumed' : 'Rule paused') : is_active ? `${rule.name} resumed` : `${rule.name} paused`,
    undoing ? undefined : is_active ? 'It suggests postings again.' : 'It stops suggesting postings until you resume it.',
    undoing ? undefined : () => { setActive(rule, !is_active, true); }
  );

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

      {loading ? <SkeletonTable rows={4} columns={5} /> : rules.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="sparkle"
            title="No rules yet"
            line="Add one for bank fees, card charges or anything else that turns up every month. We sort them for you after that."
            action={canEdit ? { label: 'New rule', onClick: () => setForm(blankRule) } : undefined}
          />
        </div>
      ) : (
      <div className="card table-wrap">
        {(
          <table>
            <thead><tr><th>Order</th><th>Rule</th><th>Description contains</th><th>When</th><th>Post to</th><th /></tr></thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id}>
                  <td>{rule.position}</td>
                  <td className="wrap">{rule.name}{!rule.is_active && <> <StatusPill status="paused" /></>}</td>
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
                      <button disabled={busy} onClick={() => setActive(rule, !rule.is_active)}>{rule.is_active ? 'Pause' : 'Resume'}</button>
                      <button className="danger" onClick={() => {
                        if (window.confirm(`Delete the rule "${rule.name}"? Lines already posted stay as they are.`)) {
                          run(() => api.delete(`/api/accounting/bank/rules/${rule.id}`), 'Rule deleted', 'Lines it already posted stay as they are.');
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
      )}

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

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        const { id, name, match_text, direction, min_amount, max_amount, bank_account_id, account_id, memo, position, is_active } = form;
        await api.post('/api/accounting/bank/rules', { id, name, match_text, direction, min_amount, max_amount, bank_account_id, account_id, memo, position, is_active });
        toast.success(id ? 'Rule saved' : 'Rule added', { detail: `Lines with “${match_text}” will be suggested for posting.` });
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title={form.id ? 'Edit bank rule' : 'New bank rule'} onClose={onClose}>
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
          <button disabled={busy} className="primary">Save rule</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
