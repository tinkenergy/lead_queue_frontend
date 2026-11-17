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
  it("forwards the lead queue v2 routes", () => {
    assert.equal(upstreamPath("GET", "/api/state"), "/state");
    assert.equal(upstreamPath("GET", "/api/pulse"), "/pulse");
    assert.equal(upstreamPath("GET", "/api/meetings"), "/meetings");
    assert.equal(upstreamPath("POST", "/api/lead"), "/lead");
    for (const action of ["done", "skip", "extend", "expire", "leave", "reclaim", "undo"]) {
      assert.equal(upstreamPath("POST", `/api/lead/${action}`), `/lead/${action}`);
    }
    for (const action of ["pause", "resume", "logout"]) {
      assert.equal(upstreamPath("POST", `/api/${action}`), `/${action}`);
    }
    assert.equal(upstreamPath("POST", "/api/filters/preview"), "/filters/preview");
    assert.equal(upstreamPath("PUT", "/api/filters"), "/filters");
    assert.equal(upstreamPath("DELETE", "/api/filters"), "/filters");
    assert.equal(upstreamPath("PATCH", "/api/tasks/981"), "/tasks/981");
    assert.equal(upstreamPath("POST", "/api/skips/reset"), "/skips/reset");
  });

  it("forwards nothing else", () => {
    assert.equal(upstreamPath("POST", "/api/state"), null);
    assert.equal(upstreamPath("GET", "/api/lead"), null);
    assert.equal(upstreamPath("POST", "/api/sync"), null);
    assert.equal(upstreamPath("GET", "/api/stats"), null);
    assert.equal(upstreamPath("POST", "/api/next"), null);
    assert.equal(upstreamPath("POST", "/api/lead/sync"), null);
    assert.equal(upstreamPath("PATCH", "/api/tasks/../sync"), null);
    assert.equal(upstreamPath("PATCH", "/api/tasks/1/x"), null);
    assert.equal(upstreamPath("GET", "/api/filters"), null);
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
      const response = await worker.fetch(new Request("https://leads.tinkenergy.dev/api/lead", { method: "POST" }), env);
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
      const request = new Request("http://localhost:8787/api/lead/done", { method: "POST", body: '{"lead_id":"500"}' });
      const response = await worker.fetch(request, env);
      assert.equal(response.status, 200);
      assert.equal(sent.url, "https://api/v1/lead-queue/lead/done");
      assert.equal(sent.init.headers["X-API-Key"], "secret");
      assert.equal(sent.init.headers["X-User-Email"], "anna@tink.io");
      assert.equal(sent.init.body, '{"lead_id":"500"}');
    } finally {
      globalThis.fetch = original;
    }
  });

  it("forwards the body of PUT and PATCH, and none for DELETE", async () => {
    const original = globalThis.fetch;
    const sent = [];
    globalThis.fetch = async (url, init) => {
      sent.push({ url, init });
      return new Response("{}", { headers: { "Content-Type": "application/json" } });
    };
    try {
      const env = { ALLOW_DEV_USER: "true", DEV_USER_EMAIL: "anna@tink.io", LEAD_QUEUE_API_KEY: "secret", API_BASE_URL: "https://api" };
      await worker.fetch(new Request("http://localhost:8787/api/filters", { method: "PUT", body: '{"filters":{}}' }), env);
      await worker.fetch(new Request("http://localhost:8787/api/tasks/9", { method: "PATCH", body: '{"done":true}' }), env);
      await worker.fetch(new Request("http://localhost:8787/api/filters", { method: "DELETE" }), env);
      assert.deepEqual(sent.map((s) => [s.init.method, s.url, s.init.body]), [
        ["PUT", "https://api/v1/lead-queue/filters", '{"filters":{}}'],
        ["PATCH", "https://api/v1/lead-queue/tasks/9", '{"done":true}'],
        ["DELETE", "https://api/v1/lead-queue/filters", undefined],
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
