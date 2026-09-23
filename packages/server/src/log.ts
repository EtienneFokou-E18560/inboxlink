/**
 * Structured JSON logging with secret redaction.
 * Emits one JSON object per line to stdout/stderr — no paid APM required.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

const SENSITIVE_KEY =
  /(?:^|_)(authorization|cookie|set-cookie|password|passwd|secret|token|refresh[_-]?token|access[_-]?token|id[_-]?token|public[_-]?token|link[_-]?token|api[_-]?secret|master[_-]?key|client[_-]?secret|database[_-]?url|ciphertext|bearer)(?:$|_)/i;

const REDACTED = "[REDACTED]";

/** Values that look like OAuth tokens, Bearer headers, or connection strings. */
export function redactString(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\bya29\.[A-Za-z0-9._~+/-]+/g, REDACTED)
    .replace(/\b1\/\/[A-Za-z0-9_-]+/g, REDACTED)
    .replace(/\bAIza[A-Za-z0-9_-]+/g, REDACTED)
    .replace(/postgres(?:ql)?:\/\/[^\s"'\\]+/gi, REDACTED)
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"'\\]+/gi, REDACTED);
}

export function redactValue(value: unknown, keyHint = ""): unknown {
  if (value == null) return value;
  if (SENSITIVE_KEY.test(keyHint)) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, keyHint));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, k);
    }
    return out;
  }
  return String(value);
}

export function redactFields(fields: LogFields): LogFields {
  return redactValue(fields) as LogFields;
}

function emit(level: LogLevel, event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: "inboxlink",
    event,
    ...redactFields(fields),
  });
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.info(line);
  }
}

export const log = {
  debug: (event: string, fields?: LogFields) => emit("debug", event, fields),
  info: (event: string, fields?: LogFields) => emit("info", event, fields),
  warn: (event: string, fields?: LogFields) => emit("warn", event, fields),
  error: (event: string, fields?: LogFields) => emit("error", event, fields),
};

/** Paths that are polled often; successful checks stay quiet. */
export function isHealthPath(path: string): boolean {
  return path === "/" || path === "/health" || path === "/health/";
}

export const MEMORY_STORE_GUIDANCE =
  "Set DATABASE_URL so Production uses Postgres. In-memory storage does not survive Vercel multi-instance — do not run Connect until GET /health reports store=postgres.";

export const DATABASE_UNAVAILABLE_GUIDANCE =
  "Check DATABASE_URL and Postgres reachability (Neon or equivalent). Do not run Connect until health returns ok=true and store=postgres.";

export const NEEDS_REAUTH_GUIDANCE =
  "Refresh token rejected or Gmail returned 401/403. Start a new Connect session for this user; the previous grant is marked needs_reauth.";
