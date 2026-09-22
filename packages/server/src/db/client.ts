/**
 * Postgres wiring stub.
 * Wire drizzle with a `postgres` / `pg` driver when DATABASE_URL is set.
 * v0 keeps an in-memory store for local demos without Postgres.
 */
export function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}
