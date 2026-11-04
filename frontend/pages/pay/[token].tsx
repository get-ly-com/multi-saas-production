import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { formatDate, money } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;
const TOKEN = /^[0-9a-f]{64}$/;

// Only a 429 means too many tries; anything else without a message is a general failure
const failure = (status: number, result: any) =>
  result?.error || (status === 429 ? 'Too many tries. Please wait a minute and try again.' : 'Something went wrong. Please try again.');

// Public: a customer opens this from the link on their invoice. It must not touch sign-in or the company choice.
export default function PayInvoice() {
  const router = useRouter();
  const token = typeof router.query.token === 'string' ? router.query.token : '';
  const paid = router.query.paid === '1';
  const cancelled = router.query.cancelled === '1';
  const [info, setInfo] = useState<any>(null);
  const [missing, setMissing] = useState('');
  const [error, setError] = useState('');
  const [checks, setChecks] = useState(0);

  const load = async () => {
    try {
      const response = await fetch(`${BASE_URL}/api/pay/${token}`, { cache: 'no-store' });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        setMissing(response.status === 404 ? 'This payment link is not available.' : failure(response.status, result));
        return;
      }
      setInfo(result);
      setMissing('');
    } catch {
      setMissing('Something went wrong. Please try again.');
    }
  };

  useEffect(() => {
    if (!router.isReady) return;
    if (!TOKEN.test(token)) {
      setMissing('This payment link is not available.');
      return;
    }
    load();
  }, [router.isReady, token]);

  // Back from Stripe: the payment shows on the invoice a moment later, so check a few times
  useEffect(() => {
    if (!paid || !info || info.status !== 'open' || checks >= 10) return;
    const timer = window.setTimeout(() => {
      setChecks((count) => count + 1);
      load();
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [paid, info, checks]);

  const { busy, run } = useSubmit();
  const pay = () => run(async () => {
    setError('');
    try {
      const response = await fetch(`${BASE_URL}/api/pay/${token}`, { method: 'POST' });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.url) throw new Error(failure(response.status, result));
      window.location.assign(result.url);
    } catch (err: any) {
      setError(err.message);
    }
  });

  const title = info ? `Pay invoice ${info.invoice_number}` : 'Pay invoice';

  return (
    <div className="public-form">
      <Head><title>{info ? `${title} | ${info.company}` : title}</title><meta name="robots" content="noindex" /></Head>
      {missing && <p className="empty">{missing}</p>}
      {!missing && !info && <p className="empty">Loading…</p>}

      {info && (
        <div className="card stack">
          <div>
            <div className="muted">{info.company}</div>
            <h1>Invoice {info.invoice_number}</h1>
            {info.customer_name && <div className="muted">For {info.customer_name}</div>}
            {info.due_date && <div className="muted">Due {formatDate(info.due_date)}</div>}
          </div>

          {info.status === 'paid' && (
            <p>{paid ? 'Thank you. Your payment went through and this invoice is now paid.' : 'This invoice is paid. Thank you.'}</p>
          )}
          {info.status === 'void' && <p>This invoice was cancelled, so there is nothing to pay.</p>}
          {info.status === 'closed' && <p>This invoice can’t be paid online. Please contact {info.company}.</p>}

          {info.status === 'open' && paid && (
            <p>
              Thank you. Your payment went through.{' '}
              {checks < 10 ? 'We are adding it to the invoice now.' : 'It will show on the invoice shortly. You don’t need to pay again.'}
            </p>
          )}

          {info.status === 'open' && !paid && (
            <>
              <div className="document-totals">
                {Number(info.balance) !== Number(info.amount) && (
                  <div><span>Invoice total</span><span>{money(info.amount, info.currency)}</span></div>
                )}
                <div className="due"><span>Amount due</span><span>{money(info.balance, info.currency)}</span></div>
              </div>
              {cancelled && <p className="muted">You left the payment page before paying. You have not been charged.</p>}
              {info.ready ? (
                <div>
                  <button className="primary" disabled={busy} onClick={pay}>Pay now</button>
                  <p className="muted">You will pay by card on a secure page from Stripe, then come back here.</p>
                </div>
              ) : (
                <p>Online payments aren’t set up yet. Please contact {info.company} to pay.</p>
              )}
              {error && <p className="error">{error}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
