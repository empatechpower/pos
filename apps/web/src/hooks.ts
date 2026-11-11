import { useEffect, useState, useSyncExternalStore } from "react";
import { reduceAll, type BusinessConfig, type Catalog, type OrderState } from "@pos/core";
import { staffFetch, useStaff } from "./auth";
import { allEvents, pendingCount, subscribe } from "./db";
import { cachedCatalog, cachedConfig, getSyncStatus, refreshReference, subscribeSync } from "./sync";

/** All orders, rebuilt from the local event log whenever it changes. */
export function useOrders(): OrderState[] {
  const [orders, setOrders] = useState<OrderState[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const events = await allEvents();
      if (alive) setOrders(reduceAll(events));
    };
    void load();
    const off = subscribe(() => void load());
    return () => {
      alive = false;
      off();
    };
  }, []);
  return orders;
}

export function usePending(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const c = await pendingCount();
      if (alive) setN(c);
    };
    void load();
    const off = subscribe(() => void load());
    const t = window.setInterval(() => void load(), 3000);
    return () => {
      alive = false;
      off();
      window.clearInterval(t);
    };
  }, []);
  return n;
}

export const useSyncStatus = () => useSyncExternalStore(subscribeSync, getSyncStatus);

/** Business config + catalog: cached copy first (works offline), refreshed while the server answers. */
export function useReference(): { config: BusinessConfig | null; catalog: Catalog | null } {
  const [ref, setRef] = useState<{ config: BusinessConfig | null; catalog: Catalog | null }>({
    config: cachedConfig(),
    catalog: cachedCatalog(),
  });
  const status = useSyncStatus();
  useEffect(() => {
    if (!status.reachable) return;
    const load = () =>
      void refreshReference().then((r) => r && setRef((cur) => (cur.catalog?.version === r.catalog.version && cur.config ? cur : r)));
    load();
    window.addEventListener("pos:catalog-refresh", load); // a manager just changed something on this device
    const t = window.setInterval(load, 30_000); // a manager's price change reaches the tills within half a minute
    return () => {
      window.clearInterval(t);
      window.removeEventListener("pos:catalog-refresh", load);
    };
  }, [status.reachable]);
  return ref;
}

/** For managers: how many print jobs have failed for good, shown as a red dot on the Printers link. */
export function useFailedPrintJobs(): number {
  const staff = useStaff();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!staff || staff.role === "cashier") return setN(0);
    let alive = true;
    const load = async () => {
      let total = 0;
      for (const status of ["failed", "unconfirmed"]) {
        const r = await staffFetch(`/api/print/jobs?status=${status}`);
        if ("res" in r && r.res.ok) total += ((await r.res.json()) as { jobs: unknown[] }).jobs.length;
      }
      if (alive) setN(total);
    };
    void load();
    const t = window.setInterval(() => void load(), 15000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [staff]);
  return n;
}

/** How many customer orders are waiting for staff to accept them, for the red count on the Online link. */
export function useNewOnlineOrders(): number {
  return useOrders().filter((o) => o.source === "online" && !o.acceptedAt && o.stage !== "cancelled").length;
}
