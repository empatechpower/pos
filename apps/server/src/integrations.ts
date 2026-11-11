import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Outside services the shop can use: Google and Microsoft sign-in, a text-message number for phone sign-in,
 * and Stripe for card and PayNow. Each is optional and is switched on only by its settings; with none set the
 * shop still works (email sign-in, pay at the counter). Settings come from the environment (see the README).
 */
export interface Integrations {
  /** The address customers reach the shop at, e.g. https://order.example.com (no trailing slash). Provider redirects come back here. */
  publicUrl: string;
  google?: { clientId: string; clientSecret: string };
  microsoft?: { clientId: string; clientSecret: string };
  /** Reverse-SMS sign-in: the number customers text, and the secret the SMS provider's webhook must present. */
  sms?: { number: string; webhookSecret: string };
  stripe?: { secretKey: string; webhookSecret: string };
  /** Replaceable in tests. */
  fetch?: typeof fetch;
}

export function loadIntegrations(env: NodeJS.ProcessEnv): Integrations {
  const pair = (id?: string, secret?: string) => (id && secret ? { clientId: id, clientSecret: secret } : undefined);
  return {
    publicUrl: (env.PUBLIC_URL ?? "http://localhost:5173").replace(/\/+$/, ""),
    google: pair(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
    microsoft: pair(env.MICROSOFT_CLIENT_ID, env.MICROSOFT_CLIENT_SECRET),
    sms: env.SMS_RECEIVE_NUMBER && env.SMS_WEBHOOK_SECRET ? { number: env.SMS_RECEIVE_NUMBER, webhookSecret: env.SMS_WEBHOOK_SECRET } : undefined,
    stripe: env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET ? { secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET } : undefined,
  };
}

const b64url = (b: Buffer) => b.toString("base64url");
export const newVerifier = () => b64url(randomBytes(32));
export const challengeFor = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());
export const newState = () => b64url(randomBytes(24));

// ---- OAuth (authorization code + PKCE) --------------------------------------------------------------

export type OAuthProvider = "google" | "microsoft";

const ENDPOINTS: Record<OAuthProvider, { auth: string; token: string; userinfo: string }> = {
  google: { auth: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token", userinfo: "https://openidconnect.googleapis.com/v1/userinfo" },
  microsoft: { auth: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", token: "https://login.microsoftonline.com/common/oauth2/v2.0/token", userinfo: "https://graph.microsoft.com/oidc/userinfo" },
};

export const redirectUri = (i: Integrations, p: OAuthProvider) => `${i.publicUrl}/api/shop/auth/oauth/${p}/callback`;

export function authorizeUrl(i: Integrations, p: OAuthProvider, state: string, verifier: string): string {
  const c = i[p]!;
  const q = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: redirectUri(i, p),
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challengeFor(verifier),
    code_challenge_method: "S256",
    ...(p === "google" ? { prompt: "select_account" } : { prompt: "select_account", response_mode: "query" }),
  });
  return `${ENDPOINTS[p].auth}?${q}`;
}

export interface ProviderProfile {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

/** Trade the one-time code for the person's profile. Any failure is null: the sign-in is simply refused. */
export async function fetchProfile(i: Integrations, p: OAuthProvider, code: string, verifier: string): Promise<ProviderProfile | null> {
  const f = i.fetch ?? fetch;
  const c = i[p]!;
  try {
    const tok = await f(ENDPOINTS[p].token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: "authorization_code", code, redirect_uri: redirectUri(i, p), code_verifier: verifier }),
    });
    if (!tok.ok) return null;
    const accessToken = ((await tok.json()) as { access_token?: string }).access_token;
    if (!accessToken) return null;
    const ui = await f(ENDPOINTS[p].userinfo, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!ui.ok) return null;
    const u = (await ui.json()) as { sub?: string; email?: string; email_verified?: boolean | string; name?: string };
    if (!u.sub) return null;
    // Only Google states whether an email is verified. A Microsoft work-account email can be set by the tenant's
    // admin to anything, so it is never trusted to join an existing account.
    const verified = p === "google" && (u.email_verified === true || u.email_verified === "true");
    return { subject: String(u.sub), email: typeof u.email === "string" ? u.email : null, emailVerified: verified, name: typeof u.name === "string" ? u.name : null };
  } catch {
    return null;
  }
}

// ---- Stripe (plain HTTPS, no SDK) -------------------------------------------------------------------

/** Create a hosted payment page for an order. Returns where to send the customer, and Stripe's id for it. */
export async function createStripeCheckout(
  i: Integrations,
  o: { orderId: string; queueNumber: string; amountCents: number; method: "card" | "paynow"; returnUrl: string; description: string },
): Promise<{ url: string; sessionId: string } | null> {
  const s = i.stripe;
  if (!s) return null;
  const f = i.fetch ?? fetch;
  const body = new URLSearchParams({
    mode: "payment",
    "payment_method_types[0]": o.method,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "sgd",
    "line_items[0][price_data][unit_amount]": String(o.amountCents),
    "line_items[0][price_data][product_data][name]": o.description.slice(0, 120),
    success_url: o.returnUrl,
    cancel_url: o.returnUrl,
    client_reference_id: o.orderId,
    "metadata[orderId]": o.orderId,
    "metadata[method]": o.method,
  });
  const res = await f("https://api.stripe.com/v1/checkout/sessions", { method: "POST", headers: { authorization: `Bearer ${s.secretKey}`, "content-type": "application/x-www-form-urlencoded", "idempotency-key": `${o.orderId}:${o.method}:${o.amountCents}:${Math.floor(Date.now() / 600_000)}` }, body });
  if (!res.ok) return null;
  const j = (await res.json()) as { url?: string; id?: string };
  return j.url && j.id ? { url: j.url, sessionId: j.id } : null;
}

/** Check a Stripe webhook's signature (HMAC-SHA256 over "timestamp.body", within five minutes). */
export function verifyStripeSignature(rawBody: Buffer, header: string | undefined, secret: string, now = Date.now()): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > 300) return false;
  const want = createHmac("sha256", secret).update(`${parts.t}.`).update(rawBody).digest("hex");
  // Stripe may send several v1 values while a secret is being rotated.
  return header
    .split(",")
    .filter((kv) => kv.startsWith("v1="))
    .some((kv) => {
      const got = Buffer.from(kv.slice(3), "hex");
      const exp = Buffer.from(want, "hex");
      return got.length === exp.length && timingSafeEqual(got, exp);
    });
}

/** Compare secrets without leaking where they differ. */
export const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
