import { useEffect, useState } from "react";
import { loadFloor, saveFloor, useFloor, type FloorSettings, type FloorTable } from "../floor";

/** One table to a line: "Table 5" or "Table 5, 4" (the number after the comma is how many seats). */
const toText = (s: FloorSettings["sections"][number]) => s.tables.map((t) => (t.seats ? `${t.name}, ${t.seats}` : t.name)).join("\n");
/** Editing the text keeps where a table sits and its shape, matched by name. */
const fromText = (text: string, sid: string, old: FloorTable[] = []) => text.split("\n").map((l) => l.trim()).filter(Boolean).map((l, i) => { const [name, seats] = l.split(",").map((x) => x.trim()); const n = Number(seats); const was = old.find((t) => t.name === name); return { id: was?.id ?? `${sid}-${i}`, name: name!, ...(Number.isInteger(n) && n > 0 ? { seats: n } : {}), ...(was?.shape ? { shape: was.shape } : {}), ...(was?.x !== undefined && was?.y !== undefined ? { x: was.x, y: was.y } : {}) }; });

/** For managers: the sections and tables of the floor. The table-service switches are under Merchant settings. */
export function FloorPanel() {
  const floor = useFloor();
  const [sections, setSections] = useState(() => floor.sections.map((s) => ({ id: s.id, name: s.name, text: toText(s) })));
  const [msg, setMsg] = useState("");
  useEffect(() => { void loadFloor().then(() => undefined); }, []);
  useEffect(() => { setSections(floor.sections.map((s) => ({ id: s.id, name: s.name, text: toText(s) }))); }, [floor]);
  const save = async (patch: Partial<FloorSettings>) => { const e = await saveFloor(patch); setMsg(e ?? "Saved."); };
  return (
    <section className="e2e-card" style={{ marginTop: 16 }}>
      <h3>Floor and tables</h3>
      <p className="muted">The sections and tables the Table Map shows. One table to a line; add the number of seats after a comma. Bar tabs do not need to be listed.</p>
      {sections.map((s, i) => (
        <div key={s.id} style={{ marginBottom: 10 }}>
          <input aria-label={`Section ${i + 1} name`} value={s.name} onChange={(e) => setSections((c) => c.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <textarea aria-label={`Tables in ${s.name}`} rows={5} style={{ width: "100%", marginTop: 4 }} value={s.text} onChange={(e) => setSections((c) => c.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
          {sections.length > 1 && <button className="secondary sm" onClick={() => setSections((c) => c.filter((_, j) => j !== i))}>Remove section</button>}
        </div>
      ))}
      <div className="row">
        <button className="secondary sm" onClick={() => setSections((c) => [...c, { id: `s${Date.now().toString(36)}`, name: "New section", text: "" }])}>Add a section</button>
        <button className="primary sm" onClick={() => void save({ sections: sections.map((s) => ({ id: s.id, name: s.name, tables: fromText(s.text, s.id, floor.sections.find((x) => x.id === s.id)?.tables) })) })}>Save the floor</button>
      </div>
      {msg && <div className="flash" role="status">{msg}</div>}
    </section>
  );
}
