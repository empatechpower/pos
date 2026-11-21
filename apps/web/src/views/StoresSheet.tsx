import { useEffect, useState } from "react";
import { formatDistance, sortByDistance } from "@pos/core";
import { tx } from "../shopI18n";

export interface Store {
  id: string; name: string; address?: string; phone?: string; hours?: string; prepMinutes?: number | null;
  latitude?: number | null; longitude?: number | null; directionsUrl?: string;
  menu?: { state?: string };
}

/** The outlets a customer can order from. The shop's own list; nearest first only if the customer chooses to share where they are. */
export function useStores(): Store[] | null {
  const [stores, setStores] = useState<Store[] | null>(null);
  useEffect(() => { void fetch("/api/shop/stores").then((r) => (r.ok ? (r.json() as Promise<{ stores: Store[] }>) : null)).then((j) => setStores(j?.stores ?? [])).catch(() => setStores([])); }, []);
  return stores;
}

export function StoresSheet({ stores, currentId, onPick, onClose }: { stores: Store[]; currentId?: string; onPick: (id: string) => void; onClose: () => void }) {
  const [here, setHere] = useState<{ latitude: number; longitude: number } | null>(null);
  const [note, setNote] = useState("");
  const anyCoords = stores.some((s) => typeof s.latitude === "number" && typeof s.longitude === "number");
  const list = here ? sortByDistance(stores, here) : stores.map((s) => ({ ...s, distanceKm: null as number | null }));

  function locate() {
    setNote("");
    if (!navigator.geolocation) { setNote(tx("This device cannot share its location.")); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => setHere({ latitude: p.coords.latitude, longitude: p.coords.longitude }),
      () => setNote(tx("Location was not shared, so the outlets are listed as they are.")),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60_000 },
    );
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="tbl-back" role="dialog" aria-label={tx("Our outlets")} onClick={onClose}>
      <div className="tbl-sheet" onClick={(e) => e.stopPropagation()} style={{ maxHeight: "85dvh", overflow: "auto" }}>
        <h3>{tx("Our outlets")}</h3>
        {anyCoords && !here && <button className="secondary sm" onClick={locate}>{tx("Show the nearest first")}</button>}
        {note && <p className="muted" role="status">{note}</p>}
        {list.map((s) => (
          <div key={s.id} className="e2e-card" style={{ marginTop: 10 }}>
            <b>{s.name}{s.id === currentId ? ` · ${tx("you are ordering here")}` : ""}</b>
            {s.distanceKm !== null && <span className="muted"> · {formatDistance(s.distanceKm)}</span>}
            {s.address && <div className="muted">{s.address}</div>}
            {(s.hours || s.phone) && <div className="muted">{[s.hours, s.phone].filter(Boolean).join(" · ")}</div>}
            {typeof s.prepMinutes === "number" && s.prepMinutes > 0 && <div className="muted">{tx("About {n} minutes to prepare", { n: s.prepMinutes })}</div>}
            {s.menu?.state === "AVAILABLE_LATER" && <div className="muted">{tx("Not taking orders right now")}</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              {s.id !== currentId && <button className="shop-primary" style={{ flex: "none", padding: "8px 18px" }} onClick={() => onPick(s.id)}>{tx("Order from here")}</button>}
              {s.directionsUrl && <a className="secondary sm" href={s.directionsUrl} target="_blank" rel="noreferrer">{tx("Directions")}</a>}
            </div>
          </div>
        ))}
        <button className="secondary sm" style={{ marginTop: 12 }} onClick={onClose}>{tx("Close")}</button>
      </div>
    </div>
  );
}
