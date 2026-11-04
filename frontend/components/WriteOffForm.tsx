import { FormEvent, useEffect, useState } from 'react';
import Modal from '@/components/Modal';
import { toast } from '@/components/Toast';
import { api, money, today } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

type Props = { invoice: any; onClose: () => void; onSaved: () => void };

// Settles what is left on an invoice against an expense account, for money that will never come in
export default function WriteOffForm({ invoice, onClose, onSaved }: Props) {
  const balance = Number(invoice.amount) - Number(invoice.amount_paid) - Number(invoice.amount_credited);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [form, setForm] = useState({ write_off_date: today(), account_id: '', reason: '' });
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm((current) => ({ ...current, [field]: value }));

  useEffect(() => {
    api.get('/api/accounting/accounts')
      .then((rows) => {
        const usable = rows.filter((account: any) => account.type === 'expense' && account.is_active && !account.is_cash);
        setAccounts(usable);
        const badDebts = usable.find((account: any) => account.code === '6300') || usable[0];
        if (badDebts) set('account_id', badDebts.id);
      })
      .catch((err) => setError(err.message));
  }, []);

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api.post(`/api/accounting/invoices/${invoice.id}/write-off`, form);
        toast.success(`${invoice.invoice_number} written off`, { detail: `${money(balance, invoice.currency)} moved to expenses. You can undo it from the invoice page.` });
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title={`Write off ${invoice.invoice_number}`} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="muted">
          Marks the remaining {money(balance, invoice.currency)} as never to be paid and moves it to an expense account.
          No money changes hands. Tax already charged on the invoice stays in the tax report. You can undo this by voiding the write-off on the invoice.
        </p>
        <div className="form-grid">
          <label>Date<input required type="date" value={form.write_off_date} onChange={(e) => set('write_off_date', e.target.value)} /></label>
          <label>Expense account
            <select required value={form.account_id} onChange={(e) => set('account_id', e.target.value)}>
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.code} {account.name}</option>)}
            </select>
          </label>
        </div>
        <label style={{ marginTop: 12 }}>Reason<input required maxLength={200} placeholder="For example: customer closed down, small difference" value={form.reason} onChange={(e) => set('reason', e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary" disabled={busy || !form.account_id}>Write off {money(balance, invoice.currency)}</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
