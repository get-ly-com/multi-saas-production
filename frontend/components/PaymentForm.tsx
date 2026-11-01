import { FormEvent, useEffect, useState } from 'react';
import Modal from '@/components/Modal';
import { api, money, today } from '@/lib/api';

type Props = {
  target: { invoice_id?: string; bill_id?: string };
  label: string;
  balance: number;
  onClose: () => void;
  onSaved: () => void;
};

export default function PaymentForm({ target, label, balance, onClose, onSaved }: Props) {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [form, setForm] = useState({ amount: balance.toFixed(2), payment_date: today(), account_id: '', reference: '' });
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm((current) => ({ ...current, [field]: value }));

  useEffect(() => {
    api.get('/api/accounting/accounts')
      .then((rows) => {
        const usable = rows.filter((account: any) => account.type === 'asset' && account.is_active && account.code !== '1200');
        setAccounts(usable);
        const cash = usable.find((account: any) => account.code === '1000') || usable[0];
        if (cash) set('account_id', cash.id);
      })
      .catch((err) => setError(err.message));
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post('/api/accounting/payments', { ...target, ...form });
      await onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal title={`Record payment for ${label}`}>
      <form onSubmit={submit}>
        <p className="muted">Balance {money(balance)}</p>
        <div className="form-grid">
          <label>Amount<input required type="number" min="0.01" step="0.01" max={balance} value={form.amount} onChange={(e) => set('amount', e.target.value)} /></label>
          <label>Date<input required type="date" value={form.payment_date} onChange={(e) => set('payment_date', e.target.value)} /></label>
          <label>Paid through
            <select required value={form.account_id} onChange={(e) => set('account_id', e.target.value)}>
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.code} {account.name}</option>)}
            </select>
          </label>
          <label>Reference<input value={form.reference} onChange={(e) => set('reference', e.target.value)} /></label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary">Record payment</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
