import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseMessageListFilters } from "./message-filters.js";

describe("parseMessageListFilters", () => {
  it("returns empty filters when no params are set", () => {
    assert.deepEqual(parseMessageListFilters({}), { ok: true, filters: {} });
  });

  it("passes through a Gmail q string", () => {
    const parsed = parseMessageListFilters({ q: "is:unread newer_than:7d" });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.filters.q, "is:unread newer_than:7d");
  });

  it("composes structured from/to/subject into q", () => {
    const parsed = parseMessageListFilters({
      from: "ada@example.com",
      to: "etiennefk@gmail.com",
      subject: "Normalized hello",
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(
      parsed.filters.q,
      'from:ada@example.com to:etiennefk@gmail.com subject:"Normalized hello"',
    );
  });

  it("AND-merges raw q with structured fields", () => {
    const parsed = parseMessageListFilters({
      q: "is:unread",
      from: "ada@example.com",
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.filters.q, "is:unread from:ada@example.com");
  });

  it("collects label ids and includeSpamTrash", () => {
    const parsed = parseMessageListFilters({
      labels: ["INBOX", "UNREAD"],
      includeSpamTrash: "true",
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.filters.labelIds, ["INBOX", "UNREAD"]);
    assert.equal(parsed.filters.includeSpamTrash, true);
  });

  it("rejects invalid label, oversized q, and bad includeSpamTrash", () => {
    assert.equal(parseMessageListFilters({ labels: ["bad label"] }).ok, false);
    assert.equal(parseMessageListFilters({ q: "x".repeat(2049) }).ok, false);
    assert.equal(parseMessageListFilters({ includeSpamTrash: "maybe" }).ok, false);
    assert.equal(parseMessageListFilters({ from: "a\nb" }).ok, false);
  });
});
