import type { AppProps } from 'next/app';
import { Instrument_Sans } from 'next/font/google';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { watchInstallPrompt } from '@/components/InstallAppButton';
import { ToastProvider } from '@/components/Toast';
import { watchSystemTheme } from '@/lib/theme';
import '@/styles/globals.css';

// Self-hosted by Next at build time, so no request goes to Google from the browser
const sans = Instrument_Sans({ subsets: ['latin'], display: 'swap', variable: '--font-sans' });

// A thin line at the top while a page takes more than a moment to arrive.
// Fast pages never show it, so moving around feels instant.
function RouteProgress() {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'loading' | 'done'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const start = (url: string, { shallow }: { shallow: boolean }) => {
      if (shallow) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState('loading'), 120);
    };
    const end = () => {
      clearTimeout(timer.current);
      setState((now) => (now === 'loading' ? 'done' : 'idle'));
      timer.current = setTimeout(() => setState('idle'), 260);
    };
    router.events.on('routeChangeStart', start);
    router.events.on('routeChangeComplete', end);
    router.events.on('routeChangeError', end);
    return () => {
      router.events.off('routeChangeStart', start);
      router.events.off('routeChangeComplete', end);
      router.events.off('routeChangeError', end);
    };
  }, []);

  return <div className={`route-progress is-${state}`} aria-hidden="true" />;
}

export default function App({ Component, pageProps }: AppProps) {
  useEffect(() => {
    watchInstallPrompt();
    watchSystemTheme();
    // Only the live site gets the offline cache; in development it would hide code changes
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    }
  }, []);

  return (
    <>
      <Head>
        <title>Get-ly</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      </Head>
      <style jsx global>{`
        :root { --font-sans: ${sans.style.fontFamily}; }
      `}</style>
      <RouteProgress />
      <Component {...pageProps} />
      <ToastProvider />
    </>
  );
}
