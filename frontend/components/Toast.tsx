import { useEffect, useRef, useState } from 'react';
import Icon from '@/components/Icon';

// Small notes in the bottom right corner. Call from anywhere, no hook needed:
//   toast.success('Saved', { detail: 'Invoice INV-104 is ready to send' })
//   toast.error('Could not save', { detail: err.message })
//   toast.info('Moved to archive', { action: { label: 'Undo', onClick: restore } })
// <ToastProvider /> is mounted once in pages/_app.tsx.

type Tone = 'success' | 'error' | 'info';
type Action = { label: string; onClick: () => void };
type Options = { detail?: string; action?: Action; duration?: number };
type Item = Options & { id: number; tone: Tone; title: string; leaving?: boolean };

const MAX_SHOWN = 4;
let nextId = 1;
let items: Item[] = [];
const listeners = new Set<(list: Item[]) => void>();
const publish = () => listeners.forEach((listener) => listener(items));

const show = (tone: Tone, title: string, options: Options = {}) => {
  const id = nextId++;
  items = [...items, { id, tone, title, ...options }].slice(-MAX_SHOWN);
  publish();
  return id;
};

const dismiss = (id: number) => {
  // Mark it leaving first so it can animate out
  items = items.map((item) => (item.id === id ? { ...item, leaving: true } : item));
  publish();
  setTimeout(() => {
    items = items.filter((item) => item.id !== id);
    publish();
  }, 180);
};

export const toast = {
  success: (title: string, options?: Options) => show('success', title, options),
  error: (title: string, options?: Options) => show('error', title, options),
  info: (title: string, options?: Options) => show('info', title, options),
  dismiss
};

const ICONS: Record<Tone, string> = { success: 'paid', error: 'error', info: 'info' };

function ToastCard({ item }: { item: Item }) {
  // Errors and toasts with an action stay a little longer, so there is time to read or undo
  const duration = item.duration ?? (item.tone === 'error' || item.action ? 7000 : 4500);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const start = () => {
    clearTimeout(timer.current);
    if (duration > 0) timer.current = setTimeout(() => dismiss(item.id), duration);
  };
  useEffect(() => {
    start();
    return () => clearTimeout(timer.current);
  }, []);

  return (
    <div
      className={`toast toast-${item.tone} ${item.leaving ? 'is-leaving' : ''}`}
      role={item.tone === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => clearTimeout(timer.current)}
      onMouseLeave={start}
      onFocus={() => clearTimeout(timer.current)}
      onBlur={start}
    >
      <Icon name={ICONS[item.tone]} className="toast-icon" size={18} />
      <div className="toast-text">
        <strong>{item.title}</strong>
        {item.detail && <span>{item.detail}</span>}
      </div>
      {item.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            item.action?.onClick();
            dismiss(item.id);
          }}
        >
          {item.action.label}
        </button>
      )}
      <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(item.id)}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

export function ToastProvider() {
  const [list, setList] = useState<Item[]>(items);
  useEffect(() => {
    listeners.add(setList);
    return () => { listeners.delete(setList); };
  }, []);

  return (
    <div className="toaster" aria-live="polite" aria-relevant="additions">
      {list.map((item) => <ToastCard key={item.id} item={item} />)}
    </div>
  );
}
