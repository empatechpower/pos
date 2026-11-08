import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { newId, type OrderEvent, type OrderEventBody } from "@pos/core";

/**
 * Local-first store. The UI reads and writes ONLY here; sync.ts moves data to and from the
 * server in the background. Every event carries `synced` (0 = still to push, 1 = server has it).
 */

type StoredLocalEvent = OrderEvent & { synced: 0 | 1 };

interface PosDB extends DBSchema {
  events: { key: string; value: StoredLocalEvent; indexes: { bySynced: number } };
  meta: { key: string; value: unknown };
}

let dbPromise: Promise<IDBPDatabase<PosDB>> | null = null;
const db = () =>
  (dbPromise ??= openDB<PosDB>("pos", 1, {
    upgrade(d) {
      const events = d.createObjectStore("events", { keyPath: "id" });
      events.createIndex("bySynced", "synced");
      d.createObjectStore("meta");
    },
  }));

// ---- identity ---------------------------------------------------------------------------

const LS_DEVICE = "pos.deviceId";
const LS_CODE = "pos.deviceCode";

export const deviceId = (): string => {
  let id = localStorage.getItem(LS_DEVICE);
  if (!id) {
    id = newId();
    localStorage.setItem(LS_DEVICE, id);
  }
  return id;
};
export const getDeviceCode = (): string => localStorage.getItem(LS_CODE) ?? "A";
export const setDeviceCode = (c: string) => localStorage.setItem(LS_CODE, c.toUpperCase().slice(0, 2));

// ---- change notification ----------------------------------------------------------------

const listeners = new Set<() => void>();
export const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const notify = () => listeners.forEach((fn) => fn());

// ---- reads -------------------------------------------------------------------------------

export async function allEvents(): Promise<OrderEvent[]> {
  const rows = await (await db()).getAll("events");
  return rows.map(({ synced: _s, ...e }) => e as OrderEvent);
}

export async function pendingCount(): Promise<number> {
  return (await db()).countFromIndex("events", "bySynced", 0);
}

export async function unsynced(): Promise<OrderEvent[]> {
  const rows = await (await db()).getAllFromIndex("events", "bySynced", 0);
  return rows.map(({ synced: _s, ...e }) => e as OrderEvent);
}

// ---- writes ------------------------------------------------------------------------------

async function nextSeq(): Promise<number> {
  const d = await db();
  const tx = d.transaction("meta", "readwrite");
  const cur = ((await tx.store.get("seq")) as number | undefined) ?? 0;
  await tx.store.put(cur + 1, "seq");
  await tx.done;
  return cur + 1;
}

/** Record something that happened on this device. Works with no network. */
export async function record(orderId: string, body: OrderEventBody, asDevice?: string): Promise<OrderEvent> {
  const seq = await nextSeq();
  const event = { ...body, id: newId(), orderId, deviceId: asDevice ?? deviceId(), ts: Date.now(), seq } as OrderEvent;
  await (await db()).put("events", { ...event, synced: 0 });
  notify();
  return event;
}

/** Events that came from the server. Existing ids are left alone (idempotent). */
export async function ingestRemote(events: OrderEvent[]): Promise<void> {
  const d = await db();
  const tx = d.transaction("events", "readwrite");
  for (const e of events) {
    const existing = await tx.store.get(e.id);
    if (!existing) await tx.store.put({ ...e, synced: 1 });
    else if (existing.synced === 0) await tx.store.put({ ...existing, synced: 1 });
  }
  await tx.done;
  notify();
}

/** After enrolling, events still waiting to sync are re-labelled with the server-issued device id. */
export async function adoptDeviceId(newId: string): Promise<void> {
  const d = await db();
  const tx = d.transaction("events", "readwrite");
  const waiting = await tx.store.index("bySynced").getAll(0);
  for (const e of waiting) await tx.store.put({ ...e, deviceId: newId });
  await tx.done;
  notify();
}

export async function markSynced(ids: string[]): Promise<void> {
  const d = await db();
  const tx = d.transaction("events", "readwrite");
  for (const id of ids) {
    const e = await tx.store.get(id);
    if (e && e.synced === 0) await tx.store.put({ ...e, synced: 1 });
  }
  await tx.done;
  notify();
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get("meta", key)) as T | undefined;
}
export async function setMeta(key: string, value: unknown): Promise<void> {
  await (await db()).put("meta", value, key);
}
