import { useState, useSyncExternalStore } from "react";
import { ProtoModal } from "./ProtoDialog";

/** A question put to the person in one of the prototype's dialogs, in place of the browser's own pop-up (which cannot be styled, and which some kiosk browsers suppress). */
interface Ask { title: string; message: string; ok: string; cancel: string; resolve: (answer: boolean | string | null) => void; /** A typed answer is wanted: the box's label and what it starts with. */ input?: { label: string; initial: string; inputMode?: "text" | "decimal" | "numeric" }; /** Only something to read: one button. */ notice?: boolean }
let current: Ask | null = null;
const listeners = new Set<() => void>();
const set = (a: Ask | null) => { current = a; listeners.forEach((l) => l()); };

/** Ask, and wait for the answer. Closing the dialog counts as No. A second question while one is open answers the first with No. */
export function askConfirm(q: { title: string; message: string; ok?: string; cancel?: string }): Promise<boolean> {
  current?.resolve(current.input ? null : false);
  return new Promise<boolean>((resolve) => set({ title: q.title, message: q.message, ok: q.ok ?? "OK", cancel: q.cancel ?? "Cancel", resolve: (a) => resolve(a === true) }));
}
/** Ask for something typed. Gives the text (trimmed), or null when the person cancelled or left it empty. */
export function askText(q: { title: string; message: string; label?: string; initial?: string; ok?: string; cancel?: string; inputMode?: "text" | "decimal" | "numeric" }): Promise<string | null> {
  current?.resolve(current.input ? null : false);
  return new Promise<string | null>((resolve) => set({ title: q.title, message: q.message, ok: q.ok ?? "OK", cancel: q.cancel ?? "Cancel", input: { label: q.label ?? "", initial: q.initial ?? "", inputMode: q.inputMode }, resolve: (a) => resolve(typeof a === "string" && a.trim() ? a.trim() : null) }));
}
/** Tell the person something they must see, with one button to close it. */
export function tellNotice(q: { title: string; message: string; ok?: string }): Promise<void> {
  current?.resolve(current.input ? null : false);
  return new Promise<void>((resolve) => set({ title: q.title, message: q.message, ok: q.ok ?? "OK", cancel: "", notice: true, resolve: () => resolve() }));
}

/** Mounted once, at the top of the app: draws whichever question is waiting. */
export function ConfirmHost() {
  const a = useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => current);
  if (!a) return null;
  return <Question key={`${a.title}|${a.message}`} a={a} />;
}
function Question({ a }: { a: Ask }) {
  const [typed, setTyped] = useState(a.input?.initial ?? "");
  const answer = (v: boolean | string | null) => { set(null); a.resolve(v); };
  const no = () => answer(a.input ? null : false);
  const yes = () => answer(a.input ? typed : true);
  return (
    <ProtoModal title={a.title} extra="confirmdialog" onClose={no}>
      <p>{a.message}</p>
      {a.input && <label className="field">{a.input.label}<input type="text" autoFocus inputMode={a.input.inputMode ?? "text"} aria-label={a.input.label || a.title} value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && typed.trim()) yes(); }} /></label>}
      <div className="actions">{!a.notice && <button onClick={no}>{a.cancel}</button>}<button className="primary" autoFocus={!a.input} disabled={!!a.input && !typed.trim()} onClick={yes}>{a.ok}</button></div>
    </ProtoModal>
  );
}
