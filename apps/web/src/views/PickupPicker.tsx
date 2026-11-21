import { useEffect, useState } from "react";
import { tx } from "../shopI18n";

interface Slots { date: string; timeZone: string; daysAhead: number; slots: number[] }

const clock = (t: number, timeZone: string) => new Intl.DateTimeFormat([], { timeZone, hour: "numeric", minute: "2-digit" }).format(t);
const ymd = (t: number, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(t);

/**
 * "When do you want it?": as soon as possible, or a pickup time the shop offers. Shown only when the outlet takes scheduled orders
 * (the server answers the slots call with an error when it does not). The times come from the server, never made up here.
 */
export function PickupPicker({ outletId, productIds, value, onChange }: { outletId?: string; productIds: string[]; value: number | null; onChange: (t: number | null) => void }) {
  const [first, setFirst] = useState<Slots | null | undefined>(undefined); // undefined = loading, null = not offered
  const [day, setDay] = useState<string | null>(null);
  const [slots, setSlots] = useState<number[]>([]);
  const q = (date?: string) => `/api/shop/slots?${new URLSearchParams({ ...(outletId ? { outlet: outletId } : {}), ...(date ? { date } : {}), items: productIds.join(",") })}`;
  const idsKey = productIds.join(",");

  useEffect(() => {
    let live = true;
    void (async () => {
      const r = await fetch(q()).catch(() => null);
      if (!live) return;
      if (!r || !r.ok) { setFirst(null); return; }
      const j = (await r.json()) as Slots;
      setFirst(j); setDay(j.date); setSlots(j.slots);
    })();
    return () => { live = false; };
  }, [outletId, idsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function pickDay(date: string) {
    setDay(date);
    setSlots([]);
    const r = await fetch(q(date)).catch(() => null);
    if (r?.ok) setSlots(((await r.json()) as Slots).slots);
  }

  if (!first) return null;
  const todayMs = Date.parse(`${first.date}T12:00:00Z`);
  const days = Array.from({ length: first.daysAhead + 1 }, (_, i) => ymd(todayMs + i * 86_400_000, "UTC"));
  const label = (date: string, i: number) => (i === 0 ? tx("Today") : i === 1 ? tx("Tomorrow") : new Intl.DateTimeFormat([], { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(Date.parse(`${date}T12:00:00Z`)));

  return (
    <div className="e2e-card" style={{ marginBottom: 12 }}>
      <h3>{tx("When do you want it?")}</h3>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <button className="pay-opt" aria-pressed={value === null} onClick={() => onChange(null)} style={{ flex: "1 1 auto" }}><span className="pt"><b>{tx("As soon as possible")}</b></span><span className="radio" /></button>
      </div>
      {days.length > 1 && (
        <div style={{ display: "flex", gap: 6, overflowX: "auto", marginBottom: 8 }}>
          {days.map((d, i) => <button key={d} className={`chip ${day === d ? "on" : ""}`} onClick={() => void pickDay(d)}>{label(d, i)}</button>)}
        </div>
      )}
      {slots.length === 0 ? (
        <p className="muted">{tx("No pickup times on this day.")}</p>
      ) : (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {slots.map((t) => <button key={t} className={`chip ${value === t ? "on" : ""}`} onClick={() => onChange(t)}>{clock(t, first.timeZone)}</button>)}
        </div>
      )}
    </div>
  );
}
