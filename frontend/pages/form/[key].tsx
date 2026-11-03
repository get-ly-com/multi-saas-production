import Head from 'next/head';
import { useRouter } from 'next/router';
import { FormEvent, useEffect, useState } from 'react';
import { campaignFromUrl } from '@/lib/campaign';

const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

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

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const response = await fetch(`${BASE_URL}/api/forms/${encodeURIComponent(key as string)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, campaign: campaignFromUrl() })
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || 'Too many tries. Please wait a minute and try again.');
      setThanks(result.thanks);
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="public-form">
      <Head><title>{company ? `Contact ${company}` : 'Contact us'}</title></Head>
      {closed && <p className="empty">This form is not available.</p>}
      {thanks && <p>{thanks}</p>}
      {company && !thanks && (
        <form onSubmit={submit} className="stack">
          <h1>Contact {company}</h1>
          <label>Your name<input required maxLength={200} value={form.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label>Email<input type="email" maxLength={254} value={form.email} onChange={(e) => set('email', e.target.value)} /></label>
          <label>Phone<input maxLength={40} value={form.phone} onChange={(e) => set('phone', e.target.value)} /></label>
          <label>Company<input maxLength={200} value={form.company} onChange={(e) => set('company', e.target.value)} /></label>
          <label>How can we help?<textarea rows={4} maxLength={2000} value={form.message} onChange={(e) => set('message', e.target.value)} /></label>
          <label className="trap" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={form.website} onChange={(e) => set('website', e.target.value)} /></label>
          {error && <p className="error">{error}</p>}
          <div><button className="primary">Send</button></div>
        </form>
      )}
    </div>
  );
}
