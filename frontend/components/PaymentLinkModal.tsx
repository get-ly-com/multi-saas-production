import { FormEvent, useEffect, useState } from 'react';
import Modal from '@/components/Modal';
import { api, money } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

export const payLinkUrl = (token: string) =>
  `${typeof window === 'undefined' ? '' : window.location.origin}/pay/${token}`;

// A link the customer can open to pay the invoice by card. The first time, someone picks the
// bank or clearing account card payments go into.
export default function PaymentLinkModal({ invoice, onClose, onSaved }: { invoice: any; onClose: () => void; onSaved?: () => void }) {
  const balance = Number(invoice.amount) - Number(invoice.amount_paid) - Number(invoice.amount_credited);
  const [setup, setSetup] = useState<{ ready: boolean; account_id: string | null } | null>(null);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [accountId, setAccountId] = useState('');
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  const makeLink = async () => {
    const { token } = await api.post(`/api/accounting/invoices/${invoice.id}/payment-link`, {});
    setLink(payLinkUrl(token));
    onSaved?.();
  };

  useEffect(() => {
    Promise.all([api.get('/api/accounting/online-payments'), api.get('/api/accounting/accounts')])
      .then(async ([settings, rows]) => {
        const usable = rows.filter((account: any) => account.is_cash && account.is_active);
        setAccounts(usable);
        setAccountId(settings.account_id || usable[0]?.id || '');
        setSetup(settings);
        if (settings.ready && settings.account_id) await makeLink();
      })
      .catch((err) => setError(err.message));
  }, []);

  const { busy, run } = useSubmit();
  const saveAccount = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        setError('');
        await api.put('/api/accounting/online-payments', { account_id: accountId });
        setSetup((current) => (current ? { ...current, account_id: accountId } : current));
        if (!link) await makeLink();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setError('Could not copy. Select the link and copy it yourself.');
    }
  };

  return (
    <Modal title={`Payment link for ${invoice.invoice_number}`} onClose={onClose}>
      <div className="stack">
        <p className="muted">Your customer can open this link to pay {money(balance, invoice.currency)} by card.</p>
        {!setup && !error && <p className="empty">Loading…</p>}
        {setup && !setup.ready && <p>Online payments aren’t set up yet.</p>}

        {setup?.ready && (
          <form onSubmit={saveAccount}>
            <div className="form-grid">
              <label>Card payments go into
                <select required value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                  {accounts.length === 0 && <option value="">Add a bank account first</option>}
                  {accounts.map((account) => <option key={account.id} value={account.id}>{account.code} {account.name}</option>)}
                </select>
              </label>
            </div>
            {(!setup.account_id || accountId !== setup.account_id) && (
              <div className="form-actions">
                <button disabled={busy || !accountId} className="primary">{setup.account_id ? 'Save account' : 'Save and get link'}</button>
              </div>
            )}
          </form>
        )}

        {link && (
          <div>
            <label>Payment link<input readOnly value={link} onFocus={(e) => e.target.select()} /></label>
            <div className="form-actions">
              <button type="button" className="primary" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button>
              <a href={link} target="_blank" rel="noreferrer">Open</a>
            </div>
          </div>
        )}

        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </Modal>
  );
}
