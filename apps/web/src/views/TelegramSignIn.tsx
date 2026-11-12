import { useEffect, useState } from "react";
import { adoptSession, type StaffInfo } from "../auth";
import { adoptLinkedDevice } from "../device";

/** Where a one-time link from the Telegram bot lands: it signs this browser in as the person who asked, then opens what they asked for. */
export function TelegramSignIn() {
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    const code = new URLSearchParams(location.hash.split("?")[1] ?? "").get("code");
    if (!code) return setProblem("This link is missing its code. Ask the bot for a new one.");
    let alive = true;
    (async () => {
      const res = await fetch("/api/telegram/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) }).catch(() => null);
      if (!alive) return;
      if (!res) return setProblem("Could not reach the shop. Check the connection and open the link again.");
      if (res.status === 429) return setProblem("Too many tries. Wait a few minutes, then ask the bot for a new link.");
      if (!res.ok) return setProblem("This link has already been used or has expired. Links work once and last 10 minutes. Ask the bot for a new one.");
      const j = (await res.json()) as { deviceToken: string; deviceId: string; token: string; staff: StaffInfo; to: string };
      await adoptLinkedDevice(j.deviceToken, j.deviceId);
      adoptSession(j.token, j.staff);
      location.replace(`${location.pathname}#/${j.to}`);
      location.reload();
    })();
    return () => {
      alive = false;
    };
  }, []);
  return (
    <div className="credit">
      <h2>{problem ? "Link problem" : "Signing you in…"}</h2>
      <p className="muted">{problem ?? "One moment. You will land on the page you asked for."}</p>
    </div>
  );
}
