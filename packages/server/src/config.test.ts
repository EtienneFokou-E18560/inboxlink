import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig, resolvePublicBaseUrl } from "./config.js";

describe("public URL and OAuth redirect", () => {
  it("uses PUBLIC_BASE_URL when set", () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://inboxlink-two.vercel.app/",
      GOOGLE_CLIENT_ID: "real-client.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "real-secret",
      MICROSOFT_CLIENT_ID: "real-ms-client-id",
      MICROSOFT_CLIENT_SECRET: "real-ms-secret",
    });
    assert.equal(config.publicBaseUrl, "https://inboxlink-two.vercel.app");
    assert.equal(
      config.googleRedirectUri,
      "https://inboxlink-two.vercel.app/v1/oauth/gmail/callback",
    );
    assert.equal(
      config.microsoftRedirectUri,
      "https://inboxlink-two.vercel.app/v1/oauth/microsoft/callback",
    );
    assert.equal(config.microsoftTenant, "common");
  });

  it("falls back to the Vercel production host", () => {
    assert.equal(
      resolvePublicBaseUrl({ VERCEL_PROJECT_PRODUCTION_URL: "inboxlink-two.vercel.app" }, 8787),
      "https://inboxlink-two.vercel.app",
    );
  });

  it("honors MICROSOFT_TENANT override", () => {
    const config = loadConfig({
      MICROSOFT_TENANT: "organizations",
    });
    assert.equal(config.microsoftTenant, "organizations");
  });
});
