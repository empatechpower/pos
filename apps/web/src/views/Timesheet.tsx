import { useCallback, useEffect, useState } from "react";
import type { BusinessConfig } from "@pos/core";
import { hasPerm, staffFetch, useStaff } from "../auth";
import { downloadText, toCsv } from "../csv";
import { downloadBytes, tablePdf } from "../pdf";

interface Entry { id: string; outletId: string; staffId: string; name: string; clockIn: number; clockOut: number | null; minutes: number; open: boolean; forgotten: boolean; inMethod: string; outMethod: string | null; note: string | null; editedBy: string | null }
interface Total { staffId: string; name: string; minutes: number; spells: number; open: boolean; forgotten: number }
interface Person { id: string; code: string; name: string; role: string; active: boolean; card: string | null }

const TZ = "Asia/Singapore";
const dayKey = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ });
const dayOf = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: TZ });
const timeOf = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
const hours = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
const METHOD: Record<string, string> = { card: "card", pin: "code and PIN", telegram: "Telegram", manager: "a manager" };
/** Monday of this week, in Singapore. */
const weekStart = () => { const now = new Date(); const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(now.toLocaleDateString("en-US", { weekday: "short", timeZone: TZ })); return dayKey(now.getTime() - Math.max(0, wd) * 24 * 3600_000); };
/** A time of day ("17:30") on the day a spell started, as a moment. A time earlier than the start means the next day. */
const atTime = (startMs: number, hhmm: string): number | null => { const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim()); if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null; const t = new Date(`${dayKey(startMs)}T${m[1]!.padStart(2, "0")}:${m[2]}:00+08:00`).getTime(); return t < startMs ? t + 24 * 3600_000 : t; };

/**
 * The timesheet: who worked when, and how long, from the card taps and PIN punches at the tills. Hours are counted per spell of work;
 * a spell nobody clocked out of is flagged as forgotten rather than counted, until a manager puts the time in with a reason.
 */
export function Timesheet({ config }: { config: BusinessConfig }) {
  const staff = useStaff();
  const [from, setFrom] = useState(weekStart());
  const [to, setTo] = useState(dayKey(Date.now()));
  const [data, setData] = useState<{ entries: Entry[]; totals: Total[] } | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [msg, setMsg] = useState("");
  const [fix, setFix] = useState<{ id: string; time: string; note: string } | null>(null);
  const [cardFor, setCardFor] = useState<{ id: string; value: string } | null>(null);
  const canFix = hasPerm(staff, "shift.approve");

  const load = useCallback(async () => {
    const r = await staffFetch(`/api/time/entries?from=${from}&to=${to >= from ? to : from}`);
    if (!("res" in r)) return setMsg(r.problem);
    if (!r.res.ok) return setMsg("The timesheet could not be loaded.");
    setData((await r.res.json()) as { entries: Entry[]; totals: Total[] });
    const p = await staffFetch("/api/staff");
    if ("res" in p && p.res.ok) setPeople(((await p.res.json()) as { staff: Person[] }).staff);
  }, [from, to]);
  useEffect(() => { void load(); }, [load]);

  async function saveFix(e: Entry) {
    if (!fix) return;
    const out = atTime(e.clockIn, fix.time);
    if (out === null) return setMsg("Enter the time as hours and minutes, like 17:30.");
    if (fix.note.trim().length < 3) return setMsg("Say why the time is being changed.");
    const r = await staffFetch(`/api/time/entries/${e.id}`, { method: "PUT", body: { clockOut: out, note: fix.note.trim() } });
    if (!("res" in r)) return setMsg(r.problem);
    if (!r.res.ok) return setMsg(r.res.status === 403 ? "You are not allowed to change the timesheet." : "That time is not possible. It must be after the clock-in, within 36 hours, and not in the future.");
    setFix(null); setMsg("Saved."); void load();
  }
  async function saveCard(p: Person, value: string | null) {
    const r = await staffFetch(`/api/staff/${p.id}/card`, { method: "PUT", body: { card: value } });
    if (!("res" in r)) return setMsg(r.problem);
    const j = (await r.res.json().catch(() => ({}))) as { message?: string };
    if (!r.res.ok) return setMsg(j.message ?? (r.res.status === 403 ? "Only the owner gives out cards." : "That card could not be saved."));
    setCardFor(null); setMsg(value ? `Card saved for ${p.name}.` : `Card removed from ${p.name}.`); void load();
  }
  const rows = (): Array<Array<string | number>> => [["Name", "Date", "In", "Out", "Hours", "Clocked in by", "Note"], ...(data?.entries ?? []).map((e) => [e.name, dayKey(e.clockIn), timeOf(e.clockIn), e.clockOut ? timeOf(e.clockOut) : e.forgotten ? "not clocked out" : "still in", e.forgotten ? "" : hours(e.minutes), METHOD[e.inMethod] ?? e.inMethod, e.note ?? ""])];
  const name = `timesheet_${from}_to_${to}`;

  if (!staff) return null;
  return (
    <div className="rp">
      <div className="rp-card">
        <h3>Timesheet</h3>
        <p className="muted">Hours from clocking in and out at the tills (Sign-in screen → Other ways to sign in → Clock in / out).</p>
        <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <label className="muted">From <input type="date" aria-label="From" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="muted">To <input type="date" aria-label="To" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
          <span className="rp-actions" style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <button className="secondary sm" onClick={() => downloadText(`${name}.csv`, toCsv(rows()))}>Export CSV</button>
            <button className="secondary sm" onClick={() => downloadBytes(`${name}.pdf`, tablePdf({ title: `${config.name} - Timesheet`, subtitle: `${config.outletName} - ${from} to ${to}`, rows: rows() }))}>Export PDF</button>
          </span>
        </div>
        {msg && <p className="flash" role="status">{msg}</p>}
      </div>

      <div className="rp-card">
        <h3>Hours per person</h3>
        {!data ? <p className="muted">Loading…</p> : data.totals.length === 0 ? <p className="muted">Nobody clocked in on these dates.</p> : (
          <table className="rp-table" aria-label="Hours per person"><thead><tr><th>Name</th><th className="r">Hours</th><th className="r">Spells</th><th>Now</th></tr></thead>
            <tbody>{data.totals.map((t) => <tr key={t.staffId}><td>{t.name}</td><td className="r"><b>{hours(t.minutes)}</b></td><td className="r">{t.spells}</td><td>{t.open ? "Clocked in" : ""}{t.forgotten ? `${t.open ? " · " : ""}${t.forgotten} not clocked out` : ""}</td></tr>)}</tbody>
          </table>
        )}
      </div>

      <div className="rp-card">
        <h3>Each spell</h3>
        {data && data.entries.length === 0 && <p className="muted">Nothing on these dates.</p>}
        {data && data.entries.length > 0 && (
          <table className="rp-table" aria-label="Spells of work"><thead><tr><th>Name</th><th>Day</th><th>In</th><th>Out</th><th className="r">Hours</th><th /></tr></thead>
            <tbody>
              {[...data.entries].reverse().map((e) => (
                <tr key={e.id}>
                  <td>{e.name}</td><td>{dayOf(e.clockIn)}</td><td>{timeOf(e.clockIn)} <small className="muted">{METHOD[e.inMethod] ?? e.inMethod}</small></td>
                  <td>{e.clockOut ? <>{timeOf(e.clockOut)}{e.editedBy ? <small className="muted"> · set by {e.editedBy}: {e.note}</small> : null}</> : e.forgotten ? <b style={{ color: "#b00020" }}>Not clocked out</b> : "Still in"}</td>
                  <td className="r">{e.forgotten ? "—" : hours(e.minutes)}</td>
                  <td>
                    {canFix && fix?.id !== e.id && <button className="secondary sm" aria-label={`Set the clock-out for ${e.name}`} onClick={() => { setMsg(""); setFix({ id: e.id, time: e.clockOut ? timeOf(e.clockOut) : "", note: "" }); }}>{e.clockOut ? "Change" : "Set clock-out"}</button>}
                    {fix?.id === e.id && (
                      <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                        <input aria-label="Clock-out time" placeholder="17:30" style={{ width: 80 }} value={fix.time} onChange={(x) => setFix({ ...fix, time: x.target.value })} />
                        <input aria-label="Reason" placeholder="Why" style={{ width: 180 }} maxLength={200} value={fix.note} onChange={(x) => setFix({ ...fix, note: x.target.value })} />
                        <button className="primary sm" onClick={() => void saveFix(e)}>Save</button><button className="secondary sm" onClick={() => setFix(null)}>Cancel</button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="rp-card">
        <h3>Cards</h3>
        <p className="muted">Each person's card for the reader at the till. To add one, press Give a card, then hold the card to the reader (or type its number). {staff.role === "owner" ? "" : "Only the owner gives out cards."}</p>
        {people.filter((p) => p.active).map((p) => (
          <div className="arr-row" key={p.id}>
            <label style={{ flex: 1 }}>{p.name} <span className="muted">· {p.role} · {p.card ? `card ${p.card}` : "no card"}</span></label>
            {staff.role === "owner" && cardFor?.id !== p.id && <button className="secondary sm" aria-label={`Give a card to ${p.name}`} onClick={() => { setMsg(""); setCardFor({ id: p.id, value: "" }); }}>{p.card ? "Change card" : "Give a card"}</button>}
            {staff.role === "owner" && p.card && cardFor?.id !== p.id && <button className="secondary sm" aria-label={`Remove the card from ${p.name}`} onClick={() => void saveCard(p, null)}>Remove</button>}
            {cardFor?.id === p.id && (
              <form className="row" style={{ gap: 6 }} onSubmit={(x) => { x.preventDefault(); if (cardFor.value.trim()) void saveCard(p, cardFor.value.trim()); }}>
                <input aria-label="Card number" autoFocus autoComplete="off" placeholder="Hold the card to the reader" value={cardFor.value} onChange={(x) => setCardFor({ ...cardFor, value: x.target.value })} />
                <button className="primary sm" disabled={!cardFor.value.trim()}>Save</button><button type="button" className="secondary sm" onClick={() => setCardFor(null)}>Cancel</button>
              </form>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
