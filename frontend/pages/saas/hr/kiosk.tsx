import Link from 'next/link';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { hoursText, timeOf, timeZone } from '@/components/HrWork';
import Icon from '@/components/Icon';
import { toast } from '@/components/Toast';
import { api } from '@/lib/api';
import { getSupabase } from '@/lib/supabase';
import styles from '@/styles/hr.module.css';

// A shared clock-in screen for a tablet by the door. Sign the tablet in once with an owner or admin,
// or with the kiosk sign-in chosen in HR settings; staff then use their employee number and PIN.
// It has no app menu, so people at the kiosk can't wander into the rest of the app.
export default function Kiosk() {
  const [ready, setReady] = useState<boolean | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const [number, setNumber] = useState('');
  const [pin, setPin] = useState('');
  const [step, setStep] = useState<'number' | 'pin'>('number');
  const [message, setMessage] = useState<{ text: string; good: boolean } | null>(null);
  // A clock in or out that just worked: a big tick, the name and the time
  const [done, setDone] = useState<{ in: boolean; name: string; at: string; hours: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    getSupabase().auth.getSession().then(({ data }) => setReady(Boolean(data.session)));
    setNow(new Date());
    const tick = setInterval(() => setNow(new Date()), 1000);
    return () => {
      clearInterval(tick);
      clearTimeout(reset.current);
    };
  }, []);

  const clear = (after: number) => {
    clearTimeout(reset.current);
    reset.current = setTimeout(() => {
      setNumber('');
      setPin('');
      setStep('number');
      setMessage(null);
      setDone(null);
    }, after);
  };

  const press = (key: string) => {
    setMessage(null);
    const value = step === 'number' ? number : pin;
    const next = key === 'back' ? value.slice(0, -1) : (value + key).slice(0, step === 'number' ? 9 : 8);
    if (step === 'number') setNumber(next);
    else setPin(next);
    clear(30000);
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (step === 'number') {
      if (number) setStep('pin');
      return;
    }
    if (pin.length < 4 || busy) return;
    setBusy(true);
    try {
      const result = await api.post('/api/hr/attendance/kiosk', { employee_number: Number(number), pin, tz: timeZone() });
      const clockedIn = result.status === 'in';
      setDone({ in: clockedIn, name: result.name, at: timeOf(result.at), hours: hoursText(result.hours_today) });
      setMessage(clockedIn
        ? { text: `Hello ${result.name}. You clocked in at ${timeOf(result.at)}.`, good: true }
        : { text: `Bye ${result.name}. You clocked out at ${timeOf(result.at)}, ${hoursText(result.hours_today)} today.`, good: true });
      toast.success(clockedIn ? `${result.name} clocked in` : `${result.name} clocked out`, {
        detail: clockedIn ? `At ${timeOf(result.at)}` : `At ${timeOf(result.at)}, ${hoursText(result.hours_today)} today`
      });
      clear(5000);
    } catch (err: any) {
      setMessage({ text: err.message, good: false });
      setPin('');
      clear(8000);
    } finally {
      setBusy(false);
    }
  };

  if (ready === false) {
    return (
      <div className="auth">
        <div className="card">
          <h1>Clock-in kiosk</h1>
          <p>Sign this device in first, with an owner or admin, or with the kiosk sign-in chosen in HR settings.</p>
          <Link href="/login">Sign in</Link>
        </div>
      </div>
    );
  }

  const value = step === 'number' ? number : '•'.repeat(pin.length);

  return (
    <div className="kiosk">
      <div className="kiosk-clock">{now ? now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : ''}</div>
      <div className="kiosk-date muted">{now ? now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) : ''}</div>
      {done ? (
        <div className={`${styles.kioskDone} ${done.in ? '' : styles.isOut}`} role="status" aria-live="assertive">
          <span className={styles.kioskTick}><Icon name={done.in ? 'check' : 'logout'} size={38} strokeWidth={2.5} /></span>
          <div className={styles.kioskName}>{done.in ? `Hello ${done.name}` : `Bye ${done.name}`}</div>
          <div className={styles.kioskTime}>{done.at}</div>
          <div>{done.in ? 'You are clocked in. Have a good day.' : `You are clocked out. ${done.hours} today.`}</div>
          <button type="button" className={`always ${styles.kioskBig}`} style={{ marginTop: 12, width: '100%' }}
            onClick={() => { clearTimeout(reset.current); setNumber(''); setPin(''); setStep('number'); setMessage(null); setDone(null); }}>Next person</button>
        </div>
      ) : (
      <form className="card kiosk-pad" onSubmit={submit}>
        <label htmlFor="kiosk-value">{step === 'number' ? 'Your employee number' : 'Your PIN'}</label>
        <input id="kiosk-value" className="kiosk-value" readOnly value={value} aria-live="polite" autoFocus
          onKeyDown={(e) => {
            if (/^\d$/.test(e.key)) press(e.key);
            else if (e.key === 'Backspace') press('back');
          }} />
        <div className="kiosk-keys">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((key) => (
            <button type="button" key={key} className="always" onClick={() => press(key)}>{key}</button>
          ))}
          <button type="button" className="always" onClick={() => press('back')} aria-label="Delete">⌫</button>
          <button type="button" className="always" onClick={() => press('0')}>0</button>
          <button className="primary always" disabled={busy || (step === 'number' ? !number : pin.length < 4)}>{busy ? '…' : step === 'number' ? 'Next' : 'OK'}</button>
        </div>
        {step === 'pin' && (
          <button type="button" className="always" onClick={() => { setStep('number'); setPin(''); }}>Not you? Start again</button>
        )}
        {message && !message.good && <p className="error kiosk-message" role="status">{message.text}</p>}
      </form>
      )}
      <p className="muted kiosk-foot">Forgot your PIN? Set a new one on the Attendance page, or ask your manager. <Link href="/saas/hr/attendance">Leave the kiosk</Link></p>
    </div>
  );
}
