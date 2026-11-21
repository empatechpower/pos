import type { DisplayState } from "@pos/core";

/**
 * How the till tells the customer screen what to show. The same state travels three ways, so it works wherever the screen is:
 *  - the Android app's second display: the app calls window.setDisplay(json) on the display page, and the till calls Android.display(json);
 *  - another browser window on the same device (a second monitor): BroadcastChannel;
 *  - a fallback for browsers without it: a localStorage write that the other window hears.
 */
const CHANNEL = "rezein-display";
const KEY = "rezein-display-state";

declare global {
  interface Window {
    /** Set by the Android app (Hub plus POS) so the till can hand the order to the native second display. */
    RezeinNative?: { display?: (json: string) => void };
    /** Set by the display page so the Android app can push a state into it. */
    setDisplay?: (state: DisplayState | string) => void;
  }
}

/** Called by the till whenever its order changes (or is cleared: pass an idle state). */
export function publishDisplay(state: DisplayState): void {
  const json = JSON.stringify(state);
  try { window.RezeinNative?.display?.(json); } catch { /* the native side is optional */ }
  try { const bc = new BroadcastChannel(CHANNEL); bc.postMessage(state); bc.close(); } catch { /* no BroadcastChannel */ }
  try { localStorage.setItem(KEY, json); } catch { /* storage may be blocked */ }
}

/** The display page listens here. Returns a function that stops listening. */
export function listenDisplay(on: (s: DisplayState) => void): () => void {
  let bc: BroadcastChannel | null = null;
  try { bc = new BroadcastChannel(CHANNEL); bc.onmessage = (e) => on(e.data as DisplayState); } catch { /* fall through to storage */ }
  const onStorage = (e: StorageEvent) => { if (e.key === KEY && e.newValue) { try { on(JSON.parse(e.newValue) as DisplayState); } catch { /* ignore a bad write */ } } };
  window.addEventListener("storage", onStorage);
  window.setDisplay = (s) => { try { on(typeof s === "string" ? (JSON.parse(s) as DisplayState) : s); } catch { /* ignore */ } };
  try { const last = localStorage.getItem(KEY); if (last) on(JSON.parse(last) as DisplayState); } catch { /* none yet */ }
  return () => { bc?.close(); window.removeEventListener("storage", onStorage); delete window.setDisplay; };
}
