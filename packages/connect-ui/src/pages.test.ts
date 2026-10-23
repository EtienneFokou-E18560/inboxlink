import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  connectErrorStatus,
  renderConnectErrorPage,
  renderConnectPage,
} from "./pages.js";

describe("renderConnectPage", () => {
  it("includes CTA href, brand, expiry, and mobile viewport", () => {
    const html = renderConnectPage({
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=abc&x="y"',
      expiresAt: "2099-01-15T12:00:00.000Z",
    });
    assert.match(html, /Inbox<span>Link<\/span>/);
    assert.match(html, /name="viewport"/);
    assert.match(html, /data-testid="connect-cta"/);
    assert.match(html, /Continue with Google/);
    assert.match(html, /href="https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?state=abc&amp;x=&quot;y&quot;"/);
    assert.match(html, /aria-describedby="connect-lead connect-expiry"/);
    assert.match(html, /class="skip-link"/);
    assert.match(html, /href="#connect-main"/);
    assert.match(html, /datetime="2099-01-15T12:00:00\.000Z"/);
    assert.match(html, /This link expires/);
    assert.match(html, /host never holds your refresh token/);
    assert.match(html, /<a href="https:\/\/inboxlink\.cieltd\.org\/for-mailbox-owners\/" target="_blank" rel="noopener">What is InboxLink\?<\/a>/);
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /default-src 'none'/);
    assert.doesNotMatch(html, /Stub Connect UI/);
  });
});

describe("renderConnectErrorPage", () => {
  it("explains expired sessions with alert role", () => {
    const html = renderConnectErrorPage({ kind: "expired" });
    assert.match(html, /role="alert"/);
    assert.match(html, /This connect link has expired/);
    assert.match(html, /request a new connect link/i);
    assert.equal(connectErrorStatus("expired"), 404);
  });

  it("maps oauth exchange detail into the notice", () => {
    const html = renderConnectErrorPage({
      kind: "oauth_exchange",
      detail: "Add this exact redirect in the Google OAuth client: https://example/cb",
    });
    assert.match(html, /Google did not accept the authorization/);
    assert.match(html, /exact redirect/);
    assert.equal(connectErrorStatus("oauth_exchange"), 400);
  });

  it("prompts re-consent when Google omits the refresh token", () => {
    const html = renderConnectErrorPage({ kind: "oauth_missing_refresh" });
    assert.match(html, /Google did not return a refresh token/);
    assert.match(html, /approve Google access again/i);
    assert.match(html, /No grant was created/);
    assert.match(html, /role="alert"/);
    assert.equal(connectErrorStatus("oauth_missing_refresh"), 400);
  });

  it("escapes provider error text", () => {
    const html = renderConnectErrorPage({
      kind: "oauth_denied",
      providerError: '<script>alert(1)</script>',
    });
    assert.doesNotMatch(html, /<script>alert/i);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/i);
  });

  it("offers Start again for an unknown OAuth state when a restart URL is known", () => {
    const html = renderConnectErrorPage({
      kind: "oauth_unknown_state",
      restartUrl: "https://host.example/done?error=connect_restart&x=1",
    });
    assert.doesNotMatch(html, /Session mismatch/);
    assert.match(html, /could not be finished/);
    assert.match(
      html,
      /data-testid="connect-restart" href="https:\/\/host\.example\/done\?error=connect_restart&amp;x=1"[^>]*>Start again</,
    );
  });

  it("falls back to plain guidance without a restart URL, and never shows the button elsewhere", () => {
    const unknown = renderConnectErrorPage({ kind: "oauth_unknown_state" });
    assert.doesNotMatch(unknown, /connect-restart/);
    assert.match(unknown, /Go back to the app that sent you here/);
    const expired = renderConnectErrorPage({ kind: "expired", restartUrl: "https://host.example/done" });
    assert.doesNotMatch(expired, /connect-restart/);
  });
});
