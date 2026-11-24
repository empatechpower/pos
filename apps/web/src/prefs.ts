import { useSyncExternalStore } from "react";
import { currentStaff, staffFetch } from "./auth";
import type { MenuLayout } from "./till/layout";

/** A person's own screen choices. They live on the server so they follow the person to any till; a copy is kept here for offline starts. */
export interface Prefs { menuSide: "left" | "right"; textSize: "compact" | "standard" | "large" | "xl"; /** Their own menu layout, when they made one. */ layout?: MenuLayout }
export const DEFAULT_PREFS: Prefs = { menuSide: "right", textSize: "standard" };
/** How much bigger than the original the interface is at each size (Standard is 20% up, as decided). */
export const TEXT_SCALE: Record<Prefs["textSize"], number> = { compact: 1, standard: 1.2, large: 1.35, xl: 1.5 };

const key = () => `pos.prefs.${currentStaff()?.code ?? "-"}`;
const read = (): Prefs => { try { return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(key()) ?? "null") ?? {}) }; } catch { return DEFAULT_PREFS; } };
let prefs: Prefs = read();
let who = currentStaff()?.code ?? "-";
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Load the signed-in person's choices from the server (and keep a local copy). */
export async function loadPrefs(): Promise<void> {
  const code = currentStaff()?.code ?? "-";
  if (code !== who) { who = code; prefs = read(); emit(); }
  if (code === "-") return;
  const r = await staffFetch("/api/auth/prefs");
  if ("res" in r && r.res.ok) { prefs = { ...DEFAULT_PREFS, ...((await r.res.json()) as { prefs: Partial<Prefs> }).prefs }; localStorage.setItem(key(), JSON.stringify(prefs)); emit(); }
}
export async function setPref<K extends keyof Prefs>(k: K, v: Prefs[K]): Promise<void> {
  prefs = { ...prefs, [k]: v };
  localStorage.setItem(key(), JSON.stringify(prefs));
  emit();
  await staffFetch("/api/auth/prefs", { method: "PUT", body: { [k]: v } });
}
export const usePrefs = (): Prefs => useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => prefs);

/** Keep (or, with null, throw away) the person's own menu layout. Without one they see the shop's. */
export async function setLayout(layout: MenuLayout | null): Promise<string | null> {
  const { layout: _old, ...rest } = prefs;
  prefs = layout ? { ...rest, layout } : (rest as Prefs);
  localStorage.setItem(key(), JSON.stringify(prefs));
  emit();
  const r = await staffFetch("/api/auth/prefs", { method: "PUT", body: { layout } });
  return "res" in r && r.res.ok ? null : "That layout was not saved. It stays on this till for now.";
}
