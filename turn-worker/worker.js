// Cloudflare Worker: hands the call page short-lived TURN (relay) credentials so calls connect on
// networks that block direct phone-to-phone links. The TURN key itself stays here as a secret.
//
// Secrets (set with `npx wrangler secret put NAME`): TURN_KEY_ID, TURN_KEY_API_TOKEN.
// Cost guard: credentials are cached for an hour per Cloudflare location, so page loads don't each
// call Cloudflare's API, and only the allowed origins below get an answer.

const ALLOWED_ORIGINS = ["https://spacepanda99.github.io", "http://localhost:8765", "http://localhost:8766", "http://localhost:8767"];
const TTL_SECONDS = 86400;          // credentials stay valid 24 h, longer than any call
const CACHE_SECONDS = 3600;

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
  };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    const url = new URL(request.url);
    if (url.pathname !== "/ice" || request.method !== "GET") return new Response("Not found", { status: 404 });
    if (!ALLOWED_ORIGINS.includes(origin)) return new Response("Forbidden", { status: 403 });

    const cache = caches.default;
    const cacheKey = new Request(url.origin + "/ice-cache-v1");
    let cached = await cache.match(cacheKey);
    if (!cached) {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
      });
      if (!r.ok) return new Response(JSON.stringify({ error: "turn " + r.status }), { status: 502, headers: { ...cors(origin), "Content-Type": "application/json" } });
      const data = await r.json();
      // Browsers block port 53, so drop those URLs to avoid a slow timeout.
      const iceServers = (data.iceServers || []).map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53\b/.test(u)) }));
      cached = new Response(JSON.stringify({ iceServers }), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_SECONDS}` } });
      ctx.waitUntil(cache.put(cacheKey, cached.clone()));
    }
    return new Response(cached.body, { headers: { ...cors(origin), "Content-Type": "application/json", "Cache-Control": "no-store" } });
  },
};
