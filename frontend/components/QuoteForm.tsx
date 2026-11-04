import { FormEvent, useEffect, useState } from 'react';
import Modal from '@/components/Modal';
import { api, money, today } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

const blankLine = { item_id: '', description: '', quantity: '1', unit_price: '', discount: '0', tax_rate_id: '' };

const later = (days: number) => {
  const date = new Date(`${today()}T00:00:00`);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

// The database repeats this when saving, so the preview can't change the total
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const lineNet = (line: any) => round(Number(line.quantity || 0) * Number(line.unit_price || 0) * (100 - Number(line.discount || 0)) / 100);

export default function QuoteForm({ initial, onClose, onSaved }: { initial?: any; onClose: () => void; onSaved: (id: string) => void }) {
  const [form, setForm] = useState<any>({
    deal_id: '', contact_id: '', company_id: '', issue_date: today(), valid_until: later(30), due_days: '30', notes: '',
    line_items: [blankLine],
    ...initial
  });
  const [items, setItems] = useState<any[]>([]);
  const [taxRates, setTaxRates] = useState<any[]>([]);
  const [contacts, setContacts] = useState<any[]>([]);
  const [companies, setCompanies] = useState<any[]>([]);
  const [error, setError] = useState('');
  const set = (field: string, value: unknown) => setForm((current: any) => ({ ...current, [field]: value }));

  useEffect(() => {
    Promise.all([
      api.get('/api/inventory/items'),
      api.get('/api/accounting/tax-rates'),
      api.get('/api/crm/contacts'),
      api.get('/api/crm/companies')
    ])
      .then(([itemRows, rateRows, contactRows, companyRows]) => {
        setItems(itemRows);
        setTaxRates(rateRows);
        setContacts(contactRows);
        setCompanies(companyRows);
      })
      .catch((err) => setError(err.message));
  }, []);

  const setLine = (index: number, changes: any) =>
    set('line_items', form.line_items.map((line: any, i: number) => (i === index ? { ...line, ...changes } : line)));

  const chooseItem = (index: number, id: string) => {
    const item = items.find((row) => row.id === id);
    setLine(index, item ? { item_id: id, description: item.name, unit_price: item.price ?? '' } : { item_id: '' });
  };

  const subtotal = form.line_items.reduce((sum: number, line: any) => sum + lineNet(line), 0);
  const tax = form.line_items.reduce((sum: number, line: any) => {
    const rate = taxRates.find(({ id }) => id === line.tax_rate_id);
    return sum + round(lineNet(line) * Number(rate?.rate || 0) / 100);
  }, 0);

  const short = (line: any) => {
    const item = items.find(({ id }) => id === line.item_id);
    return item && Number(line.quantity) > item.quantity ? item : null;
  };

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      const { id, deal_id, contact_id, company_id, issue_date, valid_until, due_days, notes, line_items } = form;
      try {
        const saved = await api.post('/api/crm/quotes', { id, deal_id, contact_id, company_id, issue_date, valid_until, due_days, notes, line_items });
        await onSaved(saved);
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title={form.id ? `Edit ${form.quote_number}` : 'New quote'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          {!form.deal_id && (
            <>
              <label>Contact
                <select value={form.contact_id || ''} onChange={(e) => set('contact_id', e.target.value)}>
                  <option value="">None</option>
                  {contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}
                </select>
              </label>
              <label>Company
                <select value={form.company_id || ''} onChange={(e) => set('company_id', e.target.value)}>
                  <option value="">None</option>
                  {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
                </select>
              </label>
            </>
          )}
          <label>Quote date<input required type="date" value={form.issue_date} onChange={(e) => set('issue_date', e.target.value)} /></label>
          <label>Valid until<input type="date" value={form.valid_until || ''} onChange={(e) => set('valid_until', e.target.value)} /></label>
          <label>Payment due after (days)<input required type="number" min="0" max="365" value={form.due_days} onChange={(e) => set('due_days', e.target.value)} /></label>
        </div>

        <div className="lines">
          {form.line_items.map((line: any, index: number) => (
            <div key={index}>
              <div className="quote-line">
                <select aria-label="Product" value={line.item_id || ''} onChange={(e) => chooseItem(index, e.target.value)}>
                  <option value="">Custom line</option>
                  {items.map((item) => <option key={item.id} value={item.id}>{item.sku} {item.name}</option>)}
                </select>
                <input required aria-label="Description" placeholder="Description" value={line.description} onChange={(e) => setLine(index, { description: e.target.value })} />
                <input required aria-label="Quantity" type="number" min={line.item_id ? '1' : '0.01'} step={line.item_id ? '1' : '0.01'} value={line.quantity} onChange={(e) => setLine(index, { quantity: e.target.value })} />
                <input required aria-label="Unit price" placeholder="Price" type="number" min="0" step="0.01" value={line.unit_price} onChange={(e) => setLine(index, { unit_price: e.target.value })} />
                <input aria-label="Discount percent" placeholder="%" type="number" min="0" max="100" step="0.01" value={line.discount} onChange={(e) => setLine(index, { discount: e.target.value })} />
                <select aria-label="Tax" value={line.tax_rate_id || ''} onChange={(e) => setLine(index, { tax_rate_id: e.target.value })}>
                  <option value="">No tax</option>
                  {taxRates.filter((rate) => rate.is_active || rate.id === line.tax_rate_id).map((rate) => <option key={rate.id} value={rate.id}>{rate.name}</option>)}
                </select>
                <button type="button" aria-label="Remove line" disabled={form.line_items.length === 1} onClick={() => set('line_items', form.line_items.filter((_: any, i: number) => i !== index))}>×</button>
              </div>
              {short(line) && <p className="late">Only {short(line).quantity} in stock. The invoice can't be posted until stock is added.</p>}
            </div>
          ))}
        </div>
        <button type="button" onClick={() => set('line_items', [...form.line_items, blankLine])}>Add line</button>
        <p>Subtotal {money(subtotal)} · Tax {money(tax)} · Total: <strong>{money(subtotal + tax)}</strong></p>
        <label>Notes for the customer<textarea rows={2} value={form.notes || ''} onChange={(e) => set('notes', e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
