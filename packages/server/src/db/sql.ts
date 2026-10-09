import postgres from "postgres";

/** Parameterized SQL used by the Postgres store. `$1` placeholders. */
export interface SqlExecutor {
  query<T extends Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  exec(text: string): Promise<void>;
}

export function isLocalDatabaseUrl(databaseUrl: string): boolean {
  try {
    const hostname = new URL(databaseUrl).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

/**
 * Fail early with a readable message when DATABASE_URL is malformed (stray quotes, a
 * `psql '...'` prefix, whitespace, empty). The value is never included: it holds the password.
 */
export function assertValidDatabaseUrl(databaseUrl: string): void {
  let protocol = "";
  try {
    protocol = new URL(databaseUrl).protocol;
  } catch {
    /* handled below */
  }
  if ((protocol !== "postgres:" && protocol !== "postgresql:") || databaseUrl !== databaseUrl.trim()) {
    const trimmed = databaseUrl.trim();
    const hint = /^psql\b/i.test(trimmed)
      ? " (it starts with 'psql'; paste only the postgresql:// URL)"
      : trimmed === ""
        ? " (it is empty)"
        : /^["']|["']$/.test(databaseUrl)
          ? " (it is wrapped in quotes)"
          : databaseUrl !== trimmed
            ? " (it has leading or trailing whitespace)"
            : "";
    throw new Error(
      `DATABASE_URL is not a valid postgres:// or postgresql:// URL${hint}. Fix it in the host's environment variables.`,
    );
  }
}

/** One connection per serverless instance. `prepare: false` works with poolers. */
export function createPostgresClient(databaseUrl: string) {
  assertValidDatabaseUrl(databaseUrl);
  return postgres(databaseUrl, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: false,
    ssl: isLocalDatabaseUrl(databaseUrl) ? false : "require",
    // Startup migrations are idempotent (CREATE ... IF NOT EXISTS); drop the NOTICE spam
    // ("already exists, skipping") that otherwise floods logs on every cold start.
    onnotice: () => {},
  });
}

export class PostgresJsExecutor implements SqlExecutor {
  constructor(private readonly sql: ReturnType<typeof createPostgresClient>) {}

  async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    const rows = await this.sql.unsafe(text, bind(params) as never[]);
    return [...rows] as unknown as T[];
  }

  async exec(text: string): Promise<void> {
    await this.sql.unsafe(text);
  }
}

function bind(params: unknown[]): unknown[] {
  return params.map((value) => (value instanceof Uint8Array ? Buffer.from(value) : value));
}
