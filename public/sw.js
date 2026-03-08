/* filepath: public/sw.js */
/* eslint-disable no-restricted-globals */

const CACHE_VERSION = "mojomaxi-sw-v5";
const PRECACHE_URLS = [
  "/offline",
  "/site.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-512-maskable.png",
  "/apple-touch-icon.png",
  "/favicon.ico",
  "/mojomaxi-social-card.png",
];

const NEVER_CACHE_NAV_PREFIXES = [
  "/admin",
  "/app",
  "/rebalance",
  "/webhooks",
  "/api/",
  "/buy/",
  "/sell/",
  "/auth",
];

const CACHEABLE_NAV_PREFIXES = [
  "/",
  "/help",
  "/privacy",
  "/terms",
  "/transparency",
  "/offline",
  "/community",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      await cache.addAll(PRECACHE_URLS);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => (k === CACHE_VERSION ? Promise.resolve() : caches.delete(k))));
      if (self.registration.navigationPreload) {
        try {
          await self.registration.navigationPreload.enable();
        } catch {}
      }
      await self.clients.claim();
    })()
  );
});

function isSameOrigin(url) {
  try {
    return new URL(url).origin === self.location.origin;
  } catch {
    return false;
  }
}

function isStaticAsset(pathname) {
  return (
    pathname.startsWith("/_next/static/") ||
    pathname.startsWith("/_next/image") ||
    pathname.startsWith("/icon-") ||
    pathname.startsWith("/assets/") ||
    pathname.startsWith("/brand/") ||
    pathname.startsWith("/hero/") ||
    pathname.startsWith("/img/") ||
    pathname === "/site.webmanifest" ||
    pathname === "/favicon.ico" ||
    pathname === "/apple-touch-icon.png" ||
    pathname.endsWith(".png") ||
    pathname.endsWith(".jpg") ||
    pathname.endsWith(".jpeg") ||
    pathname.endsWith(".webp") ||
    pathname.endsWith(".svg") ||
    pathname.endsWith(".css") ||
    pathname.endsWith(".js") ||
    pathname.endsWith(".woff2")
  );
}

function shouldNeverCacheNavigation(pathname) {
  return NEVER_CACHE_NAV_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

function shouldCacheNavigation(pathname) {
  if (shouldNeverCacheNavigation(pathname)) return false;
  return CACHEABLE_NAV_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(req);
  if (cached) return cached;

  const fresh = await fetch(req);
  if (fresh && fresh.ok) {
    cache.put(req, fresh.clone()).catch(() => {});
  }
  return fresh;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (!isSameOrigin(req.url)) return;
  if (url.pathname.startsWith("/api/")) return;

  const isNav = req.mode === "navigate" || req.destination === "document" || (req.headers.get("accept") || "").includes("text/html");
  if (isNav) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_VERSION);

        try {
          const preload = await event.preloadResponse;
          if (preload) {
            if (preload.ok && shouldCacheNavigation(url.pathname)) {
              cache.put(req, preload.clone()).catch(() => {});
            }
            return preload;
          }

          const fresh = await fetch(req);
          if (fresh && fresh.ok && shouldCacheNavigation(url.pathname)) {
            cache.put(req, fresh.clone()).catch(() => {});
          }
          return fresh;
        } catch {
          if (shouldCacheNavigation(url.pathname)) {
            const cached = await cache.match(req);
            if (cached) return cached;
          }
          const offline = await cache.match("/offline");
          return offline || new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } });
        }
      })()
    );
    return;
  }

  if (isStaticAsset(url.pathname)) {
    event.respondWith(
      cacheFirst(req).catch(async () => {
        const cache = await caches.open(CACHE_VERSION);
        const cached = await cache.match(req);
        return cached || new Response("", { status: 504 });
      })
    );
  }
});
