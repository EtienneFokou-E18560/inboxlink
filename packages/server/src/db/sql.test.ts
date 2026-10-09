import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertValidDatabaseUrl } from "./sql.js";

describe("assertValidDatabaseUrl", () => {
  it("accepts postgres URLs", () => {
    assertValidDatabaseUrl("postgresql://u:p@host.example/db?sslmode=require");
    assertValidDatabaseUrl("postgres://u:p@localhost:5432/db");
  });

  it("explains common mistakes without echoing the value", () => {
    const cases: [string, RegExp][] = [
      ["", /empty/],
      ['"postgresql://u:secret@h/db"', /quotes/],
      ["postgresql://u:secret@h/db ", /whitespace/],
      ["psql 'postgresql://u:secret@h/db'", /psql/],
      ["mysql://u:secret@h/db", /not a valid/],
    ];
    for (const [value, hint] of cases) {
      assert.throws(
        () => assertValidDatabaseUrl(value),
        (err: Error) => hint.test(err.message) && !err.message.includes("secret"),
        value,
      );
    }
  });
});
