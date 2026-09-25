import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deserializeImapCredentials,
  parseImapCredentials,
  redactSecrets,
  serializeImapCredentials,
} from "./credentials.js";
import { normalizeImapMessage } from "./normalize.js";
import { ImapAdapter } from "./index.js";
import type { ImapSession } from "./transport.js";
import { ImapAuthError } from "./transport.js";

describe("imap credentials", () => {
  it("parses host/user/password with default secure port", () => {
    const creds = parseImapCredentials({
      host: "imap.example.com",
      user: "me@example.com",
      password: "app-password-secret",
    });
    assert.equal(creds.port, 993);
    assert.equal(creds.secure, true);
    const secret = serializeImapCredentials(creds);
    assert.equal(secret.includes("app-password-secret"), true);
    assert.deepEqual(deserializeImapCredentials(secret), creds);
  });

  it("rejects incomplete credentials without echoing secrets", () => {
    assert.throws(
      () => parseImapCredentials({ host: "x", user: "u" }),
      (err: Error) => {
        assert.equal(err.name, "ImapCredentialsError");
        assert.match(err.message, /host_user_pass_required/);
        return true;
      },
    );
  });

  it("redacts passwords from free-form text", () => {
    const creds = parseImapCredentials({
      host: "imap.example.com",
      user: "me@example.com",
      password: "super-secret-pass",
    });
    const redacted = redactSecrets(`login failed for super-secret-pass`, creds);
    assert.equal(redacted.includes("super-secret-pass"), false);
    assert.equal(redacted.includes("[redacted]"), true);
  });
});

describe("normalizeImapMessage", () => {
  it("maps envelope + multipart source onto Message", () => {
    const boundary = "BOUND123";
    const source = Buffer.from(
      [
        "From: Ada <ada@example.com>",
        "Subject: Hello",
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Plain body here",
        `--${boundary}`,
        "Content-Type: application/pdf",
        "Content-Disposition: attachment; filename=notes.pdf",
        "",
        "AAAA",
        `--${boundary}--`,
      ].join("\r\n"),
    );
    const message = normalizeImapMessage(
      {
        uid: 42,
        envelope: {
          subject: "Hello IMAP",
          from: [{ name: "Ada", address: "ada@example.com" }],
          to: [{ address: "bob@example.com" }],
          cc: [{ name: "Grace", address: "grace@example.com" }],
          date: new Date("2026-03-10T12:00:00.000Z"),
          messageId: "<id@example.com>",
        },
        source,
        flags: new Set(["\\Seen"]),
      },
      "grant_1",
    );
    assert.ok(message);
    assert.equal(message.id, "msg_imap_INBOX_42");
    assert.equal(message.providerMessageId, "42");
    assert.equal(message.subject, "Hello IMAP");
    assert.equal(message.body?.text, "Plain body here");
    assert.equal(message.hasAttachments, true);
    assert.deepEqual(message.from, [{ name: "Ada", email: "ada@example.com" }]);
    assert.deepEqual(message.cc, [{ name: "Grace", email: "grace@example.com" }]);
    assert.equal(message.threadId, "<id@example.com>");
    assert.deepEqual(message.folderIds, ["INBOX"]);
  });
});

describe("ImapAdapter list + verify (mock transport)", () => {
  it("verifies and lists newest-first with cursor without live IMAP", async () => {
    const password = "vaulted-app-password";
    const calls: string[] = [];
    const adapter = new ImapAdapter({
      transportFactory: async (credentials) => {
        calls.push("open");
        assert.equal(credentials.password, password);
        const session: ImapSession = {
          async searchAllUids() {
            return [10, 20, 30];
          },
          async fetchByUids(uids) {
            return uids.map((uid) => ({
              uid,
              envelope: {
                subject: `Subject ${uid}`,
                from: [{ address: "a@example.com" }],
                to: [{ address: credentials.user }],
                date: new Date("2026-01-01T00:00:00.000Z"),
              },
              source: Buffer.from(`Subject ${uid}\r\n\r\nbody-${uid}`),
              flags: [],
            }));
          },
          async close() {
            calls.push("close");
          },
        };
        return session;
      },
    });

    const { credentials, secret } = adapter.prepareSecret({
      host: "imap.example.com",
      user: "me@example.com",
      password,
      port: 993,
      secure: true,
    });
    assert.equal(JSON.stringify(secret).includes(password) || secret.includes(password), true);

    const verified = await adapter.verifyConnection(credentials);
    assert.equal(verified.email, "me@example.com");
    assert.deepEqual(calls, ["open", "close"]);

    const page = await adapter.listMessages({
      credentials,
      grantId: "grant_imap",
      maxResults: 2,
    });
    assert.equal(page.messages.length, 2);
    assert.equal(page.messages[0]?.providerMessageId, "30");
    assert.equal(page.messages[1]?.providerMessageId, "20");
    assert.equal(page.nextCursor, "20");

    const page2 = await adapter.listMessages({
      credentials: adapter.openSecret(secret),
      grantId: "grant_imap",
      maxResults: 2,
      cursor: page.nextCursor,
    });
    assert.equal(page2.messages.length, 1);
    assert.equal(page2.messages[0]?.providerMessageId, "10");
    assert.equal(page2.nextCursor, undefined);

    const raw = JSON.stringify(page);
    assert.equal(raw.includes(password), false);
  });

  it("maps auth failures without leaking the password", async () => {
    const password = "leaky-password-value";
    const adapter = new ImapAdapter({
      transportFactory: async () => {
        throw new ImapAuthError(`Authentication failed for ${password}`);
      },
    });
    await assert.rejects(
      () =>
        adapter.verifyConnection({
          host: "imap.example.com",
          port: 993,
          secure: true,
          user: "me@example.com",
          password,
        }),
      (err: Error) => {
        assert.equal(err.name, "ImapAuthError");
        assert.equal(err.message.includes(password), false);
        return true;
      },
    );
  });
});
