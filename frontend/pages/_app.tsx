import type { AppProps } from 'next/app';
import Head from 'next/head';
import { useEffect } from 'react';
import { watchInstallPrompt } from '@/components/InstallAppButton';
import '@/styles/globals.css';

export default function App({ Component, pageProps }: AppProps) {
  useEffect(() => {
    watchInstallPrompt();
    // Only the live site gets the offline cache; in development it would hide code changes
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    }
  }, []);

  return (
    <>
      <Head>
        <title>Get-ly</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <Component {...pageProps} />
    </>
  );
}
