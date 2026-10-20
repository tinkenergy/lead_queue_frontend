import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { resetAccessCache, verifyAccessJwt } from "../src/access.js";
import worker, { authenticate, upstreamPath } from "../src/worker.js";

const TEAM = "tink.cloudflareaccess.com";
const AUD = "aud-tag";
const NOW = Date.UTC(2026, 9, 20, 8, 0, 0);

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function keyPair(kid) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "RS256", use: "sig" };
  return { privateKey: pair.privateKey, jwk };
}

async function sign(privateKey, kid, claims) {
  const header = base64Url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const payload = base64Url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(`${header}.${payload}`)
  );
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

function claims(overrides = {}) {
  return {
    aud: [AUD],
    email: "Anna@Tink.io",
    iss: `https://${TEAM}`,
    exp: NOW / 1000 + 3600,
    iat: NOW / 1000,
    ...overrides,
  };
}

function certsFetch(keys) {
  return async () => new Response(JSON.stringify({ keys }), { status: 200 });
}

describe("verifyAccessJwt", () => {
  let key;
  beforeEach(async () => {
    resetAccessCache();
    key = await keyPair("k1");
  });

  const verify = (token, keys) =>
    verifyAccessJwt(token, { teamDomain: TEAM, audience: AUD, now: NOW, fetchImpl: certsFetch(keys) });

  it("accepts a valid token", async () => {
    const token = await sign(key.privateKey, "k1", claims());
    assert.equal((await verify(token, [key.jwk])).email, "Anna@Tink.io");
  });

  it("rejects another application, issuer, an expired token or no email", async () => {
    for (const bad of [{ aud: ["other"] }, { iss: "https://evil.example" }, { exp: NOW / 1000 - 1 }, { email: undefined }]) {
      resetAccessCache();
      const token = await sign(key.privateKey, "k1", claims(bad));
      assert.equal(await verify(token, [key.jwk]), null, JSON.stringify(bad));
    }
  });

  it("rejects a token signed with a different key", async () => {
    const other = await keyPair("k1");
    const token = await sign(other.privateKey, "k1", claims());
    assert.equal(await verify(token, [key.jwk]), null);
  });

  it("rejects an unknown key id, garbage and a missing token", async () => {
    const token = await sign(key.privateKey, "k2", claims());
    assert.equal(await verify(token, [key.jwk]), null);
    assert.equal(await verify("not.a.jwt", [key.jwk]), null);
    assert.equal(await verify(null, [key.jwk]), null);
  });
});

describe("upstreamPath", () => {
  it("forwards only the lead-queue routes", () => {
    assert.equal(upstreamPath("POST", "/api/next"), "/next");
    assert.equal(upstreamPath("GET", "/api/me"), "/me");
    assert.equal(upstreamPath("GET", "/api/stats"), "/stats");
    assert.equal(upstreamPath("POST", "/api/leads/123/extend"), "/leads/123/extend");
    assert.equal(upstreamPath("POST", "/api/leads/123/release"), "/leads/123/release");
  });

  it("forwards nothing else", () => {
    assert.equal(upstreamPath("GET", "/api/next"), null);
    assert.equal(upstreamPath("POST", "/api/sync"), null);
    assert.equal(upstreamPath("POST", "/api/leads/../sync/extend"), null);
    assert.equal(upstreamPath("POST", "/api/leads/1/extend/x"), null);
  });
});

describe("authenticate", () => {
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

  it("uses the dev user only on localhost and only when allowed", async () => {
    const dev = { ...env, ALLOW_DEV_USER: "true", DEV_USER_EMAIL: "Dev@Tink.io" };
    const never = async () => null;
    assert.equal(await authenticate(new Request("http://localhost:8787/api/me"), dev, never), "dev@tink.io");
    assert.equal(await authenticate(new Request("https://leads.tinkenergy.dev/api/me"), dev, never), null);
    assert.equal(await authenticate(new Request("http://localhost:8787/api/me"), env, never), null);
  });

  it("returns the Access email in lower case", async () => {
    const request = new Request("https://leads.tinkenergy.dev/api/me", {
      headers: { "Cf-Access-Jwt-Assertion": "token" },
    });
    const verify = async (token) => (token === "token" ? { email: "Anna@Tink.io" } : null);
    assert.equal(await authenticate(request, env, verify), "anna@tink.io");
  });
});

describe("fetch handler", () => {
  it("answers 401 without a login and never calls the API", async () => {
    const original = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response("{}");
    };
    try {
      resetAccessCache();
      const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, LEAD_QUEUE_API_KEY: "k", API_BASE_URL: "https://api" };
      const response = await worker.fetch(new Request("https://leads.tinkenergy.dev/api/next", { method: "POST" }), env);
      assert.equal(response.status, 401);
      assert.equal(called, false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("adds the key and the rep's email when forwarding", async () => {
    const original = globalThis.fetch;
    let sent;
    globalThis.fetch = async (url, init) => {
      sent = { url, init };
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    };
    try {
      const env = { ALLOW_DEV_USER: "true", DEV_USER_EMAIL: "anna@tink.io", LEAD_QUEUE_API_KEY: "secret", API_BASE_URL: "https://api" };
      const request = new Request("http://localhost:8787/api/next", { method: "POST", body: '{"previous_outcome":"done"}' });
      const response = await worker.fetch(request, env);
      assert.equal(response.status, 200);
      assert.equal(sent.url, "https://api/v1/lead-queue/next");
      assert.equal(sent.init.headers["X-API-Key"], "secret");
      assert.equal(sent.init.headers["X-User-Email"], "anna@tink.io");
      assert.equal(sent.init.body, '{"previous_outcome":"done"}');
    } finally {
      globalThis.fetch = original;
    }
  });
});
