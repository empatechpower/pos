// Loaded by the app's service worker (vite.config.ts, workbox importScripts).
// Copies of the app from before 28 Nov 2026 wait for an "Update now" tap that some phones never showed, and reloading never replaced
// them. When a new version installs, it asks every open page whether it handles updates itself (src/main.tsx answers). A page that
// does not answer is one of those old copies, so the new version takes over at once: that page keeps running until it is next opened
// or reloaded, and then it is the new version (the order on screen is kept on the device). Pages that answer keep the usual rule
// (src/pwaUpdate.ts): the till waits while it is in use.
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const answers = await Promise.all(pages.map((page) => new Promise((resolve) => {
      const ch = new MessageChannel();
      const timer = setTimeout(() => resolve(false), 3000);
      ch.port1.onmessage = () => { clearTimeout(timer); resolve(true); };
      try { page.postMessage({ type: "rezein-handles-updates?" }, [ch.port2]); } catch { clearTimeout(timer); resolve(false); }
    })));
    if (answers.some((a) => !a)) await self.skipWaiting();
  })());
});
