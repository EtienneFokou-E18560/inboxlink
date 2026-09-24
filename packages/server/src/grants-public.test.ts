import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCorsOriginAllowlist,
  parseAllowedRedirectOrigins,
  validateRedirectUri,
} from "./grants-public.js";

describe("CORS origin allowlist", () => {
  it("includes publicBaseUrl origin and never uses a wildcard", () => {
    assert.deepEqual(buildCorsOriginAllowlist(null, "https://inboxlink.example"), [
      "https://inboxlink.example",
    ]);
    assert.deepEqual(
      buildCorsOriginAllowlist(
        ["https://app.example.com", "http://127.0.0.1:9999"],
        "https://inboxlink.example/",
      ),
      ["https://inboxlink.example", "https://app.example.com", "http://127.0.0.1:9999"],
    );
    assert.ok(!buildCorsOriginAllowlist(null, "https://api.example").includes("*"));
  });

  it("omits invalid publicBaseUrl rather than opening CORS", () => {
    assert.deepEqual(buildCorsOriginAllowlist(null, "not-a-url"), []);
    assert.deepEqual(buildCorsOriginAllowlist(["https://app.example"], "not-a-url"), [
      "https://app.example",
    ]);
  });
});

describe("redirect URI allowlist", () => {
  it("is permissive when ALLOWED_REDIRECT_ORIGINS is unset or empty", () => {
    assert.equal(parseAllowedRedirectOrigins(undefined), null);
    assert.equal(parseAllowedRedirectOrigins(""), null);
    assert.equal(parseAllowedRedirectOrigins("   "), null);
    assert.equal(
      validateRedirectUri("http://127.0.0.1:9999/done", null),
      "http://127.0.0.1:9999/done",
    );
    assert.equal(
      validateRedirectUri("https://host.example/inboxlink/done", null),
      "https://host.example/inboxlink/done",
    );
  });

  it("parses comma-separated origins and rejects non-allowlisted hosts", () => {
    const allowed = parseAllowedRedirectOrigins(
      "https://app.example.com, http://127.0.0.1:9999/",
    );
    assert.deepEqual(allowed, ["https://app.example.com", "http://127.0.0.1:9999"]);
    assert.equal(
      validateRedirectUri("https://app.example.com/done", allowed),
      "https://app.example.com/done",
    );
    assert.equal(
      validateRedirectUri("http://127.0.0.1:9999/done", allowed),
      "http://127.0.0.1:9999/done",
    );
    assert.equal(validateRedirectUri("https://evil.example/done", allowed), null);
    assert.equal(validateRedirectUri("http://127.0.0.1:8888/done", allowed), null);
  });

  it("fails closed on invalid ALLOWED_REDIRECT_ORIGINS entries", () => {
    assert.throws(
      () => parseAllowedRedirectOrigins("not-a-url"),
      /valid absolute URL/,
    );
    assert.throws(
      () => parseAllowedRedirectOrigins("ftp://files.example"),
      /http or https/,
    );
  });

  it("still rejects non-http(s) redirect URIs when permissive", () => {
    assert.equal(validateRedirectUri("javascript:alert(1)", null), null);
    assert.equal(validateRedirectUri("file:///etc/passwd", null), null);
  });
});
