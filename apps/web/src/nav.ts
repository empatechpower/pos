/**
 * Clean addresses: /shop, /kiosk?outlet=A1, /shop/order/ID, /manager. Links printed before this change (#/shop?table=5) still work:
 * the first load turns them into the clean form.
 */
const EVENT = "routechange";

/** Turn an old #/... address into a clean one, once, before anything reads the location. */
export function adoptLegacyHash(): void {
  const h = location.hash;
  if (!h.startsWith("#/")) return;
  history.replaceState(null, "", h.slice(1));
}

/** The path split into its parts: "/shop/order/ab12" is ["shop", "order", "ab12"]. */
export const routeParts = (): string[] => location.pathname.split("/").filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
export const queryParams = (): URLSearchParams => new URLSearchParams(location.search);

/** Go to another page of the app without reloading, e.g. go("/shop?tab=account"). */
export function go(to: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.dispatchEvent(new Event(EVENT));
}

/** Run `fn` whenever the page address changes (a link, the back button, or go()). Returns a function that stops listening. */
export function onRouteChange(fn: () => void): () => void {
  window.addEventListener("popstate", fn);
  window.addEventListener(EVENT, fn);
  return () => {
    window.removeEventListener("popstate", fn);
    window.removeEventListener(EVENT, fn);
  };
}

const OUTSIDE = /^\/(api\/|about(\/|$)|hub\.mjs|rezein-hub\.apk)/;
/** Links to the app's own pages change the page in place; everything else (the landing page, downloads, other sites) loads normally. */
export function installLinkHandler(): void {
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element | null)?.closest?.("a");
    if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
    const href = a.getAttribute("href");
    if (!href || !href.startsWith("/") || href.startsWith("//") || OUTSIDE.test(href)) return;
    e.preventDefault();
    go(href);
  });
}
