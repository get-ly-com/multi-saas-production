import Link from 'next/link';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { hoursText, timeOf, timeZone } from '@/components/HrWork';
import { api } from '@/lib/api';
import { getSupabase } from '@/lib/supabase';

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
      setMessage(result.status === 'in'
        ? { text: `Hello ${result.name}. You clocked in at ${timeOf(result.at)}.`, good: true }
        : { text: `Bye ${result.name}. You clocked out at ${timeOf(result.at)}, ${hoursText(result.hours_today)} today.`, good: true });
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
          <button className="primary always" disabled={busy || (step === 'number' ? !number : pin.length < 4)}>{step === 'number' ? 'Next' : 'OK'}</button>
        </div>
        {step === 'pin' && (
          <button type="button" className="always" onClick={() => { setStep('number'); setPin(''); }}>Not you? Start again</button>
        )}
        {message && <p className={message.good ? 'notice kiosk-message' : 'error kiosk-message'} role="status">{message.text}</p>}
      </form>
      <p className="muted kiosk-foot">Forgot your PIN? Set a new one on the Attendance page, or ask your manager. <Link href="/saas/hr/attendance">Leave the kiosk</Link></p>
    </div>
  );
}
