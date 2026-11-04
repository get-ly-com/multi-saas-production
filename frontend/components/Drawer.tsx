import { KeyboardEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from '@/components/Icon';
import { trapTab, useReturnFocus, useScrollLock } from '@/lib/ui';

// A panel that slides in from the right over a list, so a record can be read or edited
// without losing your place. Escape, the close button or a click on the dimmed list close it.
//   const [open, setOpen] = useState<Invoice | null>(null);
//   <Drawer open={!!open} title={open?.invoice_number} subtitle={open?.customer_name}
//     onClose={() => setOpen(null)} footer={<button className="primary">Record payment</button>}>
//     ...details...
//   </Drawer>

export default function Drawer({ open, title, subtitle, onClose, children, footer, width = 520 }: {
  open: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  // Stays drawn for a moment after closing, so it can slide out
  const [shown, setShown] = useState(open);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (open) setShown(true);
    else if (shown) {
      const timer = setTimeout(() => setShown(false), 220);
      return () => clearTimeout(timer);
    }
  }, [open]);

  useReturnFocus(open, box);
  useScrollLock(open);

  if (!mounted || (!open && !shown)) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    trapTab(event, box.current);
  };

  return createPortal(
    <div className={`drawer-layer ${open ? 'is-open' : 'is-closing'}`}>
      <div className="drawer-back" onClick={onClose} />
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        tabIndex={-1}
        ref={box}
        onKeyDown={onKeyDown}
        style={{ width: `min(${width}px, 100vw)` }}
      >
        <header className="drawer-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="muted">{subtitle}</p>}
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer className="drawer-foot">{footer}</footer>}
      </div>
    </div>,
    document.body
  );
}
