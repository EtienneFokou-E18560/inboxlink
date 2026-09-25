import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import { describe, it } from "node:test";
import {
  createWebhookBus,
  deliverWebhookEvent,
  emitWebhookSafe,
  isHardClientError,
  shouldRetryStatus,
  signWebhookBody,
  WEBHOOK_SIGNATURE_HEADER,
} from "./deliver.js";

/** Mirror SDK `webhooks.verify` for cross-package sign/verify alignment. */
function verifyLikeSdk(input: {
  payload: string;
  signatureHeader: string;
  secret: string;
}): boolean {
  const expected = createHmac("sha256", input.secret).update(input.payload).digest("hex");
  const provided = input.signatureHeader.replace(/^sha256=/i, "").trim();
  try {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(provided, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

describe("webhook sign / verify", () => {
  it("signs raw body as sha256=<hex> matching SDK verify", () => {
    const secret = "whsec-test";
    const payload = JSON.stringify({
      id: "evt_1",
      type: "grant.connected",
      data: { grantId: "grant_abc" },
    });
    const header = signWebhookBody(secret, payload);
    assert.match(header, /^sha256=[0-9a-f]{64}$/);
    assert.equal(verifyLikeSdk({ payload, signatureHeader: header, secret }), true);
    assert.equal(verifyLikeSdk({ payload, signatureHeader: header, secret: "wrong" }), false);
  });

  it("HMAC is over the exact UTF-8 body bytes", () => {
    const secret = "s";
    const payload = '{"type":"sync.completed"}';
    const header = signWebhookBody(secret, payload);
    const expected =
      "sha256=" + createHmac("sha256", secret).update(payload, "utf8").digest("hex");
    assert.equal(header, expected);
  });
});

describe("webhook retry policy", () => {
  it("retries 408 / 429 / 5xx and drops hard 4xx", () => {
    assert.equal(shouldRetryStatus(408), true);
    assert.equal(shouldRetryStatus(429), true);
    assert.equal(shouldRetryStatus(500), true);
    assert.equal(shouldRetryStatus(502), true);
    assert.equal(shouldRetryStatus(400), false);
    assert.equal(shouldRetryStatus(401), false);
    assert.equal(shouldRetryStatus(404), false);
    assert.equal(isHardClientError(400), true);
    assert.equal(isHardClientError(404), true);
    assert.equal(isHardClientError(429), false);
    assert.equal(isHardClientError(500), false);
  });

  it("retries on 503 then succeeds", async () => {
    const statuses = [503, 200];
    let calls = 0;
    const sleeps: number[] = [];
    const result = await deliverWebhookEvent(
      {
        url: "https://hooks.example/inbox",
        secret: "whsec",
        maxAttempts: 3,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        fetchImpl: async (_url, init) => {
          calls += 1;
          const body = String(init?.body ?? "");
          const headers = init?.headers as Record<string, string>;
          assert.equal(
            verifyLikeSdk({
              payload: body,
              signatureHeader: headers[WEBHOOK_SIGNATURE_HEADER],
              secret: "whsec",
            }),
            true,
          );
          assert.equal(headers["content-type"], "application/json");
          const status = statuses.shift() ?? 200;
          return new Response(status >= 400 ? "err" : "ok", { status });
        },
      },
      "sync.completed",
      { grantId: "grant_1", upserted: 2 },
    );
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.equal(result.dropped, false);
    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [100]);
  });

  it("drops on hard 4xx without further retries", async () => {
    let calls = 0;
    const result = await deliverWebhookEvent(
      {
        url: "https://hooks.example/inbox",
        secret: "whsec",
        maxAttempts: 5,
        sleep: async () => {
          assert.fail("should not sleep after hard 4xx");
        },
        fetchImpl: async () => {
          calls += 1;
          return new Response("nope", { status: 404 });
        },
      },
      "grant.connected",
      { grantId: "grant_x" },
    );
    assert.equal(result.ok, false);
    assert.equal(result.dropped, true);
    assert.equal(result.attempts, 1);
    assert.equal(result.lastStatus, 404);
    assert.equal(calls, 1);
  });

  it("retries network errors up to maxAttempts", async () => {
    let calls = 0;
    const result = await deliverWebhookEvent(
      {
        url: "https://hooks.example/inbox",
        secret: "whsec",
        maxAttempts: 3,
        sleep: async () => {},
        fetchImpl: async () => {
          calls += 1;
          throw new Error("ECONNRESET");
        },
      },
      "grant.needs_reauth",
      { grantId: "grant_y" },
    );
    assert.equal(result.ok, false);
    assert.equal(result.dropped, false);
    assert.equal(result.attempts, 3);
    assert.equal(calls, 3);
  });
});

describe("webhook bus + safe emit", () => {
  it("is disabled when url or secret is missing", async () => {
    const noUrl = createWebhookBus({ secret: "s" });
    assert.equal(noUrl.enabled, false);
    assert.deepEqual(await noUrl.emit("grant.connected", {}), {
      ok: true,
      attempts: 0,
      dropped: false,
    });

    const noSecret = createWebhookBus({ url: "https://example.com/hook" });
    assert.equal(noSecret.enabled, false);
  });

  it("emitWebhookSafe never throws even if bus.emit rejects", async () => {
    const bus = {
      enabled: true,
      async emit() {
        throw new Error("boom");
      },
    };
    const result = await emitWebhookSafe(bus, "grant.connected", { grantId: "g" });
    assert.equal(result.ok, false);
  });

  it("emitWebhookSafe no-ops when bus is null", async () => {
    const result = await emitWebhookSafe(null, "sync.completed", {});
    assert.deepEqual(result, { ok: true, attempts: 0, dropped: false });
  });
});
