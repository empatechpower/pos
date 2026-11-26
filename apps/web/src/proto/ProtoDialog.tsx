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

/** The same dialog, for use on a screen that is not itself drawn in the prototype's stylesheet: it brings the stylesheet's scope with it. `wide` is the prototype's wider dialog (.splitdialog). */
export function ProtoModal({ title, wide, extra = "", onClose, children }: { title: string; wide?: boolean; extra?: string; onClose: () => void; children: ReactNode }) {
  return <div className="proto protohead"><ProtoDialog title={title} extra={`${wide ? "splitdialog " : ""}${extra}`.trim()} onClose={onClose}>{children}</ProtoDialog></div>;
}
