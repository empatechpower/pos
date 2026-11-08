import { createConnection } from "node:net";

/**
 * Delivers queued print jobs to network printers. This is the reference for what the hub app does:
 * claim jobs with the device token, write the bytes to the printer's raw port (usually 9100), and
 * report done or failed. The server keeps the jobs and retries, so a printer that is off or out of
 * paper loses nothing.
 *
 * Note: a raw TCP write only proves the bytes reached the printer. Out-of-paper and cover-open states
 * need the printer's status commands, which are not queried here.
 */
export interface AgentJob {
  id: string;
  docType: string;
  attempt: number;
  printer: { id: string; name: string; host: string; port: number };
  payloadBase64: string;
}

export type Sender = (host: string, port: number, bytes: Buffer) => Promise<void>;

export const sendRaw: Sender = (host, port, bytes) =>
  new Promise((resolve, reject) => {
    const sock = createConnection({ host, port, timeout: 5000 });
    sock.once("timeout", () => sock.destroy(new Error(`timed out talking to ${host}:${port}`)));
    sock.once("error", reject);
    sock.once("connect", () => sock.end(bytes));
    sock.once("close", (hadError) => !hadError && resolve());
  });

export interface AgentOptions {
  baseUrl: string;
  deviceToken: string;
  send?: Sender;
}

/**
 * Tell the server how a job went. If this call is lost after a successful print, the lease runs out
 * and the job prints a second time, so it is retried and any final failure is shouted about.
 */
async function report(baseUrl: string, token: string, jobId: string, outcome: "done" | "failed", error?: string): Promise<void> {
  const body = outcome === "failed" ? JSON.stringify({ error: error ?? "unknown error" }) : undefined;
  const headers: Record<string, string> = { "x-device-token": token, ...(body ? { "content-type": "application/json" } : {}) };
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/api/print/jobs/${jobId}/${outcome}`, { method: "POST", headers, body });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
      if (res.status === 404) return; // the server no longer has it leased: nothing to report
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 200 * attempt));
  }
  console.error(`print agent: could not report job ${jobId} as ${outcome} (${last}). It may print again.`);
}

/** One pass: claim, deliver each job in order, report. Returns how many were delivered. */
export async function runAgentOnce({ baseUrl, deviceToken, send = sendRaw }: AgentOptions): Promise<{ delivered: number; failed: number }> {
  const headers = { "content-type": "application/json", "x-device-token": deviceToken };
  const res = await fetch(`${baseUrl}/api/print/claim`, { method: "POST", headers, body: JSON.stringify({ limit: 10 }) });
  if (!res.ok) throw new Error(`claim failed (${res.status})`);
  const { jobs } = (await res.json()) as { jobs: AgentJob[] };
  let delivered = 0;
  let failed = 0;
  // A printer that failed is skipped for the rest of this pass, so its later jobs do not jump the queue.
  const broken = new Set<string>();
  for (const job of jobs) {
    if (broken.has(job.printer.id)) {
      await report(baseUrl, deviceToken, job.id, "failed", "earlier job to this printer failed");
      failed++;
      continue;
    }
    try {
      await send(job.printer.host, job.printer.port, Buffer.from(job.payloadBase64, "base64"));
      await report(baseUrl, deviceToken, job.id, "done");
      delivered++;
    } catch (err) {
      broken.add(job.printer.id);
      await report(baseUrl, deviceToken, job.id, "failed", err instanceof Error ? err.message : String(err));
      failed++;
    }
  }
  return { delivered, failed };
}

export function startAgent(opts: AgentOptions, everyMs = 2000): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await runAgentOnce(opts);
    } catch (err) {
      console.error("print agent:", err instanceof Error ? err.message : err);
    }
    if (!stopped) timer = setTimeout(() => void tick(), everyMs);
  };
  let timer = setTimeout(() => void tick(), 0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
