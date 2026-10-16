import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Grant } from "@inboxlink/core";
import { PgDatabase, PostgresStore, PostgresTokenVault } from "./db/postgres-store.js";
import type { SqlExecutor } from "./db/sql.js";
import { replaceEarlierGrants } from "./grants-replace.js";

class PgliteExecutor implements SqlExecutor {
  constructor(private readonly db: PGlite) {}

  async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    return (await this.db.query<T>(text, params)).rows;
  }

  async exec(text: string): Promise<void> {
    await this.db.exec(text);
  }
}

/** The shipped report without psql's \echo lines and comments, split into its queries. */
const REPORT = readFileSync(new URL("../../../scripts/shared-address-report.sql", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => !line.startsWith("\\echo") && !line.trimStart().startsWith("--"))
  .join("\n")
  .split(";")
  .map((query) => query.trim())
  .filter(Boolean);

function grant(id: string, externalUserId: string, status: Grant["status"], email: string): Grant {
  return {
    id,
    tenantId: "default",
    externalUserId,
    provider: "gmail",
    email,
    status,
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    createdAt: `2026-10-0${id.slice(-1)}T10:00:00.000Z`,
    updatedAt: `2026-10-0${id.slice(-1)}T10:00:00.000Z`,
  };
}

describe("shared-address report and replacement on Postgres (#371)", () => {
  it("counts the issue's three grants before and none live-shared after a connect", async () => {
    assert.equal(REPORT.length, 2, "summary and per-grant queries");
    const pg = new PGlite();
    const db = new PgDatabase(new PgliteExecutor(pg));
    const store = new PostgresStore(db);
    const vault = new PostgresTokenVault(db, "test-master-key-at-least-16");
    await store.ready();

    // The situation found on 2026-10-13: one inbox, three identities.
    await store.putGrant(grant("grant_1", "3f2a9c1e-uuid", "active", "owner@gmail.com"));
    await store.putGrant(grant("grant_2", "anon_9b1d", "needs_reauth", "Owner@gmail.com"));
    await store.putGrant(grant("grant_3", "google:1077", "needs_reauth", "owner@gmail.com"));
    await store.putGrant(grant("grant_4", "anon_other", "active", "someone@gmail.com"));
    for (const id of ["grant_1", "grant_2", "grant_3"]) {
      await vault.seal(`1//refresh-${id}`, { grantId: id, tenantId: "default" });
    }

    const [summary, detail] = REPORT as [string, string];
    const before = (await pg.query<Record<string, unknown>>(summary)).rows;
    assert.deepEqual(before, [
      {
        tenant: "default",
        shared_addresses: 1,
        addresses_with_several_live_grants: 1,
        grants_on_shared_addresses: 3,
        live_grants_on_shared_addresses: 3,
      },
    ]);
    const rows = (await pg.query<{ grant_id: string; identity_kind: string }>(detail)).rows;
    assert.deepEqual(
      rows.map((r) => [r.grant_id, r.identity_kind]),
      [
        ["grant_1", "account"],
        ["grant_2", "anonymous"],
        ["grant_3", "google"],
      ],
    );
    assert.equal(JSON.stringify(rows).includes("@"), false, "no address in the report");

    // The owner connects again from the Google sign-in identity.
    const fresh = grant("grant_5", "google:1077", "active", "owner@gmail.com");
    await store.putGrant(fresh);
    await vault.seal("1//refresh-new", { grantId: fresh.id, tenantId: "default" });
    const replaced = await replaceEarlierGrants({ store, vault, grant: fresh });
    assert.deepEqual(replaced, ["grant_1", "grant_2", "grant_3"]);

    const after = (await pg.query<Record<string, unknown>>(summary)).rows;
    assert.deepEqual(after, [
      {
        tenant: "default",
        shared_addresses: 1,
        addresses_with_several_live_grants: 0,
        grants_on_shared_addresses: 4,
        live_grants_on_shared_addresses: 1,
      },
    ]);
    assert.deepEqual((await pg.query(detail)).rows, []);

    const old = await store.getGrant("grant_2");
    assert.equal(old?.status, "revoked");
    assert.equal(old?.replacedBy, "grant_5");
    assert.equal(await vault.getCiphertext("grant_2"), undefined);
    assert.equal((await store.getGrant("grant_4"))?.status, "active", "other mailbox untouched");
    assert.equal((await store.getGrant("grant_5"))?.replacedBy, undefined);
  });
});
