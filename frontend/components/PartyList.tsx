import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import { Amount, DrawerHero, Facts, PageHead, StatusPill, rowOpener, styles } from '@/components/AccountingKit';
import AccountingNav from '@/components/AccountingNav';
import { useAccount } from '@/components/AppShell';
import Drawer from '@/components/Drawer';
import EmptyState from '@/components/EmptyState';
import Modal from '@/components/Modal';
import { SkeletonTable } from '@/components/Skeleton';
import { toast } from '@/components/Toast';
import { api } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

const blank = { name: '', email: '', phone: '', address: '' };

type Props = { title: string; noun: string; path: string; balanceLabel: string; statementPath?: string };

const settled = (value: unknown) => Math.round(Number(value || 0) * 100) === 0;

export default function PartyList({ title, noun, path, balanceLabel, statementPath }: Props) {
  const account = useAccount();
  const canEdit = account?.canEdit !== false;
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState<any>(null);
  const [openId, setOpenId] = useState('');
  const isCustomer = noun === 'customer';
  const documents = isCustomer ? 'invoices' : 'bills';

  const load = async () => {
    try {
      setRows(await api.get(path));
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
  const setActive = (row: any, is_active: boolean, undoing = false): Promise<unknown> => once(async () => {
    try {
      await api.put(`${path}/${row.id}`, { is_active });
      await load();
      if (undoing) {
        toast.info(is_active ? `${row.name} is active again` : `${row.name} is inactive again`);
      } else {
        toast.success(is_active ? `${row.name} reactivated` : `${row.name} deactivated`, {
          detail: is_active ? `You can pick them on new ${documents} again.` : `Their history stays. They just drop out of new ${documents}.`,
          action: { label: 'Undo', onClick: () => { setActive(row, !is_active, true); } }
        });
      }
    } catch (err: any) {
      setError(err.message);
    }
  });

  const edit = (row: any) => setForm({ ...row, email: row.email || '', phone: row.phone || '', address: row.address || '' });
  const open = rows.find((row) => row.id === openId);
  const owing = rows.filter((row) => !settled(row.balance));
  const total = rows.reduce((sum, row) => sum + Number(row.balance || 0), 0);

  return (
    <div className="stack">
      <AccountingNav />
      <PageHead
        title={title}
        line={rows.length > 0 ? (isCustomer ? `${owing.length} of ${rows.length} owe you money` : `You owe ${owing.length} of ${rows.length}`) : undefined}
      >
        <button className="primary" onClick={() => setForm(blank)}>New {noun}</button>
      </PageHead>

      {error && <p className="error">{error}</p>}

      {loading ? <SkeletonTable rows={6} columns={4} /> : rows.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="contact"
            title={`No ${noun}s yet`}
            line={isCustomer ? 'Add the people and companies you bill. Their balance and statement live here.' : 'Add the suppliers who send you bills, so you always know what you owe.'}
            action={canEdit ? { label: `Add a ${noun}`, onClick: () => setForm(blank) } : undefined}
          />
        </div>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Email</th><th>Phone</th><th className="num">{balanceLabel}</th></tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} {...rowOpener(() => setOpenId(row.id))}>
                  <td className="wrap">
                    <button type="button" className={`${styles.rowTitle} always`} onClick={() => setOpenId(row.id)}>{row.name}</button>
                    {!row.is_active && <> <StatusPill status="inactive" /></>}
                  </td>
                  <td>{row.email || <span className="muted">None</span>}</td>
                  <td>{row.phone || <span className="muted">None</span>}</td>
                  <td className="num"><Amount value={row.balance} dim={settled(row.balance)} /></td>
                </tr>
              ))}
              <tr className={styles.totalRow}>
                <td colSpan={3}>Total</td>
                <td className="num"><Amount value={total} strong /></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <Drawer
        open={Boolean(open)}
        title={open?.name}
        subtitle={open ? (open.is_active ? (isCustomer ? 'Customer' : 'Vendor') : `Inactive ${noun}`) : undefined}
        onClose={() => setOpenId('')}
        footer={open && (
          <>
            {statementPath && <Link className="button" href={`${statementPath}?customer=${open.id}`}>Statement</Link>}
            {canEdit && <button disabled={busy} onClick={() => setActive(open, !open.is_active)}>{open.is_active ? 'Deactivate' : 'Reactivate'}</button>}
            {canEdit && <button className="primary" onClick={() => { setOpenId(''); edit(open); }}>Edit {noun}</button>}
          </>
        )}
      >
        {open && (
          <>
            <DrawerHero
              label={balanceLabel}
              value={<Amount value={open.balance} />}
              line={settled(open.balance) ? 'All settled.' : isCustomer ? 'Still to come in from open invoices.' : 'Still to pay on open bills.'}
              pill={!open.is_active ? <StatusPill status="inactive" /> : undefined}
            />
            <Facts items={[
              ['Email', open.email ? <a href={`mailto:${open.email}`}>{open.email}</a> : <span className="muted">Not saved</span>],
              ['Phone', open.phone || <span className="muted">Not saved</span>],
              ['Address', open.address ? <span style={{ whiteSpace: 'pre-wrap' }}>{open.address}</span> : <span className="muted">Not saved</span>]
            ]} />
            {statementPath && <p className="muted">Every invoice and payment for {open.name} is on their statement.</p>}
          </>
        )}
      </Drawer>

      {form && <PartyForm initial={form} noun={noun} path={path} onClose={() => setForm(null)} onSaved={load} />}
    </div>
  );
}

function PartyForm({ initial, noun, path, onClose, onSaved }: { initial: any; noun: string; path: string; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<any>(initial);
  const [error, setError] = useState('');
  const set = (field: string, value: string) => setForm({ ...form, [field]: value });

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      const { name, email, phone, address } = form;
      const body = { name, email, phone, address };
      try {
        if (form.id) await api.put(`${path}/${form.id}`, body);
        else await api.post(path, body);
        toast.success(form.id ? 'Changes saved' : `${name} added`, { detail: form.id ? `${name} is up to date.` : `You can now pick them on ${noun === 'customer' ? 'invoices' : 'bills'}.` });
        await onSaved();
        onClose();
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <Modal title={form.id ? `Edit ${noun}` : `New ${noun}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Name<input required value={form.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label>Email<input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} /></label>
          <label>Phone<input value={form.phone} onChange={(e) => set('phone', e.target.value)} /></label>
        </div>
        <label style={{ marginTop: 12 }}>Address<textarea rows={2} value={form.address} onChange={(e) => set('address', e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button disabled={busy} className="primary">Save</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
