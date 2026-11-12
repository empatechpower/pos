#!/usr/bin/env node
/**
 * Rezein print hub. One file, no installs: needs only Node 18 or newer.
 *
 *   node hub.mjs setup <shop-address> <enrollment-code> ["Kitchen tablet"]   (once, to link this device)
 *   node hub.mjs test <printer-ip> [port]                                    (send a test page straight to a printer)
 *   node hub.mjs run                                                         (the hub itself; this is the default)
 *   node hub.mjs status                                                      (is it linked, and can it reach the shop?)
 *
 * What it does: asks the shop's server for print jobs, writes each one to its printer's network port (9100),
 * and tells the server how it went. The server keeps every job, so if this device, the printer or the internet
 * is down for a while nothing is lost. If a job is sent but the connection breaks before the printer confirms,
 * the server marks it "print unconfirmed" for a person to check. It is never printed twice on its own.
 */
import { createConnection } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const VERSION = "0.1.0";
const CONFIG_FILE = process.env.HUB_CONFIG || join(homedir(), ".rezein-hub.json");
const stamp = () => new Date().toLocaleTimeString("en-GB");
const log = (...a) => console.log(`[${stamp()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The connection was made and then broke, so the printer may already have the job. */
export class AmbiguousDelivery extends Error {
  ambiguous = true;
}

/** Write bytes to a printer's raw port. */
export const sendRaw = (host, port, bytes) =>
  new Promise((resolve, reject) => {
    let connected = false;
    const fail = (e) => reject(connected ? new AmbiguousDelivery(e.message) : e);
    const sock = createConnection({ host, port, timeout: 5000 });
    sock.once("timeout", () => sock.destroy(new Error(`timed out talking to ${host}:${port}`)));
    sock.once("error", fail);
    sock.once("connect", () => {
      connected = true;
      sock.end(Buffer.from(bytes));
    });
    sock.once("close", (hadError) => !hadError && resolve());
  });

/** A short receipt that proves the printer, the network and the hub all work: initialise, text, feed, cut. */
export const testPage = () =>
  Buffer.concat([
    Buffer.from([0x1b, 0x40]),
    Buffer.from(`Rezein print hub\nTest page ${new Date().toLocaleString("en-GB")}\nIf you can read this, printing works.\n\n\n\n`, "ascii"),
    Buffer.from([0x1d, 0x56, 0x42, 0x00]),
  ]);

/** Tell the server how a job went. A lost report leaves the job leased; the server then parks it as unconfirmed. */
async function report(baseUrl, token, jobId, outcome, error, ambiguous = false) {
  const body = outcome === "failed" ? JSON.stringify({ error: error ?? "unknown error", ...(ambiguous ? { ambiguous: true } : {}) }) : undefined;
  const headers = { "x-device-token": token, ...(body ? { "content-type": "application/json" } : {}) };
  let last = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/api/print/jobs/${jobId}/${outcome}`, { method: "POST", headers, body });
      if (res.ok) return true;
      last = `HTTP ${res.status}`;
      if (res.status === 404) return true; // the server no longer has it leased: nothing to report
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(300 * attempt);
  }
  log(`!! could not tell the server job ${jobId} was ${outcome} (${last}). It will show as "print unconfirmed" if it printed.`);
  return false;
}

/** Deliver one printer's jobs in order. After a failure the rest of that printer's jobs wait for the server's retry. */
async function deliver(baseUrl, token, jobs, send) {
  let delivered = 0;
  let failed = 0;
  let broken = false;
  for (const job of jobs) {
    if (broken) {
      await report(baseUrl, token, job.id, "failed", "an earlier job to this printer failed");
      failed++;
      continue;
    }
    try {
      await send(job.printer.host, job.printer.port, Buffer.from(job.payloadBase64, "base64"));
      await report(baseUrl, token, job.id, "done");
      delivered++;
      log(`printed ${job.docType} on ${job.printer.name}`);
    } catch (err) {
      broken = true;
      const msg = err instanceof Error ? err.message : String(err);
      await report(baseUrl, token, job.id, "failed", msg, err instanceof AmbiguousDelivery);
      failed++;
      log(`!! ${job.docType} for ${job.printer.name} (${job.printer.host}) failed: ${msg}`);
    }
  }
  return { delivered, failed };
}

/** One pass: claim jobs, send them (different printers at the same time), report. */
export async function runOnce({ baseUrl, token, send = sendRaw }) {
  const res = await fetch(`${baseUrl}/api/print/claim`, { method: "POST", headers: { "content-type": "application/json", "x-device-token": token }, body: JSON.stringify({ limit: 10 }) });
  if (res.status === 401) throw Object.assign(new Error("this hub is not linked (or was removed). Run setup again."), { removed: true });
  if (!res.ok) throw new Error(`the server answered ${res.status}`);
  const { jobs } = await res.json();
  const byPrinter = new Map();
  for (const j of jobs) byPrinter.set(j.printer.id, [...(byPrinter.get(j.printer.id) ?? []), j]);
  const results = await Promise.all([...byPrinter.values()].map((group) => deliver(baseUrl, token, group, send)));
  return results.reduce((a, r) => ({ delivered: a.delivered + r.delivered, failed: a.failed + r.failed }), { delivered: 0, failed: 0 });
}

const readConfig = () => (existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, "utf8")) : null);

async function setup([address, code, ...nameParts]) {
  if (!address || !code) return console.error('Usage: node hub.mjs setup <shop-address> <enrollment-code> ["Kitchen tablet"]');
  const baseUrl = address.replace(/\/+$/, "").replace(/^(?!https?:\/\/)/, "https://");
  const name = nameParts.join(" ") || `Hub ${hostname()}`;
  const res = await fetch(`${baseUrl}/api/devices/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code.trim(), name }) }).catch((e) => ({ ok: false, status: 0, error: e }));
  if (!res.ok) {
    const why = res.status === 401 ? "the code is wrong, used already, or expired (they last a short time: ask for a new one)" : res.status === 429 ? "too many tries; wait a few minutes" : res.status === 0 ? `could not reach ${baseUrl}` : `the server answered ${res.status}`;
    return console.error(`Setup failed: ${why}.`);
  }
  const { token, deviceId } = await res.json();
  writeFileSync(CONFIG_FILE, JSON.stringify({ baseUrl, token, deviceId, name }, null, 2), { mode: 0o600 });
  console.log(`Linked as "${name}". Saved to ${CONFIG_FILE}.\nNow start it with:  node hub.mjs run`);
}

async function status() {
  const c = readConfig();
  if (!c) return console.log("Not linked yet. Run:  node hub.mjs setup <shop-address> <enrollment-code>");
  console.log(`Linked as "${c.name}" to ${c.baseUrl}`);
  try {
    const r = await fetch(`${c.baseUrl}/api/health`);
    console.log(r.ok ? "The shop's server is reachable." : `The shop's server answered ${r.status}.`);
  } catch (e) {
    console.log(`Cannot reach the shop's server: ${e.message}`);
  }
}

async function test([host, port]) {
  if (!host) return console.error("Usage: node hub.mjs test <printer-ip> [port]");
  try {
    await sendRaw(host, Number(port) || 9100, testPage());
    console.log(`Sent a test page to ${host}. Check the printer: paper should come out and cut.`);
  } catch (e) {
    console.error(`Could not print to ${host}: ${e.message}\nCheck the printer is on, on the same network as this device, and that the IP address is right.`);
  }
}

async function run() {
  const c = readConfig();
  if (!c) return console.error("Not linked yet. Run:  node hub.mjs setup <shop-address> <enrollment-code>");
  process.on("uncaughtException", (e) => { console.error("crashed:", e); process.exit(1); }); // the restart script brings it back
  process.on("unhandledRejection", (e) => { console.error("crashed:", e); process.exit(1); });
  log(`Rezein print hub ${VERSION} running as "${c.name}" for ${c.baseUrl}. Leave this open.`);
  let online = null;
  let wait = 0;
  for (;;) {
    try {
      const r = await runOnce({ baseUrl: c.baseUrl, token: c.token });
      if (online !== true) log("connected to the shop");
      online = true;
      wait = 0;
      if (r.failed) await sleep(3000); // the server retries failed jobs on its own schedule; do not hammer the printer
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (online !== false) log(`!! cannot reach the shop: ${msg}. Will keep trying; nothing is lost.`);
      online = false;
      wait = err?.removed ? 60_000 : Math.min(wait ? wait * 2 : 2000, 30_000);
      await sleep(wait);
      continue;
    }
    await sleep(2000);
  }
}

const [cmd = "run", ...rest] = process.argv.slice(2);
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const table = { setup, test, status, run };
  if (!table[cmd]) console.error("Commands: setup, test, run, status");
  else await table[cmd](rest);
}
