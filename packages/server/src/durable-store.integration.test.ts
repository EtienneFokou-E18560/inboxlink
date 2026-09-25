import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { GmailAdapter } from "@inboxlink/adapters-gmail";
import { unescapeHtml } from "@inboxlink/connect-ui";
import { PgDatabase, PostgresStore, PostgresTokenVault } from "./db/postgres-store.js";
import type { SqlExecutor } from "./db/sql.js";
import { createAppFromEnv } from "./index.js";
import { createApp } from "./routes/app.js";

const REFRESH = "1//gmail-refresh-token-shared";
const EMAIL = "tester@gmail.com";

class PgliteExecutor implements SqlExecutor {
  constructor(private readonly db: PGlite) {}

  async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.db.query<T>(text, params);
    return result.rows;
  }

  async exec(text: string): Promise<void> {
    await this.db.exec(text);
  }
}

let google: Server;
let tokenUrl = "";
let userinfoUrl = "";

before(async () => {
  google = createServer((req, res) => {
    if (req.url?.startsWith("/token")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: "ya29.test-access",
          refresh_token: REFRESH,
          expires_in: 3600,
          scope: "openid email https://www.googleapis.com/auth/gmail.readonly",
        }),
      );
      return;
    }
    if (req.url?.startsWith("/userinfo")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ email: EMAIL }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => google.listen(0, "127.0.0.1", resolve));
  const port = (google.address() as { port: number }).port;
  tokenUrl = `http://127.0.0.1:${port}/token`;
  userinfoUrl = `http://127.0.0.1:${port}/userinfo`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    google.close((err) => (err ? reject(err) : resolve()));
  });
});

function pair(db: PgDatabase) {
  const store = new PostgresStore(db);
  const vault = new PostgresTokenVault(db, "test-master-key-at-least-16");
  const gmail = new GmailAdapter({
    clientId: "test-client-id.apps.googleusercontent.com",
    clientSecret: "test-client-secret",
    redirectUri: "http://localhost:8787/v1/oauth/gmail/callback",
    tokenUrl,
    userinfoUrl,
  });
  const app = createApp({
    store,
    vault,
    gmail,
    publicBaseUrl: "http://localhost:8787",
    apiSecret: "unused-in-single-mode",
    mode: "single",
    gmailScopes: ["https://www.googleapis.com/auth/gmail.readonly", "openid", "email"],
    storeKind: "postgres",
    queue: null,
  });
  return { app, vault };
}

function connectAuthUrl(html: string): URL {
  const href = unescapeHtml(
    html.match(/data-testid="connect-cta"[^>]*href="([^"]+)"/)?.[1]
      ?? html.match(/href="([^"]+)"[^>]*data-testid="connect-cta"/)?.[1]
      ?? "",
  );
  return new URL(href);
}

describe("shared Postgres store across instances", () => {
  it("keeps the OAuth session, grant, and ciphertext visible to a second instance", async () => {
    const pg = new PGlite();
    const db = new PgDatabase(new PgliteExecutor(pg));
    const first = pair(db);
    const second = pair(db);

    const health = await second.app.request("/health");
    assert.equal(health.status, 200);
    const healthBody = (await health.json()) as { ok: boolean; store: string };
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.store, "postgres");

    const other = await first.app.request("/v1/link/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        externalUserId: "user-2",
        redirectUri: "http://localhost:9999/done",
      }),
    });
    assert.equal(other.status, 200);

    const created = await first.app.request("/v1/link/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        externalUserId: "user-1",
        redirectUri: "http://localhost:9999/done",
      }),
    });
    assert.equal(created.status, 200);
    const session = (await created.json()) as { sessionId: string; linkToken: string };
    const seen = await second.app.request(`/v1/link/sessions/${session.sessionId}`);
    assert.equal(seen.status, 200);
    assert.equal(((await seen.json()) as { status: string }).status, "pending");

    const connect = await second.app.request(`/v1/connect/${encodeURIComponent(session.linkToken)}`);
    assert.equal(connect.status, 200);
    const state = connectAuthUrl(await connect.text()).searchParams.get("state");
    assert.ok(state);

    const callback = await first.app.request(
      `/v1/oauth/gmail/callback?code=auth-code&state=${encodeURIComponent(state)}`,
    );
    assert.equal(callback.status, 302);
    const redirected = new URL(callback.headers.get("location") ?? "");
    const publicToken = redirected.searchParams.get("public_token");
    assert.ok(publicToken);

    const exchanged = await second.app.request("/v1/grants/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicToken }),
    });
    assert.equal(exchanged.status, 200);
    const { grantId } = (await exchanged.json()) as { grantId: string };

    const again = await first.app.request("/v1/grants/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicToken }),
    });
    assert.equal(again.status, 400);

    const listed = await second.app.request("/v1/grants?externalUserId=user-1");
    assert.equal(listed.status, 200);
    const { grants } = (await listed.json()) as { grants: { id: string; email: string; status: string }[] };
    assert.equal(grants.length, 1);
    assert.equal(grants[0]?.id, grantId);
    assert.equal(grants[0]?.email, EMAIL);
    assert.equal(grants[0]?.status, "active");

    const ciphertext = await second.vault.getCiphertext(grantId);
    assert.ok(ciphertext);
    assert.equal(Buffer.from(ciphertext).toString("utf8").includes(REFRESH), false);
    assert.equal(await first.vault.open(ciphertext, { grantId, tenantId: "default" }), REFRESH);

    const revoked = await second.app.request(`/v1/grants/${encodeURIComponent(grantId)}`, {
      method: "DELETE",
    });
    assert.equal(revoked.status, 204);
    assert.equal(await first.vault.getCiphertext(grantId), undefined);
    const after = await first.app.request("/v1/grants?externalUserId=user-1");
    const remaining = (await after.json()) as { grants: unknown[] };
    assert.deepEqual(remaining.grants, []);

    await pg.close();
  });
});

describe("store selection", () => {
  it("uses memory when DATABASE_URL is unset", async () => {
    const { app, storeKind } = createAppFromEnv({
      INBOXLINK_MASTER_KEY: "test-master-key-at-least-16",
      PUBLIC_BASE_URL: "http://localhost:8787",
    });
    assert.equal(storeKind, "memory");
    const health = await app.request("/health");
    assert.equal(health.status, 200);
    const body = (await health.json()) as { ok: boolean; store: string };
    assert.equal(body.ok, true);
    assert.equal(body.store, "memory");
  });
});
