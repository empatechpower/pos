import { useEffect, useRef, useState } from "react";
import { formatMoney } from "@pos/core";

const DURATION_MS = 800;
const STEP_MS = 83; // the shown value changes at most this often, so it counts in steps rather than sliding
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/**
 * An amount that rolls to its new value instead of jumping: 800 ms, in steps, ease-in-out, with a small lift while it moves.
 * Every price that can change on screen goes through this one component so no path jumps while another rolls. A new
 * change restarts from whatever is showing now, it always lands on the exact amount, and with reduced motion it updates at once.
 */
export function RollMoney({ cents }: { cents: number }) {
  const [shown, setShown] = useState(cents);
  const [moving, setMoving] = useState(false);
  const [bump, setBump] = useState(0); // a new value restarts the rise, as in the prototype
  const now = useRef(cents); // what is on screen, so a quick second change starts from here
  useEffect(() => {
    if (now.current === cents) return;
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      now.current = cents;
      setShown(cents);
      return;
    }
    const from = now.current;
    const start = performance.now();
    let last = -1;
    let raf = 0;
    setMoving(true);
    setBump((n) => n + 1);
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / DURATION_MS);
      if (p >= 1) {
        now.current = cents;
        setShown(cents);
        setMoving(false);
        return;
      }
      const step = Math.floor((p * DURATION_MS) / STEP_MS);
      if (step !== last) {
        last = step;
        const v = Math.round(from + (cents - from) * ease(p));
        now.current = v;
        setShown(v);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cents]);
  return <span key={bump} className={moving ? "roll-money moving" : "roll-money"}>{formatMoney(shown)}</span>;
}
