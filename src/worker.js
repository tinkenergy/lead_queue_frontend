// Serves the lead-queue page and proxies /api/* to the reonic-sync-api lead queue.
//
// The browser never talks to the API and never sees the API key: the Worker adds
// `X-API-Key` (secret LEAD_QUEUE_API_KEY) and `X-User-Email` (from the verified Cloudflare
// Access login) to every request it forwards. Only the routes below are forwarded.

import { verifyAccessJwt } from "./access.js";

const ROUTES = [
  { method: "POST", pattern: /^\/api\/next$/, upstream: () => "/next" },
  { method: "GET", pattern: /^\/api\/me$/, upstream: () => "/me" },
  { method: "GET", pattern: /^\/api\/stats$/, upstream: () => "/stats" },
  { method: "POST", pattern: /^\/api\/leads\/(\d+)\/extend$/, upstream: (m) => `/leads/${m[1]}/extend` },
  { method: "POST", pattern: /^\/api\/leads\/(\d+)\/release$/, upstream: (m) => `/leads/${m[1]}/release` },
];

/** Returns the lead-queue API path for a browser request, or null when it isn't forwarded. */
export function upstreamPath(method, pathname) {
  for (const route of ROUTES) {
    const match = route.pattern.exec(pathname);
    if (match && route.method === method) return route.upstream(match);
  }
  return null;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** The signed-in rep's email, or null. */
export async function authenticate(request, env, verify = verifyAccessJwt) {
  const { hostname } = new URL(request.url);
  // Local `wrangler dev` only (set in .dev.vars): there is no Access in front of localhost.
  if (
    env.ALLOW_DEV_USER === "true" &&
    env.DEV_USER_EMAIL &&
    (hostname === "localhost" || hostname === "127.0.0.1")
  ) {
    return env.DEV_USER_EMAIL.toLowerCase();
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  const claims = await verify(token, {
    teamDomain: env.ACCESS_TEAM_DOMAIN,
    audience: env.ACCESS_AUD,
  });
  return claims ? claims.email.toLowerCase() : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    let user;
    try {
      user = await authenticate(request, env);
    } catch (error) {
      console.error("Access check failed", error);
      return json({ detail: "Dein Login konnte nicht geprüft werden. Lade die Seite neu." }, 503);
    }
    if (!user) return json({ detail: "Nicht angemeldet. Lade die Seite neu." }, 401);
    if (url.pathname === "/api/session" && request.method === "GET") return json({ email: user });

    const path = upstreamPath(request.method, url.pathname);
    if (!path) return json({ detail: "Nicht gefunden." }, 404);
    if (!env.LEAD_QUEUE_API_KEY) return json({ detail: "Die Lead-Warteschlange ist nicht eingerichtet." }, 503);

    const body = request.method === "POST" ? (await request.text()) || "{}" : undefined;
    let upstream;
    try {
      upstream = await fetch(`${env.API_BASE_URL}/v1/lead-queue${path}`, {
        method: request.method,
        headers: {
          "X-API-Key": env.LEAD_QUEUE_API_KEY,
          "X-User-Email": user,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
      });
    } catch (error) {
      console.error("Lead queue API unreachable", error);
      return json({ detail: "Die Lead-Warteschlange ist gerade nicht erreichbar. Versuch es gleich noch einmal." }, 502);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") || "application/json",
        "Cache-Control": "no-store",
      },
    });
  },
};
