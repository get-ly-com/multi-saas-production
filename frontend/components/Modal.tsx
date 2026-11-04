import { KeyboardEvent, ReactNode, useEffect, useRef } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Escape closes the dialog when onClose is given; Tab stays inside it
export default function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose?: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const box = dialog.current;
    if (box && !box.contains(document.activeElement)) box.focus();
    return () => {
      if (before && document.contains(before)) before.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && onClose) {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialog.current) return;

    const items = Array.from(dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((item) => item.offsetParent !== null || item === document.activeElement);
    if (!items.length) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialog.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="modal-back">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={dialog} onKeyDown={onKeyDown}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}
