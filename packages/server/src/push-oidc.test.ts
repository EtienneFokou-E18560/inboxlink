import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import { resetPushOidcCache, verifyPubSubOidc } from "./push-oidc.js";

const AUD = "https://inboxlink.example/v1/internal/gmail/push";
const EMAIL = "push@proj.iam.gserviceaccount.com";
const NOW_MS = 1_800_000_000_000;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" };

function token(
  overrides: Record<string, unknown> = {},
  signer = privateKey,
  header: Record<string, unknown> = { alg: "RS256", kid: "k1" },
): string {
  const claims = {
    iss: "https://accounts.google.com",
    aud: AUD,
    email: EMAIL,
    email_verified: true,
    exp: NOW_MS / 1000 + 600,
    ...overrides,
  };
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = createSign("RSA-SHA256").update(`${h}.${p}`).sign(signer).toString("base64url");
  return `Bearer ${h}.${p}.${sig}`;
}

const fetchImpl = (async () =>
  new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })) as typeof fetch;
const cfg = { audience: AUD, email: EMAIL, fetchImpl, now: () => NOW_MS };

describe("verifyPubSubOidc", () => {
  beforeEach(() => resetPushOidcCache());

  it("accepts a valid Google-signed token", async () => {
    assert.equal(await verifyPubSubOidc(token(), cfg), true);
  });

  it("rejects wrong audience, email, unverified email, issuer, and expiry", async () => {
    assert.equal(await verifyPubSubOidc(token({ aud: "https://evil" }), cfg), false);
    assert.equal(await verifyPubSubOidc(token({ email: "x@y.z" }), cfg), false);
    assert.equal(await verifyPubSubOidc(token({ email_verified: false }), cfg), false);
    assert.equal(await verifyPubSubOidc(token({ iss: "https://evil.example" }), cfg), false);
    assert.equal(await verifyPubSubOidc(token({ exp: NOW_MS / 1000 - 3600 }), cfg), false);
  });

  it("rejects a token signed by a different key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    assert.equal(await verifyPubSubOidc(token({}, other.privateKey), cfg), false);
  });

  it("rejects non-RS256, missing header, and malformed input", async () => {
    assert.equal(
      await verifyPubSubOidc(token({}, privateKey, { alg: "none", kid: "k1" }), cfg),
      false,
    );
    assert.equal(await verifyPubSubOidc(undefined, cfg), false);
    assert.equal(await verifyPubSubOidc("Bearer a.b", cfg), false);
    assert.equal(await verifyPubSubOidc("Basic abc", cfg), false);
  });

  it("returns false when the JWKS fetch fails", async () => {
    const failing = (async () => new Response("no", { status: 500 })) as typeof fetch;
    assert.equal(await verifyPubSubOidc(token(), { ...cfg, fetchImpl: failing }), false);
  });
});
