import { useSyncExternalStore } from "react";
import { staffFetch } from "./auth";

/** The shop floor as the manager laid it out. Kept on the device so the table map still opens with no connection. */
/** Where a table sits on the floor map: x and y are percentages of the canvas; the shape is how it is drawn. */
export interface FloorTable { id: string; name: string; seats?: number; shape?: "rect" | "round" | "oval"; x?: number; y?: number }

export interface FloorSettings {
  sections: Array<{ id: string; name: string; tables: Array<FloorTable> }>;
  splitBill: boolean;
  courses: boolean;
  overdueMinutes: number;
}
export const DEFAULT_FLOOR: FloorSettings = {
  sections: [
    { id: "main", name: "Main floor", tables: Array.from({ length: 12 }, (_, i) => ({ id: `t${i + 1}`, name: `Table ${i + 1}`, seats: 4 })) },
    { id: "bar", name: "Bar", tables: Array.from({ length: 4 }, (_, i) => ({ id: `b${i + 1}`, name: `Bar ${i + 1}`, seats: 2 })) },
  ],
  splitBill: true,
  courses: true,
  overdueMinutes: 90,
};

const KEY = "pos.floor";
let current: FloorSettings = (() => { try { return { ...DEFAULT_FLOOR, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<FloorSettings>) }; } catch { return DEFAULT_FLOOR; } })();
const listeners = new Set<() => void>();
const set = (f: FloorSettings) => { current = f; try { localStorage.setItem(KEY, JSON.stringify(f)); } catch { /* not kept */ } listeners.forEach((l) => l()); };

export async function loadFloor(): Promise<void> {
  const r = await staffFetch("/api/settings/floor");
  if ("res" in r && r.res.ok) set({ ...DEFAULT_FLOOR, ...((await r.res.json()) as Partial<FloorSettings>) });
}
export async function saveFloor(patch: Partial<FloorSettings>): Promise<string | null> {
  const r = await staffFetch("/api/settings/floor", { method: "PUT", body: patch });
  if ("res" in r && r.res.ok) { set(await r.res.json() as FloorSettings); return null; }
  return "problem" in r ? r.problem : "That layout is not allowed: names must be different and every section needs a name.";
}
export const useFloor = (): FloorSettings => { useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => current); return current; };
/** Every table name on the floor. */
export const tableNames = (f: FloorSettings): string[] => f.sections.flatMap((s) => s.tables.map((t) => t.name));
