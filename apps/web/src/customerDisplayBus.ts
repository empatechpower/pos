import type { DisplayState } from "@pos/core";
import { deviceHeader } from "./device";

/**
 * How the till tells the customer screen what to show. The same state travels three ways, so it works wherever the screen is:
 *  - the Android app's second display: the app calls window.setDisplay(json) on the display page, and the till calls Android.display(json);
 *  - another browser window on the same device (a second monitor): BroadcastChannel;
 *  - a fallback for browsers without it: a localStorage write that the other window hears.
 */
const CHANNEL = "rezein-display";
const KEY = "rezein-display-state";
/** "1" once this till has a customer screen linked through the server. */
const LINKED = "rezein-display-linked";

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
  if (hasLinkedScreen()) void pushToServer(state);
}

export const hasLinkedScreen = (): boolean => { try { return localStorage.getItem(LINKED) === "1"; } catch { return false; } };

// The latest state wins: while one request is out, newer states replace each other and only the last is sent next.
let sending = false;
let waiting: DisplayState | null = null;
async function pushToServer(state: DisplayState): Promise<void> {
  if (sending) { waiting = state; return; }
  sending = true;
  try {
    await fetch("/api/display/state", { method: "PUT", headers: { "content-type": "application/json", ...deviceHeader() }, body: JSON.stringify({ state }) }).catch(() => undefined);
  } finally {
    sending = false;
    if (waiting) { const next = waiting; waiting = null; void pushToServer(next); }
  }
}

/** The till types the code a display is showing. Afterwards every state it publishes also goes to that screen. */
export async function linkDisplay(code: string): Promise<"ok" | "wrong" | "failed"> {
  const r = await fetch("/api/display/link", { method: "POST", headers: { "content-type": "application/json", ...deviceHeader() }, body: JSON.stringify({ code }) }).catch(() => null);
  if (!r) return "failed";
  if (r.ok) { try { localStorage.setItem(LINKED, "1"); } catch { /* ignore */ } return "ok"; }
  return r.status === 404 || r.status === 400 ? "wrong" : "failed";
}

/** The screens linked to this till. */
export async function linkedScreens(): Promise<Array<{ id: string; lastSeen: string | null }>> {
  const r = await fetch("/api/display/screens", { headers: deviceHeader() }).catch(() => null);
  if (!r?.ok) return [];
  const list = ((await r.json()) as { screens: Array<{ id: string; lastSeen: string | null }> }).screens;
  try { localStorage.setItem(LINKED, list.length ? "1" : "0"); } catch { /* ignore */ }
  return list;
}

export async function unlinkScreen(id: string): Promise<void> {
  await fetch(`/api/display/screens/${id}`, { method: "DELETE", headers: deviceHeader() }).catch(() => undefined);
  await linkedScreens();
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
