import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Secrets the server must keep to use later (a merchant's mailbox password, a Gmail login token) are stored encrypted, never as written.
 * The key is SECRETS_KEY in the server's environment: 32 bytes, as 64 hex characters or base64. With no key set, nothing secret is saved.
 */
export function secretKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const v = env.SECRETS_KEY?.trim();
  if (!v) return null;
  const k = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, "hex") : Buffer.from(v, "base64");
  return k.length === 32 ? k : null;
}

/** AES-256-GCM: "v1:iv:tag:ciphertext" (base64). Every call uses a fresh random iv, so the same secret never looks the same twice. */
export function seal(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

/** Null when the text was not sealed with this key (wrong key, damaged, or not sealed at all). */
export function unseal(sealed: string, key: Buffer): string | null {
  const [v, iv, tag, ct] = sealed.split(":");
  if (v !== "v1" || !iv || !tag || !ct) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
