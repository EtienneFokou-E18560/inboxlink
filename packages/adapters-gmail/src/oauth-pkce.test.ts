import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { createPkcePair } from "@inboxlink/core";
import { GmailAdapter } from "./index.js";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

describe("GmailAdapter PKCE", () => {
  let google: Server;
  let tokenUrl = "";
  let userinfoUrl = "";
  let lastBody = "";

  before(async () => {
    google = createServer(async (req, res) => {
      const body = await readBody(req);
      if (req.url?.startsWith("/token")) {
        lastBody = body;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: "ya29.pkce",
            refresh_token: "1//pkce",
            expires_in: 3600,
            scope: "openid",
          }),
        );
        return;
      }
      if (req.url?.startsWith("/userinfo")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ email: "pkce@example.com" }));
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

  it("includes S256 challenge on the authorization URL", () => {
    const { codeChallenge } = createPkcePair();
    const adapter = new GmailAdapter({
      clientId: "test-client-id.apps.googleusercontent.com",
      clientSecret: "test-client-secret",
      redirectUri: "http://localhost/callback",
    });
    const url = new URL(
      adapter.buildAuthorizationUrl({
        state: "st",
        redirectUri: "http://localhost/callback",
        scopes: ["openid"],
        codeChallenge,
      }),
    );
    assert.equal(url.searchParams.get("code_challenge"), codeChallenge);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  });

  it("posts code_verifier on token exchange", async () => {
    const { codeVerifier } = createPkcePair();
    const adapter = new GmailAdapter({
      clientId: "test-client-id.apps.googleusercontent.com",
      clientSecret: "test-client-secret",
      redirectUri: "http://localhost/callback",
      tokenUrl,
      userinfoUrl,
    });
    lastBody = "";
    await adapter.exchangeAuthorizationCode({
      code: "auth-code",
      redirectUri: "http://localhost/callback",
      codeVerifier,
    });
    const params = new URLSearchParams(lastBody);
    assert.equal(params.get("code_verifier"), codeVerifier);
    assert.equal(params.get("code"), "auth-code");
  });
});
