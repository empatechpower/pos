import type { ReactNode } from "react";

/** A dialog in the prototype's own markup (proto-reference/index.html, dialog()): overlay, heading bar with a close button, then the body. */
export function ProtoDialog({ title, extra = "", onClose, children }: { title: string; extra?: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-label={title} className={`dialog ${extra}`}>
        <div className="heading"><h2>{title}</h2><button onClick={onClose} aria-label="Close">✕</button></div>
        {children}
      </section>
    </div>
  );
}
