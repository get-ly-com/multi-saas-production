// Light, dark or follow the system. The choice is kept in this browser only.
// pages/_document.tsx runs THEME_SCRIPT before the page paints, so there is no flash.

export type ThemePref = 'light' | 'dark' | 'system';

const KEY = 'getly:theme';

// Browser bar colours, matching --bg in globals.css
export const THEME_COLOURS = { light: '#f7f7f9', dark: '#0f0f13' };

export const getThemePref = (): ThemePref => {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
};

const systemDark = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;

export const resolveTheme = (pref: ThemePref): 'light' | 'dark' => (pref === 'system' ? (systemDark() ? 'dark' : 'light') : pref);

export const applyTheme = (pref: ThemePref) => {
  const theme = resolveTheme(pref);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.setAttribute('content', THEME_COLOURS[theme]));
};

const listeners = new Set<(pref: ThemePref) => void>();

export const setThemePref = (pref: ThemePref) => {
  try {
    if (pref === 'system') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, pref);
  } catch {
    // The choice then lasts until the page reloads
  }
  applyTheme(pref);
  listeners.forEach((listener) => listener(pref));
};

export const onThemeChange = (listener: (pref: ThemePref) => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

// Follow the system when it changes, but only while the choice is "system"
let watching = false;
export const watchSystemTheme = () => {
  if (watching || typeof window === 'undefined' || !window.matchMedia) return;
  watching = true;
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (getThemePref() === 'system') applyTheme('system');
  });
};

// Inline, tiny and dependency free. Keep in step with applyTheme above.
export const THEME_SCRIPT = `(function(){try{var p=localStorage.getItem('${KEY}');var d=p==='dark'||(p!=='light'&&window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches);var t=d?'dark':'light';var r=document.documentElement;r.dataset.theme=t;r.style.colorScheme=t;var m=document.querySelectorAll('meta[name="theme-color"]');for(var i=0;i<m.length;i++)m[i].setAttribute('content',d?'${THEME_COLOURS.dark}':'${THEME_COLOURS.light}');}catch(e){}})();`;
