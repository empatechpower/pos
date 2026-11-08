import type { BusinessConfig, Catalog } from "@pos/core";
import { deviceHeader, getDeviceState, markDeviceRejected, needsEnrollment, refreshDeviceMode } from "./device";
import { getMeta, ingestRemote, markSynced, setMeta, unsynced } from "./db";

// ---- connection state (shared with the UI) -------------------------------------------------

export interface SyncStatus {
  online: boolean; // browser says we have a network
  reachable: boolean; // the server actually answered last time
  syncing: boolean;
  lastSyncAt: number | null;
  error: string | null;
}
let status: SyncStatus = { online: navigator.onLine, reachable: false, syncing: false, lastSyncAt: null, error: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<SyncStatus>) => {
  status = { ...status, ...patch };
  listeners.forEach((l) => l());
};
export const getSyncStatus = () => status;
export const subscribeSync = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

// ---- config & menu: cached so the app starts offline ----------------------------------------

const LS_CONFIG = "pos.config";
const LS_CATALOG = "pos.catalog";
export const cachedConfig = (): BusinessConfig | null => JSON.parse(localStorage.getItem(LS_CONFIG) ?? "null");
export const cachedCatalog = (): Catalog | null => JSON.parse(localStorage.getItem(LS_CATALOG) ?? "null");

/**
 * Config + the whole catalog (every pricebook and channel, so any channel can be priced offline).
 * The catalog's version is its ETag: an unchanged catalog costs one tiny 304.
 */
export async function refreshReference(): Promise<{ config: BusinessConfig; catalog: Catalog } | null> {
  try {
    const cached = cachedCatalog();
    const [c, k] = await Promise.all([
      fetch("/api/config"),
      fetch("/api/catalog", { headers: cached ? { "if-none-match": `"v${cached.version}"` } : {} }),
    ]);
    if (!c.ok) return null;
    const config = (await c.json()) as BusinessConfig;
    const catalog = k.status === 304 && cached ? cached : k.ok ? ((await k.json()) as Catalog) : null;
    if (!catalog) return null;
    localStorage.setItem(LS_CONFIG, JSON.stringify(config));
    localStorage.setItem(LS_CATALOG, JSON.stringify(catalog));
    return { config, catalog };
  } catch {
    return null;
  }
}

// ---- push/pull -------------------------------------------------------------------------------

let running = false;
let again = false;

/** Push anything created while offline, then pull anything new. Safe to call at any time. */
export async function syncNow(): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  if (needsEnrollment()) return; // nothing to say to the server until this device is enrolled
  running = true;
  set({ syncing: true });
  try {
    const pending = await unsynced();
    if (pending.length) {
      const res = await fetch("/api/sync/push", {
        method: "POST",
        headers: { "content-type": "application/json", ...deviceHeader() },
        body: JSON.stringify({ events: pending }),
      });
      if (res.status === 401) return markDeviceRejected();
      if (!res.ok) throw new Error(`push failed (${res.status})`);
      await markSynced(pending.map((e) => e.id));
    }
    const after = (await getMeta<number>("lastServerSeq")) ?? 0;
    const res = await fetch(`/api/sync/pull?after=${after}`, { headers: deviceHeader() });
    if (res.status === 401) return markDeviceRejected();
    if (!res.ok) throw new Error(`pull failed (${res.status})`);
    const body = (await res.json()) as { events: Array<{ serverSeq: number; event: never }>; latestSeq: number };
    if (body.events.length) await ingestRemote(body.events.map((s) => s.event));
    await setMeta("lastServerSeq", body.latestSeq);
    set({ reachable: true, lastSyncAt: Date.now(), error: null });
  } catch (err) {
    set({ reachable: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    running = false;
    set({ syncing: false });
    if (again) {
      again = false;
      void syncNow();
    }
  }
}

/** Start background sync: on reconnect, on live server nudges, and on a timer as a safety net. */
export function startSync(): () => void {
  const onOnline = () => {
    set({ online: true });
    void syncNow();
  };
  const onOffline = () => set({ online: false, reachable: false });
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);

  // The stream is opened with a one-time ticket (EventSource cannot send headers), and a ticket is
  // used up on connect, so reconnecting means asking for a fresh one each time.
  let es: EventSource | null = null;
  let stopped = false;
  let retry: number | undefined;
  const connect = async () => {
    es?.close();
    if (stopped) return;
    const again = (ms: number) => {
      window.clearTimeout(retry);
      retry = window.setTimeout(() => void connect(), ms);
    };
    if (needsEnrollment()) return again(5000);
    try {
      const res = await fetch("/api/stream/ticket", { method: "POST", headers: deviceHeader() });
      if (res.status === 401) markDeviceRejected();
      if (!res.ok) return again(5000);
      const { ticket } = (await res.json()) as { ticket: string };
      es = new EventSource(ticket === "open" ? "/api/stream" : `/api/stream?ticket=${encodeURIComponent(ticket)}`);
      es.addEventListener("events", () => void syncNow());
      es.addEventListener("hello", () => void syncNow());
      es.onerror = () => {
        set({ reachable: false });
        es?.close();
        again(3000);
      };
    } catch {
      again(5000);
    }
  };
  void connect();
  void refreshDeviceMode().then(() => void syncNow());

  const timer = window.setInterval(() => {
    void refreshDeviceMode(); // no-op once the server has answered
    void syncNow();
  }, 8000);
  void refreshReference();
  void syncNow();
  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    window.clearInterval(timer);
    stopped = true;
    window.clearTimeout(retry);
    es?.close();
  };
}
