import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import {
  GmailAdapter,
  GmailApiError,
  GmailTokenRefreshError,
  gmailRequiresReconnect,
} from "./index.js";

/** Google's answers, by path: [status, JSON body or raw text]. */
const answers = new Map<string, [number, unknown]>();

let google: Server;
let base = "";

before(async () => {
  google = createServer((req, res) => {
    req.resume();
    const path = (req.url ?? "/").split("?")[0]!;
    const [status, body] = answers.get(path) ?? [404, { error: "no_stub" }];
    if (typeof body === "string") {
      res.writeHead(status, { "content-type": "text/html" });
      res.end(body);
      return;
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => google.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(google.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => google.close(() => resolve()));
});

function adapter() {
  return new GmailAdapter({
    clientId: "test-client-id.apps.googleusercontent.com",
    clientSecret: "test-client-secret",
    redirectUri: "http://localhost:8787/v1/oauth/gmail/callback",
    tokenUrl: `${base}/token`,
    gmailApiBaseUrl: `${base}/gmail/v1`,
  });
}

async function refreshError(): Promise<unknown> {
  try {
    await adapter().refreshAccessToken("1//refresh");
  } catch (err) {
    return err;
  }
  assert.fail("refresh should have failed");
}

describe("reconnect only when Google requires it", () => {
  it("a refresh refused with invalid_grant (revoked, expired, consent withdrawn) asks to reconnect", async () => {
    answers.set("/token", [400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }]);
    const err = await refreshError();
    assert.ok(err instanceof GmailTokenRefreshError);
    assert.equal(err.status, 400);
    assert.equal(err.oauthError, "invalid_grant");
    assert.equal(gmailRequiresReconnect(err), true);
  });

  for (const [label, answer] of [
    ["a 500", [500, { error: "internal_failure" }]],
    ["a 503 HTML page", [503, "<html>Service Unavailable</html>"]],
    ["a rate limit", [429, { error: "rate_limit_exceeded" }]],
    ["our own client misconfigured", [401, { error: "invalid_client" }]],
  ] as const) {
    it(`a refresh failing with ${label} is temporary`, async () => {
      answers.set("/token", answer as [number, unknown]);
      const err = await refreshError();
      assert.ok(err instanceof GmailTokenRefreshError);
      assert.equal(gmailRequiresReconnect(err), false);
    });
  }

  it("reads Gmail's error reason and treats a 403 rate limit as temporary", async () => {
    answers.set("/gmail/v1/users/me/profile", [
      403,
      { error: { code: 403, errors: [{ reason: "userRateLimitExceeded" }], status: "PERMISSION_DENIED" } },
    ]);
    const err = await adapter()
      .getProfile("ya29.x")
      .then(() => undefined, (e: unknown) => e);
    assert.ok(err instanceof GmailApiError);
    assert.equal(err.reason, "userRateLimitExceeded");
    assert.equal(gmailRequiresReconnect(err), false);
  });

  it("a Gmail 401, or a 403 for a withdrawn scope, asks to reconnect", () => {
    assert.equal(gmailRequiresReconnect(new GmailApiError(401)), true);
    assert.equal(gmailRequiresReconnect(new GmailApiError(403, "insufficientPermissions")), true);
    assert.equal(gmailRequiresReconnect(new GmailApiError(403, "PERMISSION_DENIED")), true);
  });

  it("a 403 that is our own setup, or names no reason, is temporary", () => {
    assert.equal(gmailRequiresReconnect(new GmailApiError(403, "accessNotConfigured")), false);
    assert.equal(gmailRequiresReconnect(new GmailApiError(403, "RESOURCE_EXHAUSTED")), false);
    assert.equal(gmailRequiresReconnect(new GmailApiError(403)), false, "not Google's JSON: not proof of anything");
  });

  it("other Gmail failures and unknown errors are temporary", () => {
    assert.equal(gmailRequiresReconnect(new GmailApiError(500)), false);
    assert.equal(gmailRequiresReconnect(new GmailApiError(429, "rateLimitExceeded")), false);
    assert.equal(gmailRequiresReconnect(new TypeError("fetch failed")), false);
    assert.equal(gmailRequiresReconnect(undefined), false);
  });
});
