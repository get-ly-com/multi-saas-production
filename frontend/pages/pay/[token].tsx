import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { celebrate } from '@/components/Celebrate';
import Icon from '@/components/Icon';
import Skeleton from '@/components/Skeleton';
import { formatDate, money } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';
import p from '@/styles/public.module.css';

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

  const settled = info && (info.status === 'paid' || (info.status === 'open' && paid));

  // Back from a successful payment: one gentle burst, once
  const cheered = useRef(false);
  const tick = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!paid || !settled || cheered.current) return;
    cheered.current = true;
    setTimeout(() => celebrate({ from: tick.current, pieces: 60 }), 260);
  }, [paid, settled]);

  return (
    <div className={p.page}>
      <Head><title>{info ? `${title} | ${info.company}` : title}</title><meta name="robots" content="noindex" /></Head>
      <div className={p.narrow}>
        {missing && (
          <div className={`${p.panel} ${p.message}`}>
            <div className="empty-state is-compact">
              <div className="empty-art" aria-hidden="true"><span className="empty-ring" /><Icon name="invoice" size={20} /></div>
              <h3>{missing}</h3>
              <p>If you think this is a mistake, please contact the company that sent you the link.</p>
            </div>
          </div>
        )}

        {!missing && !info && (
          <div className={p.panel} role="status" aria-label="Loading">
            <div className={p.payHead}><Skeleton width="40%" height={12} /><Skeleton width="60%" height={44} /></div>
            <div className={p.payBody}><Skeleton height={14} /><Skeleton height={14} width="70%" /><Skeleton height={48} radius={12} /></div>
          </div>
        )}

        {info && (
          <>
            <div className={p.brand}>
              <div className={p.logo} aria-hidden="true">{(info.company || '?').trim().charAt(0).toUpperCase()}</div>
              <div>
                <div className={p.brandName}>{info.company}</div>
                <div className={p.brandLine}>Invoice {info.invoice_number}</div>
              </div>
            </div>

            <div className={p.panel}>
              {settled ? (
                <div className={p.done}>
                  <div className={p.tick} ref={tick} aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></div>
                  <h1>{info.status === 'paid' ? (paid ? 'Payment received' : 'This invoice is paid') : 'Payment received'}</h1>
                  <p>
                    {info.status === 'paid'
                      ? (paid ? 'Thank you. Your payment went through and this invoice is now paid.' : 'Nothing more to do. Thank you.')
                      : checks < 10
                        ? 'Thank you. Your payment went through. We are adding it to the invoice now.'
                        : 'Thank you. Your payment went through. It will show on the invoice shortly. You don’t need to pay again.'}
                  </p>
                  <dl className={p.summary}>
                    <div><dt>Invoice</dt><dd>{info.invoice_number}</dd></div>
                    <div><dt>From</dt><dd>{info.company}</dd></div>
                    {info.customer_name && <div><dt>For</dt><dd>{info.customer_name}</dd></div>}
                    <div><dt>Total</dt><dd className="num">{money(info.amount, info.currency)}</dd></div>
                  </dl>
                </div>
              ) : (
                <>
                  <div className={p.payHead}>
                    <span className={p.payLabel}>{info.status === 'open' ? 'Amount due' : 'Invoice total'}</span>
                    <span className={p.amount}>{money(info.status === 'open' ? info.balance : info.amount, info.currency)}</span>
                    {info.due_date && info.status === 'open' && <span className="muted">Due {formatDate(info.due_date)}</span>}
                  </div>
                  <div className={p.payBody}>
                    <dl className={p.payRows}>
                      <div><dt>Invoice</dt><dd>{info.invoice_number}</dd></div>
                      {info.customer_name && <div><dt>Billed to</dt><dd>{info.customer_name}</dd></div>}
                      {info.due_date && <div><dt>Due date</dt><dd>{formatDate(info.due_date)}</dd></div>}
                      {Number(info.balance) !== Number(info.amount) && (
                        <>
                          <div><dt>Invoice total</dt><dd>{money(info.amount, info.currency)}</dd></div>
                          <div><dt>Already paid</dt><dd>{money(Number(info.amount) - Number(info.balance), info.currency)}</dd></div>
                        </>
                      )}
                    </dl>

                    {info.status === 'void' && <p className="muted" style={{ margin: 0 }}>This invoice was cancelled, so there is nothing to pay.</p>}
                    {info.status === 'closed' && <p className="muted" style={{ margin: 0 }}>This invoice can’t be paid online. Please contact {info.company}.</p>}

                    {info.status === 'open' && (
                      <>
                        {cancelled && <p className="notice" style={{ margin: 0 }}>You left the payment page before paying. You have not been charged.</p>}
                        {info.ready ? (
                          <>
                            <button className={`primary ${p.payButton}`} disabled={busy} onClick={pay}>
                              {busy ? 'Opening the payment page…' : `Pay ${money(info.balance, info.currency)} now`}
                            </button>
                            <div className={p.secure}>
                              <Icon name="paid" size={16} />
                              <span>You&apos;ll pay by card on a secure page from Stripe, then come back here. {info.company} never sees your card details.</span>
                            </div>
                          </>
                        ) : (
                          <p className="muted" style={{ margin: 0 }}>Online payments aren’t set up yet. Please contact {info.company} to pay.</p>
                        )}
                        {error && <p className="error">{error}</p>}
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
            <p className={p.foot}>Payment link from {info.company}</p>
          </>
        )}
      </div>
    </div>
  );
}
