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

/** One connection per serverless instance. `prepare: false` works with poolers. */
export function createPostgresClient(databaseUrl: string) {
  return postgres(databaseUrl, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: false,
    ssl: isLocalDatabaseUrl(databaseUrl) ? false : "require",
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
