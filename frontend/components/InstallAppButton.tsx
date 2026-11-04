import { useEffect, useState } from 'react';

// Chrome and Edge offer to install the site as an app. The offer can come before the
// account bar is drawn, so it's caught once for the whole app and kept here.
type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

let saved: InstallPrompt | null = null;
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((listener) => listener());
let watching = false;

export function watchInstallPrompt() {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    saved = event as InstallPrompt;
    tell();
  });
  window.addEventListener('appinstalled', () => {
    saved = null;
    tell();
  });
}

export default function InstallAppButton() {
  const [offer, setOffer] = useState<InstallPrompt | null>(saved);

  useEffect(() => {
    watchInstallPrompt();
    const update = () => setOffer(saved);
    listeners.add(update);
    update();
    return () => { listeners.delete(update); };
  }, []);

  if (!offer) return null;

  const install = async () => {
    await offer.prompt();
    await offer.userChoice.catch(() => null);
    // The offer can only be used once
    saved = null;
    tell();
  };

  return <button className="link always" onClick={install} title="Add Get-ly to your home screen or desktop">Install app</button>;
}
