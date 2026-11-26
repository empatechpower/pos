import { useSyncExternalStore } from "react";
import { ProtoModal } from "./ProtoDialog";

/** A question put to the person in one of the prototype's dialogs, in place of the browser's own pop-up (which cannot be styled, and which some kiosk browsers suppress). */
interface Ask { title: string; message: string; ok: string; cancel: string; resolve: (yes: boolean) => void }
let current: Ask | null = null;
const listeners = new Set<() => void>();
const set = (a: Ask | null) => { current = a; listeners.forEach((l) => l()); };

/** Ask, and wait for the answer. Closing the dialog counts as No. A second question while one is open answers the first with No. */
export function askConfirm(q: { title: string; message: string; ok?: string; cancel?: string }): Promise<boolean> {
  current?.resolve(false);
  return new Promise<boolean>((resolve) => set({ title: q.title, message: q.message, ok: q.ok ?? "OK", cancel: q.cancel ?? "Cancel", resolve }));
}

/** Mounted once, at the top of the app: draws whichever question is waiting. */
export function ConfirmHost() {
  const a = useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => current);
  if (!a) return null;
  const answer = (yes: boolean) => { set(null); a.resolve(yes); };
  return (
    <ProtoModal title={a.title} extra="confirmdialog" onClose={() => answer(false)}>
      <p>{a.message}</p>
      <div className="actions"><button onClick={() => answer(false)}>{a.cancel}</button><button className="primary" autoFocus onClick={() => answer(true)}>{a.ok}</button></div>
    </ProtoModal>
  );
}
