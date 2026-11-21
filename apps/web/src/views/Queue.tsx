import { useEffect, useRef, useState } from "react";
import { newlyReady, spokenNumber, visibleToKitchen, type BusinessConfig } from "@pos/core";
import { useOrders } from "../hooks";

const LS_SOUND = "queue.sound";

/**
 * Public display for a TV or tablet: preparing on the left, ready on the right.
 * When a number moves to Ready it chimes and says the number aloud (handover 7.3). A browser only lets a page make sound after it
 * has been touched once, so the board asks for one tap and then remembers; the sound can be switched off from the corner.
 */
export function Queue({ config }: { config: BusinessConfig | null }) {
  const orders = useOrders();
  const shown = config ? orders.filter((o) => o.queueNumber && visibleToKitchen(o, config)) : [];
  const preparing = shown.filter((o) => o.stage === "open" || o.stage === "preparing").sort((a, b) => a.openedAt - b.openedAt);
  const ready = shown.filter((o) => o.stage === "ready").sort((a, b) => b.openedAt - a.openedAt);

  const [sound, setSound] = useState(() => { try { return localStorage.getItem(LS_SOUND) !== "0"; } catch { return true; } });
  const [unlocked, setUnlocked] = useState(false);
  const audio = useRef<AudioContext | null>(null);
  const seen = useRef<Set<string> | null>(null);

  // The first touch unlocks sound for the page.
  useEffect(() => {
    const unlock = () => {
      try {
        audio.current ??= new AudioContext();
        void audio.current.resume();
        setUnlocked(true);
      } catch { /* no audio on this device */ }
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);

  // The merchant's own sound, when they have set one (else the built-in chime). The board can name the spoken language with ?lang=.
  const [custom, setCustom] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    void fetch("/api/brand/sound", { cache: "no-cache" }).then(async (r) => { if (r.ok) { url = URL.createObjectURL(await r.blob()); setCustom(url); } }).catch(() => undefined);
    return () => { if (url) URL.revokeObjectURL(url); };
  }, []);
  const speakLang = (() => { try { return new URLSearchParams(window.location.search).get("lang") || "en"; } catch { return "en"; } })();

  const chime = () => {
    if (custom) { try { void new Audio(custom).play(); return; } catch { /* fall through to the default */ } }
    const ac = audio.current;
    if (!ac) return;
    [880, 1318.5].forEach((hz, i) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      const t0 = ac.currentTime + i * 0.28;
      o.type = "sine";
      o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);
      o.connect(g).connect(ac.destination);
      o.start(t0);
      o.stop(t0 + 0.65);
    });
  };
  const say = (number: string) => {
    try {
      const u = new SpeechSynthesisUtterance(`Number ${spokenNumber(number)}`);
      u.lang = speakLang;
      u.rate = 0.9;
      window.speechSynthesis.speak(u);
    } catch { /* no speech on this device */ }
  };

  const readyKey = ready.map((o) => o.orderId).join(",");
  useEffect(() => {
    if (!config) return;
    if (seen.current === null) { seen.current = new Set(ready.map((o) => o.orderId)); return; } // the first look announces nothing
    const fresh = newlyReady(seen.current, ready);
    seen.current = new Set(ready.map((o) => o.orderId));
    if (!fresh.length || !sound || !unlocked) return;
    chime();
    fresh.forEach((n, i) => window.setTimeout(() => say(n), 700 + i * 2200)); // one after another
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyKey, config]);

  const toggle = () => {
    const next = !sound;
    setSound(next);
    try { localStorage.setItem(LS_SOUND, next ? "1" : "0"); } catch { /* not kept */ }
    if (!next) try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
  };

  return (
    <div className="queue">
      <div className="col">
        <h2>Preparing</h2>
        <div className="nums">
          {preparing.map((o) => (
            <span key={o.orderId} className="num">{o.queueNumber}</span>
          ))}
        </div>
      </div>
      <div className="col ready">
        <h2>Ready</h2>
        <div className="nums">
          {ready.map((o) => (
            <span key={o.orderId} className="num">{o.queueNumber}</span>
          ))}
        </div>
      </div>
      <button className="queue-sound" onClick={toggle} aria-pressed={sound} title={sound ? "Sound is on" : "Sound is off"}>
        {sound ? (unlocked ? "🔔 Sound on" : "🔔 Tap the screen to turn sound on") : "🔕 Sound off"}
      </button>
    </div>
  );
}
