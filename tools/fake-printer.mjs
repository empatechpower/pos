#!/usr/bin/env node
/**
 * A pretend network receipt/kitchen printer, for testing without a real one.
 *
 *   node tools/fake-printer.mjs            (listens on port 9100)
 *   node tools/fake-printer.mjs 9101
 *
 * Add it in the POS under Printers like a real printer: use this computer's address on the Wi-Fi and the port above.
 * Anything the hub sends is shown here as the text a printer would print, with a line where the paper would be cut.
 * It only understands plain-text tickets (leave "raster" off for this printer).
 */
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";

const port = Number(process.argv[2]) || 9100;
const ips = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
let n = 0;

createServer((sock) => {
  const chunks = [];
  const id = ++n;
  sock.on("data", (d) => chunks.push(d));
  sock.on("error", () => {});
  sock.on("close", () => {
    const b = Buffer.concat(chunks);
    const cut = b.includes(Buffer.from([0x1d, 0x56])) || b.includes(Buffer.from([0x1b, 0x6d])) || b.includes(Buffer.from([0x1b, 0x69]));
    const drawer = b.includes(Buffer.from([0x1b, 0x70]));
    const text = b.toString("latin1").replace(/\x1b@/g, "").replace(/\x1d\x56[\x00-\x7f]{1,2}/g, "").replace(/\x1b[t!\-aEGMdJp3-].?/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(/\r/g, "");
    const raster = b.includes(Buffer.from([0x1d, 0x76, 0x30]));
    console.log(`\n┌── ticket ${id} · ${b.length} bytes · ${new Date().toLocaleTimeString("en-GB")} ${"─".repeat(20)}`);
    if (raster) console.log("│ (this one is a picture, not text: the printer is set to raster mode)");
    else console.log(text.split("\n").map((l) => `│ ${l}`).join("\n"));
    console.log(`└── ${cut ? "✂  paper cut" : "(no cut command)"}${drawer ? " · cash drawer opened" : ""} ${"─".repeat(20)}`);
  });
}).listen(port, "0.0.0.0", () => {
  console.log(`Pretend printer is waiting on port ${port}.`);
  console.log(`In the POS (Printers), add a printer with address: ${ips.join(" or ") || "(this computer's Wi-Fi address)"}  port: ${port}`);
  console.log("If your Mac asks to allow incoming connections, choose Allow. Press Ctrl+C to stop.\n");
});
