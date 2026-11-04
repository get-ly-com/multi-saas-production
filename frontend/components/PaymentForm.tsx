import { FormEvent, useEffect, useRef, useState } from 'react';
import { celebrate } from '@/components/Celebrate';
import Modal from '@/components/Modal';
import { toast } from '@/components/Toast';
import { api, money, today } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

type Props = {
  target: { invoice_id?: string; bill_id?: string };
  label: string;
  balance: number;
  currency: string;
  onClose: () => void;
  onSaved: () => void;
};

export default function PaymentForm({ target, label, balance, currency, onClose, onSaved }: Props) {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [form, setForm] = useState({ amount: balance.toFixed(2), payment_date: today(), account_id: '', reference: '', exchange_rate: '' });
  const [base, setBase] = useState(currency);
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm((current) => ({ ...current, [field]: value }));

  useEffect(() => {
    api.get('/api/accounting/accounts')
      .then((rows) => {
        const usable = rows.filter((account: any) => account.is_cash && account.is_active);
        setAccounts(usable);
        const cash = usable.find((account: any) => account.code === '1000') || usable[0];
        if (cash) set('account_id', cash.id);
      })
      .catch((err) => setError(err.message));

    api.get('/api/accounting/currencies')
      .then((data) => {
        setBase(data.base);
        const latest = data.rates.find((row: any) => row.currency === currency);
        if (latest) set('exchange_rate', String(Number(latest.rate)));
      })
      .catch((err) => setError(err.message));
  }, []);

  const button = useRef<HTMLButtonElement>(null);
  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      try {
        await api.post('/api/accounting/payments', { ...target, ...form });
        // Paying off the whole of an invoice is a real win; a part payment or a bill is routine
        const settled = Math.round(Number(form.amount) * 100) >= Math.round(balance * 100);
        if (target.invoice_id && settled) {
          celebrate({ from: button.current });
          toast.success(`${label} is paid`, { detail: `${money(form.amount, currency)} received. Nothing left to chase.` });
        } else if (target.invoice_id) {
          toast.success('Payment recorded', { detail: `${money(form.amount, currency)} on ${label}. ${money(balance - Number(form.amount), currency)} still to come.` });
        } else {
          toast.success(settled ? `${label} is paid` : 'Payment recorded', { detail: `${money(form.amount, currency)} paid${settled ? '' : `, ${money(balance - Number(form.amount), currency)} left to pay`}.` });
        }
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title={`Record payment for ${label}`} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="muted">Balance {money(balance, currency)}</p>
        <div className="form-grid">
          <label>Amount<input required type="number" min="0.01" step="0.01" max={balance} value={form.amount} onChange={(e) => set('amount', e.target.value)} /></label>
          <label>Date<input required type="date" value={form.payment_date} onChange={(e) => set('payment_date', e.target.value)} /></label>
          <label>Paid through
            <select required value={form.account_id} onChange={(e) => set('account_id', e.target.value)}>
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.code} {account.name}</option>)}
            </select>
          </label>
          <label>Reference<input value={form.reference} onChange={(e) => set('reference', e.target.value)} /></label>
          {currency !== base && (
            <label>Rate today (1 {currency} in {base})
              <input required type="number" min="0.00000001" step="any" value={form.exchange_rate} onChange={(e) => set('exchange_rate', e.target.value)} />
            </label>
          )}
        </div>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button ref={button} disabled={busy} className="primary">Record payment</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
