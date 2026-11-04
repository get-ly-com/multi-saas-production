import Head from 'next/head';
import { useRouter } from 'next/router';
import { FormEvent, useEffect, useState } from 'react';
import Icon from '@/components/Icon';
import Skeleton from '@/components/Skeleton';
import { campaignFromUrl } from '@/lib/campaign';
import useSubmit from '@/lib/useSubmit';
import p from '@/styles/public.module.css';

const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

// Only a 429 means too many tries; anything else without a message is a general failure
const failure = (status: number, result: any) =>
  result?.error || (status === 429 ? 'Too many tries. Please wait a minute and try again.' : 'Something went wrong. Please try again.');

// Public, so it can sit on a customer's own website. It must not touch sign-in or the company choice.
export default function PublicForm() {
  const router = useRouter();
  const key = router.query.key as string | undefined;
  const [company, setCompany] = useState('');
  const [form, setForm] = useState({ name: '', email: '', phone: '', company: '', message: '', website: '' });
  const [thanks, setThanks] = useState('');
  const [error, setError] = useState('');
  const [closed, setClosed] = useState(false);
  const set = (field: string, value: string) => setForm({ ...form, [field]: value });

  useEffect(() => {
    if (!key) return;
    fetch(`${BASE_URL}/api/forms/${encodeURIComponent(key)}`)
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((info) => setCompany(info.company))
      .catch(() => setClosed(true));
  }, [key]);

  const { busy, run } = useSubmit();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      setError('');
      try {
        const response = await fetch(`${BASE_URL}/api/forms/${encodeURIComponent(key as string)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...form, campaign: campaignFromUrl() })
        });
        const result = await response.json().catch(() => null);
        if (!response.ok) throw new Error(failure(response.status, result));
        setThanks(result?.thanks || 'Thanks, we got your message and will be in touch soon.');
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <div className={p.page}>
      <Head><title>{company ? `Contact ${company}` : 'Contact us'}</title></Head>
      <div className={p.narrow}>
        {closed && (
          <div className={`${p.panel} ${p.message}`}>
            <div className="empty-state is-compact">
              <div className="empty-art" aria-hidden="true"><span className="empty-ring" /><Icon name="chat" size={20} /></div>
              <h3>This form is not available</h3>
              <p>The link may have changed. Please get in touch another way.</p>
            </div>
          </div>
        )}

        {!closed && !company && (
          <div className={p.panel} role="status" aria-label="Loading">
            <div className={p.formHead}><Skeleton width="55%" height={26} /><Skeleton width="80%" /></div>
            <div className={p.formBody} style={{ display: 'grid', gap: 14 }}>
              {[0, 1, 2].map((n) => <Skeleton key={n} height={36} radius={8} />)}
              <Skeleton height={96} radius={8} />
            </div>
          </div>
        )}

        {thanks && (
          <div className={p.panel}>
            <div className={p.done}>
              <div className={p.tick} aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></div>
              <h1>Message sent</h1>
              <p style={{ whiteSpace: 'pre-wrap' }}>{thanks}</p>
            </div>
          </div>
        )}

        {company && !thanks && (
          <div className={p.panel}>
            <div className={p.formHead}>
              <div className={p.brand} style={{ margin: 0 }}>
                <div className={p.logo} aria-hidden="true">{company.trim().charAt(0).toUpperCase()}</div>
                <div className={p.brandName}>{company}</div>
              </div>
              <h1 style={{ marginTop: 12 }}>Get in touch</h1>
              <p>Leave a message and {company} will get back to you.</p>
            </div>
            <form onSubmit={submit} className={p.formBody} style={{ display: 'grid', gap: 14 }}>
              <label>Your name<input required maxLength={200} autoComplete="name" value={form.name} onChange={(e) => set('name', e.target.value)} /></label>
              <div className="form-grid">
                <label>Email<input type="email" maxLength={254} autoComplete="email" value={form.email} onChange={(e) => set('email', e.target.value)} /></label>
                <label>Phone<input maxLength={40} autoComplete="tel" inputMode="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} /></label>
              </div>
              <label>Company<input maxLength={200} autoComplete="organization" value={form.company} onChange={(e) => set('company', e.target.value)} /></label>
              <label>How can we help?<textarea rows={4} maxLength={2000} value={form.message} onChange={(e) => set('message', e.target.value)} /></label>
              <label className="trap" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={form.website} onChange={(e) => set('website', e.target.value)} /></label>
              {error && <p className="error">{error}</p>}
              <button disabled={busy} className={`primary ${p.payButton}`}>{busy ? 'Sending…' : 'Send message'}</button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
