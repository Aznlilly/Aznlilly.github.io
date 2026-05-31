const SHOUTCAST_ORIGIN = "http://music.elsewhere.moe:18000";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (url.pathname === "/api/shoutcast/stats") {
    const sid = url.searchParams.get("sid") || "1";
    event.respondWith(
      fetch(`${SHOUTCAST_ORIGIN}/stats?sid=${sid}&json=1`)
        .then((response) => {
          const headers = new Headers(response.headers);
          headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
          return new Response(response.body, {
            status: response.status,
            headers,
          });
        })
        .catch(
          () =>
            new Response(JSON.stringify({ streamstatus: 0 }), {
              status: 502,
              headers: { "Content-Type": "application/json" },
            })
        )
    );
    return;
  }

  if (url.pathname === "/api/shoutcast/stream") {
    const sid = url.searchParams.get("sid") || "1";
    event.respondWith(
      fetch(`${SHOUTCAST_ORIGIN}/stream?sid=${sid}`, {
        headers: event.request.headers,
      })
    );
  }
});
