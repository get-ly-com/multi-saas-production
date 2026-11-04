import { KeyboardEvent, RefObject, useEffect } from 'react';

// Small helpers shared by the shell, menus, the drawer and the command palette

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Keeps Tab inside a dialog. Call from the dialog's onKeyDown.
export const trapTab = (event: KeyboardEvent<HTMLElement>, box: HTMLElement | null) => {
  if (event.key !== 'Tab' || !box) return;
  const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((item) => item.offsetParent !== null || item === document.activeElement);
  if (!items.length) {
    event.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === box)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
};

// Focus goes into the dialog when it opens and back where it was when it closes
export const useReturnFocus = (open: boolean, box: RefObject<HTMLElement>, first?: RefObject<HTMLElement>) => {
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const target = first?.current || box.current;
    if (target && !box.current?.contains(document.activeElement)) target.focus();
    return () => {
      if (before && document.contains(before)) before.focus();
    };
  }, [open]);
};

// A click outside or Escape closes a menu
export const useDismiss = (open: boolean, box: RefObject<HTMLElement>, close: () => void) => {
  useEffect(() => {
    if (!open) return;
    const click = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) close();
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', click);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', click);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
};

// Stops the page behind a dialog from scrolling. Counts, so two dialogs don't fight.
let locks = 0;
export const useScrollLock = (open: boolean) => {
  useEffect(() => {
    if (!open) return;
    locks += 1;
    document.documentElement.classList.add('is-locked');
    return () => {
      locks -= 1;
      if (!locks) document.documentElement.classList.remove('is-locked');
    };
  }, [open]);
};

export const isTyping = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable;
};

export const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// Safe localStorage. Private windows and blocked storage just forget.
export const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const value = window.localStorage.getItem(key);
      return value === null ? fallback : (JSON.parse(value) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Forgotten on reload, which is fine
    }
  },
  remove(key: string) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Nothing to do
    }
  }
};
