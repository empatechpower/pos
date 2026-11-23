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
  /** Reverse-SMS sign-in: the number customers text, and the secret the SMS provider's webhook must present (empty when only the Rezein app on a tablet receives the texts). */
  sms?: { number: string; webhookSecret: string };
  stripe?: { secretKey: string; webhookSecret: string };
  /** YeahPay (Singapore acquirer): PayNow QR and hosted card checkout. Preferred over Stripe when both are set. */
  yeahpay?: { appId: string; apiKey: string; merchantId: string; baseUrl: string };
  /** The Telegram bot staff use to manage prices. The webhook secret proves a message really came from Telegram. */
  telegram?: { token: string; webhookSecret: string; adminIds?: string[]; managerIds?: string[] };
  /** Email through Resend's web API (HTTPS, so it works where SMTP ports are blocked). */
  mail?: { apiKey: string; from: string };
  /** Replaceable in tests. */
  fetch?: typeof fetch;
}

export const YEAHPAY_LIVE = "https://open-api.yeahpay.sg/acceptance/acceptance-open-api";
export const YEAHPAY_TEST = "https://t-acquire-business.lepass.cn/gw/abroad-business-acceptance-open-api";

export function loadIntegrations(env: NodeJS.ProcessEnv): Integrations {
  const pair = (id?: string, secret?: string) => (id && secret ? { clientId: id, clientSecret: secret } : undefined);
  return {
    publicUrl: (env.PUBLIC_URL ?? "http://localhost:5173").replace(/\/+$/, ""),
    google: pair(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
    microsoft: pair(env.MICROSOFT_CLIENT_ID, env.MICROSOFT_CLIENT_SECRET),
    // The number customers text. Texts reach us from the Rezein app on a tablet with a SIM in it (no secret needed), or from an SMS provider's webhook (needs the secret).
    sms: env.SMS_RECEIVE_NUMBER?.trim() ? { number: env.SMS_RECEIVE_NUMBER.trim(), webhookSecret: env.SMS_WEBHOOK_SECRET?.trim() ?? "" } : undefined,
    telegram: env.TELEGRAM_BOT_TOKEN?.trim() && env.TELEGRAM_WEBHOOK_SECRET?.trim() ? { token: env.TELEGRAM_BOT_TOKEN.trim().replace(/^bot/i, ""), webhookSecret: env.TELEGRAM_WEBHOOK_SECRET.trim(), adminIds: (env.TELEGRAM_ADMIN_IDS ?? "").split(",").map((x) => x.trim()).filter((x) => /^\d+$/.test(x)), managerIds: (env.TELEGRAM_MANAGER_IDS ?? "").split(",").map((x) => x.trim()).filter((x) => /^\d+$/.test(x)) } : undefined,
    mail: env.RESEND_API_KEY && env.MAIL_FROM ? { apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM } : undefined,
    yeahpay: env.YEAHPAY_APP_ID?.trim() && env.YEAHPAY_API_KEY?.trim() && env.YEAHPAY_MERCHANT_ID?.trim()
      ? { appId: env.YEAHPAY_APP_ID.trim(), apiKey: env.YEAHPAY_API_KEY.trim(), merchantId: env.YEAHPAY_MERCHANT_ID.trim(), baseUrl: (env.YEAHPAY_BASE_URL?.trim() || (env.YEAHPAY_ENV === "test" ? YEAHPAY_TEST : YEAHPAY_LIVE)).replace(/\/+$/, "") }
      : undefined,
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

/** Give a payment back in full. Stripe remembers the key, so asking twice refunds once. True when Stripe accepted it. */
export async function createStripeRefund(i: Integrations, o: { paymentIntent: string; key: string }): Promise<boolean> {
  const s = i.stripe;
  if (!s) return false;
  const f = i.fetch ?? fetch;
  try {
    const res = await f("https://api.stripe.com/v1/refunds", {
      method: "POST",
      headers: { authorization: `Bearer ${s.secretKey}`, "content-type": "application/x-www-form-urlencoded", "idempotency-key": o.key },
      body: new URLSearchParams({ payment_intent: o.paymentIntent, "metadata[reason]": "payment_did_not_match_order" }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---- Email (Resend) ---------------------------------------------------------------------------------

/** Send a plain-text email. False when mail is not set up or the provider refuses; callers never show that to the customer. */
export async function sendMail(i: Integrations, m: { to: string; subject: string; text: string }): Promise<boolean> {
  if (!i.mail) return false;
  const f = i.fetch ?? fetch;
  try {
    const res = await f("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${i.mail.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: i.mail.from, to: [m.to], subject: m.subject, text: m.text }),
    });
    return res.ok;
  } catch {
    return false;
  }
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

// ---- YeahPay (plain HTTPS; signing happens here, on the server, never in the browser) -----------------

/**
 * The signature YeahPay wants: Base64(SHA-512(url \n appId \n timestamp \n version \n nonce \n body \n apiKey)).
 * `url` is "/acceptance-open-api" + the API path for calls we make, or the full callback address for callbacks to us.
 * The body must be exactly the text that is sent.
 */
export function yeahpaySignature(o: { url: string; appId: string; timestamp: string; version?: string; nonce: string; body: string; apiKey: string }): string {
  const text = [o.url, o.appId, o.timestamp, o.version ?? "1.0", o.nonce, o.body, o.apiKey].join("\n");
  return createHash("sha512").update(text, "utf8").digest("base64");
}

/** One signed call. Returns YeahPay's `data` when its code is 0, otherwise null (nothing about a failure is shown to customers). */
export async function yeahpayCall<T = Record<string, unknown>>(i: Integrations, path: string, payload: Record<string, unknown>): Promise<T | null> {
  const y = i.yeahpay;
  if (!y) return null;
  const f = i.fetch ?? fetch;
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const nonce = randomBytes(12).toString("hex");
  const signature = yeahpaySignature({ url: `/acceptance-open-api${path}`, appId: y.appId, timestamp, nonce, body, apiKey: y.apiKey });
  try {
    const res = await f(`${y.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": "en-US", version: "1.0", appId: y.appId, timestamp, nonce, algorithm: "SHA-512", signature },
      body,
    });
    const j = (await res.json()) as { code?: number | string; message?: string; data?: T };
    if (!res.ok || String(j.code) !== "0") {
      console.error(`[yeahpay] ${path} refused: HTTP ${res.status} code ${j.code} ${j.message ?? ""}`);
      return null;
    }
    return (j.data ?? {}) as T;
  } catch (e) {
    console.error(`[yeahpay] ${path} failed: ${(e as Error).message}`);
    return null;
  }
}

/**
 * A unique, letters-and-digits reference for one payment attempt (YeahPay wants each order number unique under the merchant).
 * It begins with the order's id without dashes, so a callback that does not carry our own note can still be matched to its order.
 */
export const yeahpayRef = (orderId: string) => `${orderId.replace(/-/g, "")}${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
/** The order id inside a reference made by yeahpayRef (a 32-digit hex id gets its dashes back). */
export const orderIdFromRef = (ref: string): string => (/^[0-9a-f]{32}/i.test(ref) ? ref.slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5") : "");

/**
 * Ask YeahPay for a payment for an order.
 *  - "qr": a PayNow QR. `url` is the text to turn into a QR code (the customer scans it with their banking app).
 *  - "page": YeahPay's hosted checkout (card, Apple/Google Pay, wallets). `url` is where to send the customer.
 * The order number travels in `attach` (QR) or `merchantReferenceNumber` (page) so the callback can find the order again.
 */
export async function createYeahpayPayment(
  i: Integrations,
  o: { orderId: string; amountCents: number; display: "qr" | "page"; returnUrl: string; description: string },
): Promise<{ url: string; ref: string } | null> {
  const y = i.yeahpay;
  if (!y) return null;
  const ref = yeahpayRef(o.orderId);
  const notifyUrl = `${i.publicUrl}/api/shop/yeahpay/notify`;
  if (o.display === "qr") {
    const d = await yeahpayCall<{ tdCode?: string }>(i, "/order/unifiedOrder", {
      payWay: "PayNowPay", merchantId: y.merchantId, thirdOrderId: ref, amount: String(o.amountCents), currency: "SGD", jspayFlag: "NATIVE",
      body: o.description.slice(0, 100), attach: o.orderId, orderExpiration: "600", notifyUrl,
    });
    return d?.tdCode ? { url: d.tdCode, ref } : null;
  }
  const d = await yeahpayCall<{ url?: string }>(i, "/cardOrder/getRedirectUrl", {
    merchantId: y.merchantId, orderId: ref, merchantReferenceNumber: o.orderId, currency: "SGD", amount: String(o.amountCents),
    goodsList: JSON.stringify([{ name: o.description.slice(0, 60), number: 1, currency: "SGD", amount: o.amountCents }]),
    timestamp: String(Date.now()), callback: o.returnUrl, lang: "en", notifyUrl,
  });
  return d?.url ? { url: d.url, ref } : null;
}

/** Give a YeahPay payment back in full (a refund of the whole amount; asking twice with the same key is refused by YeahPay as a duplicate). */
export async function refundYeahpay(i: Integrations, o: { leshuaOrderId: string; key: string }): Promise<boolean> {
  const y = i.yeahpay;
  if (!y) return false;
  const d = await yeahpayCall(i, "/unified/reversalOperation", { sceneType: 1, merchantId: y.merchantId, leshuaOrderId: o.leshuaOrderId, merchantRefundId: o.key, thirdOrderId: o.key });
  return !!d;
}

/**
 * Is this callback really from YeahPay? Same signature rule as a call, with the full address of our callback as the URL
 * and the raw body exactly as received. `now` and a ten-minute window stop an old message being replayed.
 */
export function verifyYeahpayCallback(i: Integrations, o: { url: string; rawBody: string; headers: Record<string, string | string[] | undefined>; now?: number }): boolean {
  const y = i.yeahpay;
  if (!y) return false;
  const h = (k: string) => { const v = o.headers[k.toLowerCase()]; return Array.isArray(v) ? v[0] : v; };
  const timestamp = h("timestamp"), nonce = h("nonce"), got = h("signature");
  if (!timestamp || !nonce || !got || (h("appId") && h("appId") !== y.appId)) return false;
  const ts = Number(timestamp);
  if (Number.isFinite(ts) && Math.abs((o.now ?? Date.now()) - ts) > 10 * 60_000) return false;
  const want = yeahpaySignature({ url: o.url, appId: y.appId, timestamp, version: h("version") ?? "1.0", nonce, body: o.rawBody, apiKey: y.apiKey });
  return sameSecret(want, got);
}
