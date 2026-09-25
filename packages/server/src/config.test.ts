import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig, resolvePublicBaseUrl } from "./config.js";

describe("public URL and OAuth redirect", () => {
  it("uses PUBLIC_BASE_URL when set", () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://inboxlink-two.vercel.app/",
      GOOGLE_CLIENT_ID: "real-client.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "real-secret",
    });
    assert.equal(config.publicBaseUrl, "https://inboxlink-two.vercel.app");
    assert.equal(
      config.googleRedirectUri,
      "https://inboxlink-two.vercel.app/v1/oauth/gmail/callback",
    );
  });

  it("falls back to the Vercel production host", () => {
    assert.equal(
      resolvePublicBaseUrl({ VERCEL_PROJECT_PRODUCTION_URL: "inboxlink-two.vercel.app" }, 8787),
      "https://inboxlink-two.vercel.app",
    );
  });

  it("defaults to single mode and maps tenant secrets", () => {
    const single = loadConfig({});
    assert.equal(single.mode, "single");
    assert.equal(single.allowedRedirectOrigins, null);
    const multi = loadConfig({
      INBOXLINK_MODE: "multi",
      INBOXLINK_API_SECRET: "primary-secret",
      INBOXLINK_TENANT_ID: "default",
      INBOXLINK_TENANT_SECRETS: "acme=acme-secret",
    });
    assert.equal(multi.mode, "multi");
    assert.deepEqual(multi.tenantSecrets, {
      default: "primary-secret",
      acme: "acme-secret",
    });
  });

  it("loads ALLOWED_REDIRECT_ORIGINS when set", () => {
    const config = loadConfig({
      ALLOWED_REDIRECT_ORIGINS: "https://app.example.com,http://127.0.0.1:9999",
    });
    assert.deepEqual(config.allowedRedirectOrigins, [
      "https://app.example.com",
      "http://127.0.0.1:9999",
    ]);
  });

  it("loads webhook URL and secret when set", () => {
    const config = loadConfig({
      INBOXLINK_WEBHOOK_URL: " https://hooks.example/inbox ",
      INBOXLINK_WEBHOOK_SECRET: " whsec ",
    });
    assert.equal(config.webhookUrl, "https://hooks.example/inbox");
    assert.equal(config.webhookSecret, "whsec");
    const off = loadConfig({});
    assert.equal(off.webhookUrl, undefined);
    assert.equal(off.webhookSecret, undefined);
  });

  it("loads Gmail Pub/Sub and cron secrets when set", () => {
    const config = loadConfig({
      GMAIL_PUBSUB_TOPIC: " projects/demo/topics/gmail-push ",
      GMAIL_PUSH_SECRET: " push-secret ",
      CRON_SECRET: " cron-secret ",
    });
    assert.equal(config.gmailPubsubTopic, "projects/demo/topics/gmail-push");
    assert.equal(config.gmailPushSecret, "push-secret");
    assert.equal(config.cronSecret, "cron-secret");
  });
});
