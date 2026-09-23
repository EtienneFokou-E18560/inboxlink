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
});
