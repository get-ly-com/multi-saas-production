import { ReactNode } from 'react';

export default function Modal({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="modal-back">
      <div className="modal" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}
