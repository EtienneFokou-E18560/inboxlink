import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DATABASE_UNAVAILABLE_GUIDANCE,
  MEMORY_STORE_GUIDANCE,
  NEEDS_REAUTH_GUIDANCE,
  isHealthPath,
  redactFields,
  redactString,
  redactValue,
} from "./log.js";

describe("log redaction", () => {
  it("redacts Bearer headers and Google-style tokens in strings", () => {
    const raw =
      "Authorization: Bearer ya29.a0SecretToken and refresh 1//abc-DEF_123 with key AIzaSyTestKey";
    const out = redactString(raw);
    assert.equal(out.includes("ya29."), false);
    assert.equal(out.includes("1//abc"), false);
    assert.equal(out.includes("AIzaSyTestKey"), false);
    assert.match(out, /Bearer \[REDACTED\]/);
    assert.match(out, /\[REDACTED\]/);
  });

  it("redacts database URLs", () => {
    const out = redactString("db=postgresql://user:pass@host/db?sslmode=require");
    assert.equal(out.includes("pass"), false);
    assert.equal(out.includes("user:"), false);
    assert.match(out, /\[REDACTED\]/);
  });

  it("redacts sensitive object keys regardless of value shape", () => {
    const out = redactFields({
      grantId: "grant_1",
      refreshToken: "1//should-not-appear",
      access_token: "ya29.should-not-appear",
      authorization: "Bearer secret-api-key",
      nested: { client_secret: "very-secret", email: "a@b.com" },
      note: "ok",
    }) as Record<string, unknown>;
    assert.equal(out.grantId, "grant_1");
    assert.equal(out.note, "ok");
    assert.equal(out.refreshToken, "[REDACTED]");
    assert.equal(out.access_token, "[REDACTED]");
    assert.equal(out.authorization, "[REDACTED]");
    const nested = out.nested as Record<string, unknown>;
    assert.equal(nested.client_secret, "[REDACTED]");
    assert.equal(nested.email, "a@b.com");
  });

  it("redacts token-like substrings inside non-sensitive keys", () => {
    const out = redactValue({ message: "got Bearer abc.def.ghi from callback" }) as {
      message: string;
    };
    assert.equal(out.message.includes("abc.def.ghi"), false);
    assert.match(out.message, /Bearer \[REDACTED\]/);
  });

  it("exposes ops guidance constants without secrets", () => {
    for (const text of [MEMORY_STORE_GUIDANCE, DATABASE_UNAVAILABLE_GUIDANCE, NEEDS_REAUTH_GUIDANCE]) {
      assert.equal(/ya29\.|Bearer |1\/\/|password|secret=/i.test(text), false);
      assert.ok(text.length > 20);
    }
  });

  it("recognizes health probe paths", () => {
    assert.equal(isHealthPath("/"), true);
    assert.equal(isHealthPath("/health"), true);
    assert.equal(isHealthPath("/health/"), true);
    assert.equal(isHealthPath("/v1/grants"), false);
  });
});
