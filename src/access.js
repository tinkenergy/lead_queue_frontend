// Verifies the Cloudflare Access login token (`Cf-Access-Jwt-Assertion`) and returns its
// claims. Access already blocks everyone without a login at the edge; this check makes sure
// the rep's email the Worker forwards to the API really comes from Access.

const CERTS_TTL_MS = 10 * 60 * 1000;
let certsCache = { teamDomain: null, keys: [], fetchedAt: 0 };

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function decodeJson(segment) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

async function signingKeys(teamDomain, fetchImpl, now, force) {
  const fresh = now - certsCache.fetchedAt < CERTS_TTL_MS;
  if (!force && fresh && certsCache.teamDomain === teamDomain) return certsCache.keys;
  const response = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`Access certs: HTTP ${response.status}`);
  const { keys = [] } = await response.json();
  certsCache = { teamDomain, keys, fetchedAt: now };
  return keys;
}

/** For tests. */
export function resetAccessCache() {
  certsCache = { teamDomain: null, keys: [], fetchedAt: 0 };
}

/**
 * @returns {Promise<object|null>} the token's claims, or null when it is not valid for this app
 */
export async function verifyAccessJwt(
  token,
  { teamDomain, audience, now = Date.now(), fetchImpl = fetch }
) {
  if (!token || !teamDomain || !audience) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  let header, claims;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;

  let keys = await signingKeys(teamDomain, fetchImpl, now, false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // Access rotates its keys; a new kid means the cache is out of date.
    keys = await signingKeys(teamDomain, fetchImpl, now, true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(parts[2]),
    signed
  );
  if (!valid) return null;

  const nowSeconds = now / 1000;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) return null;
  if (typeof claims.nbf === "number" && claims.nbf > nowSeconds + 60) return null;
  if (!audiences.includes(audience)) return null;
  if (claims.iss !== `https://${teamDomain}`) return null;
  if (typeof claims.email !== "string" || !claims.email.includes("@")) return null;
  return claims;
}
