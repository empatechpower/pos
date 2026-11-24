/**
 * Training mode: practice on a till with nothing real touched. A practice till keeps its orders in its own separate store on the device,
 * sends nothing to the server, charges no one and prints nothing; the real orders waiting on the device are left alone until training ends.
 * Only a manager turns it on; anyone can turn it off from the flashing strip at the bottom of every screen. Leaving it makes the next sign-in land on the home screen once.
 */
const LS = "pos.training";
const LS_RESET = "pos.training.reset";

export const isTraining = (): boolean => localStorage.getItem(LS) === "1";
if (isTraining()) document.documentElement.classList.add("training-on");

/** Turn practice mode on or off. The screen reloads so everything reads from the right store. */
export function setTraining(on: boolean): void {
  if (on) localStorage.setItem(LS, "1");
  else { localStorage.removeItem(LS); localStorage.setItem(LS_AFTER, "1"); }
  location.reload();
}
const LS_AFTER = "pos.training.after";
/** True once, after practice ends: the next sign-in goes to the home screen whatever it normally does. */
export const takeAfterTraining = (): boolean => {
  const a = localStorage.getItem(LS_AFTER) === "1";
  if (a) localStorage.removeItem(LS_AFTER);
  return a;
};
/** Throw away everything practised so far, then reload (the store is emptied before it is next opened). */
export function resetPracticeData(): void {
  localStorage.setItem(LS_RESET, "1");
  location.reload();
}
export const practiceResetRequested = (): boolean => {
  const r = localStorage.getItem(LS_RESET) === "1";
  if (r) localStorage.removeItem(LS_RESET);
  return r;
};
