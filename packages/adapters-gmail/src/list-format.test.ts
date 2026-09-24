import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { GmailAdapter } from "./index.js";

type Hit = { method: string; url: string };

const ACCESS = "ya29.adapter-test-token";
const GRANT = "grant_adapter_list";

function metadataResource(id: string) {
  return {
    id,
    threadId: id,
    labelIds: ["INBOX", "UNREAD"],
    snippet: `Snippet ${id}`,
    internalDate: "1710000000000",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Ada <ada@example.com>" },
        { name: "To", value: "me@example.com" },
        { name: "Cc", value: "cc@example.com" },
        { name: "Subject", value: `Subject ${id}` },
        { name: "Date", value: "Tue, 10 Mar 2026 12:00:00 +0000" },
      ],
    },
  };
}

function fullResource(id: string) {
  const plain = Buffer.from("Full body").toString("base64url");
  return {
    ...metadataResource(id),
    payload: {
      mimeType: "multipart/mixed",
      headers: metadataResource(id).payload.headers,
      parts: [
        { mimeType: "text/plain", body: { data: plain } },
        {
          mimeType: "application/pdf",
          filename: "notes.pdf",
          body: { attachmentId: "att-1", size: 100 },
        },
      ],
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

describe("GmailAdapter list/get formats", () => {
  let hits: Hit[] = [];
  let google: Server;
  let gmailApiBaseUrl = "";
  let adapter: GmailAdapter;

  before(async () => {
    google = createServer(async (req, res) => {
      const url = req.url ?? "/";
      await readBody(req);
      hits.push({ method: req.method ?? "GET", url });

      if (url.startsWith("/gmail/v1/users/me/messages/")) {
        const path = url.split("?")[0] ?? "";
        const id = decodeURIComponent(path.split("/messages/")[1] ?? "");
        const format = new URL(url, "http://gmail.local").searchParams.get("format");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(format === "full" ? fullResource(id) : metadataResource(id)));
        return;
      }

      if (url.startsWith("/gmail/v1/users/me/messages")) {
        const listUrl = new URL(url, "http://gmail.local");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
            nextPageToken: listUrl.searchParams.get("pageToken") ? undefined : "next",
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => google.listen(0, "127.0.0.1", resolve));
    const port = (google.address() as { port: number }).port;
    gmailApiBaseUrl = `http://127.0.0.1:${port}/gmail/v1`;
    adapter = new GmailAdapter({
      clientId: "test-client-id.apps.googleusercontent.com",
      clientSecret: "test-client-secret",
      redirectUri: "http://localhost/callback",
      gmailApiBaseUrl,
    });
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      google.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("lists with format=metadata and does not call format=full", async () => {
    hits = [];
    const page = await adapter.listMessages({
      accessToken: ACCESS,
      grantId: GRANT,
      maxResults: 3,
      q: "is:unread",
      labelIds: ["INBOX"],
      includeSpamTrash: true,
    });

    assert.equal(page.messages.length, 3);
    assert.equal(page.nextCursor, "next");
    assert.equal(page.messages[0]?.subject, "Subject m1");
    assert.deepEqual(page.messages[0]?.from, [{ name: "Ada", email: "ada@example.com" }]);
    assert.deepEqual(page.messages[0]?.to, [{ email: "me@example.com" }]);
    assert.deepEqual(page.messages[0]?.cc, [{ email: "cc@example.com" }]);
    assert.equal(page.messages[0]?.snippet, "Snippet m1");
    assert.equal(page.messages[0]?.body, undefined);
    assert.equal(page.messages[0]?.attachments, undefined);

    const listHit = hits.find((hit) => hit.url.startsWith("/gmail/v1/users/me/messages?"));
    assert.ok(listHit);
    const listUrl = new URL(listHit.url, "http://gmail.local");
    assert.equal(listUrl.searchParams.get("maxResults"), "3");
    assert.equal(listUrl.searchParams.get("q"), "is:unread");
    assert.deepEqual(listUrl.searchParams.getAll("labelIds"), ["INBOX"]);
    assert.equal(listUrl.searchParams.get("includeSpamTrash"), "true");

    const detailHits = hits.filter((hit) => hit.url.includes("/messages/m"));
    assert.equal(detailHits.length, 3);
    for (const hit of detailHits) {
      const detailUrl = new URL(hit.url, "http://gmail.local");
      assert.equal(detailUrl.searchParams.get("format"), "metadata");
      assert.deepEqual(detailUrl.searchParams.getAll("metadataHeaders").sort(), [
        "Cc",
        "Date",
        "From",
        "Subject",
        "To",
      ]);
    }
    assert.equal(
      hits.some((hit) => new URL(hit.url, "http://gmail.local").searchParams.get("format") === "full"),
      false,
    );
    // One list + three metadata gets (not 1 + 3 full).
    assert.equal(hits.length, 4);
  });

  it("gets one message with format=full including body and attachments", async () => {
    hits = [];
    const message = await adapter.getMessage({
      accessToken: ACCESS,
      grantId: GRANT,
      messageId: "m1",
    });
    assert.ok(message);
    assert.equal(message.subject, "Subject m1");
    assert.equal(message.body?.text, "Full body");
    assert.equal(message.hasAttachments, true);
    assert.deepEqual(message.attachments, [
      { id: "att-1", filename: "notes.pdf", mimeType: "application/pdf", size: 100 },
    ]);

    assert.equal(hits.length, 1);
    const getUrl = new URL(hits[0]!.url, "http://gmail.local");
    assert.equal(getUrl.searchParams.get("format"), "full");
    assert.equal(getUrl.searchParams.has("metadataHeaders"), false);
  });
});
