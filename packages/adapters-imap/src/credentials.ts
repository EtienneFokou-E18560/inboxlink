/**
 * IMAP login material sealed in the vault as JSON.
 * Never log this object or its `password` field.
 */
export type ImapCredentials = {
  host: string;
  port: number;
  /** Prefer true (IMAPS / port 993). STARTTLS on 143 is supported when false. */
  secure: boolean;
  user: string;
  /** Password or provider app-password. */
  password: string;
};

export class ImapCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapCredentialsError";
  }
}

export function parseImapCredentials(input: unknown): ImapCredentials {
  if (!input || typeof input !== "object") {
    throw new ImapCredentialsError("credentials_required");
  }
  const body = input as Record<string, unknown>;
  const host = asNonEmptyString(body.host);
  const user = asNonEmptyString(body.user);
  const password = asNonEmptyString(body.password);
  if (!host || !user || !password) {
    throw new ImapCredentialsError("host_user_pass_required");
  }
  if (host.length > 253 || user.length > 320 || password.length > 512) {
    throw new ImapCredentialsError("credentials_too_long");
  }
  const port = parsePort(body.port);
  if (port === null) throw new ImapCredentialsError("invalid_port");
  const secure = parseSecure(body.secure, port);
  return { host, port, secure, user, password };
}

/** Serialize for TokenVault.seal — callers must not log the result. */
export function serializeImapCredentials(credentials: ImapCredentials): string {
  return JSON.stringify({
    host: credentials.host,
    port: credentials.port,
    secure: credentials.secure,
    user: credentials.user,
    password: credentials.password,
  });
}

export function deserializeImapCredentials(plaintext: string): ImapCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext) as unknown;
  } catch {
    throw new ImapCredentialsError("invalid_secret");
  }
  return parseImapCredentials(parsed);
}

/**
 * Strip secrets from error messages / logs.
 * Replaces password and full credential JSON if they appear.
 */
export function redactSecrets(text: string, credentials?: ImapCredentials): string {
  let out = text;
  if (credentials?.password) {
    out = out.split(credentials.password).join("[redacted]");
  }
  if (credentials) {
    out = out.split(serializeImapCredentials(credentials)).join("[redacted-credentials]");
  }
  out = out.replace(/"password"\s*:\s*"[^"]*"/gi, '"password":"[redacted]"');
  return out;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parsePort(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return 993;
  if (typeof value === "number" && Number.isInteger(value)) {
    return value >= 1 && value <= 65535 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const port = Number(value);
    return port >= 1 && port <= 65535 ? port : null;
  }
  return null;
}

function parseSecure(value: unknown, port: number): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return port === 993;
}
