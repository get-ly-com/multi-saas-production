import { useRouter } from 'next/router';
import { useEffect, useRef } from 'react';
import { openPalette } from '@/components/CommandPalette';
import Modal from '@/components/Modal';
import { ALL_PRODUCTS, QUICK_ACTIONS } from '@/lib/nav';
import { isMac, isTyping } from '@/lib/ui';

// Single keys and two-key sequences ("g a"). They never fire while typing in a box,
// with a modifier held, or while a dialog is open.
const SEQUENCE_MS = 1200;

export function useShortcuts({ onHelp }: { onHelp: () => void }) {
  const router = useRouter();
  const pending = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

      const first = pending.current && Date.now() - pending.current.at < SEQUENCE_MS ? pending.current.key : null;
      pending.current = null;

      if (first === 'g') {
        const product = ALL_PRODUCTS.find(({ key2 }) => key2 === key);
        if (product) {
          event.preventDefault();
          router.push(product.path);
        }
        return;
      }
      if (first === 'n') {
        const action = QUICK_ACTIONS.find(({ keys }) => keys[1] === key);
        if (action) {
          event.preventDefault();
          router.push(action.path);
        }
        return;
      }

      if (event.key === '?') {
        event.preventDefault();
        onHelp();
      } else if (event.key === '/') {
        event.preventDefault();
        openPalette();
      } else if (key === 'g' || key === 'n') {
        pending.current = { key, at: Date.now() };
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onHelp]);
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="shortcut-keys">
      {keys.map((key, n) => (
        <span key={n}>
          {n > 0 && <span className="muted"> then </span>}
          <kbd className="kbd">{key}</kbd>
        </span>
      ))}
    </span>
  );
}

export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  const mod = isMac() ? '⌘' : 'Ctrl';
  const general: [string[], string][] = [
    [[`${mod} K`], 'Search or jump to anything'],
    [['/'], 'Search'],
    [['?'], 'Show these shortcuts'],
    [['Esc'], 'Close a window or menu']
  ];
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <div className="shortcut-sheet">
        <section>
          <h3>Anywhere</h3>
          {general.map(([keys, label]) => (
            <div className="shortcut-row" key={label}><span>{label}</span><Keys keys={keys} /></div>
          ))}
          <h3>Create</h3>
          {QUICK_ACTIONS.map((action) => (
            <div className="shortcut-row" key={action.id}><span>{action.title}</span><Keys keys={action.keys.map((key) => key.toUpperCase())} /></div>
          ))}
        </section>
        <section>
          <h3>Go to</h3>
          {ALL_PRODUCTS.filter(({ key2 }) => key2).map((product) => (
            <div className="shortcut-row" key={product.key}><span>{product.name}</span><Keys keys={['G', product.key2!.toUpperCase()]} /></div>
          ))}
        </section>
      </div>
      <div className="form-actions">
        <button className="primary always" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}
