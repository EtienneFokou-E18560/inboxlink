import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { createPkcePair } from "./crypto.js";

describe("createPkcePair", () => {
  it("returns an S256 verifier/challenge pair", () => {
    const { codeVerifier, codeChallenge } = createPkcePair();
    assert.match(codeVerifier, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(
      createHash("sha256").update(codeVerifier, "ascii").digest("base64url"),
      codeChallenge,
    );
  });

  it("generates unique pairs", () => {
    const a = createPkcePair();
    const b = createPkcePair();
    assert.notEqual(a.codeVerifier, b.codeVerifier);
    assert.notEqual(a.codeChallenge, b.codeChallenge);
  });
});
