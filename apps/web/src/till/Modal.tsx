import type { ReactNode } from "react";

/** A centred card with a blue title band, as in the classic Revel dialogs. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="t-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-label={title} className={`t-dialog ${wide ? "wide" : ""}`}>
        <div className="t-dhead"><h2>{title}</h2><button onClick={onClose} aria-label="Close">✕</button></div>
        <div className="t-dbody">{children}</div>
      </section>
    </div>
  );
}
