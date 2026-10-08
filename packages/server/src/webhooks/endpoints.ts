import { isIP } from "node:net";
import { newId, openSecret, randomToken, sealSecret } from "@inboxlink/core";
import type { PgDatabase } from "../db/postgres-store.js";
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from "./deliver.js";

export const MAX_WEBHOOK_ENDPOINTS_PER_TENANT = 5;
const MAX_URL_LENGTH = 2048;

/** Public shape (never includes the signing secret). */
export type WebhookEndpoint = {
  id: string;
  tenantId: string;
  url: string;
  /** Empty = subscribe to every event type. */
  events: WebhookEventType[];
  createdAt: string;
};

type StoredEndpoint = WebhookEndpoint & {
  /** base64 AES-GCM envelope of the signing secret (master key + tenant/id AAD). */
  secretCiphertext: string;
};

export interface WebhookEndpointStore {
  insert(endpoint: StoredEndpoint): Promise<void>;
  listByTenant(tenantId: string): Promise<StoredEndpoint[]>;
  delete(id: string, tenantId: string): Promise<boolean>;
}

export class MemoryWebhookEndpointStore implements WebhookEndpointStore {
  private readonly rows = new Map<string, StoredEndpoint>();

  async insert(endpoint: StoredEndpoint): Promise<void> {
    this.rows.set(endpoint.id, endpoint);
  }

  async listByTenant(tenantId: string): Promise<StoredEndpoint[]> {
    return [...this.rows.values()]
      .filter((r) => r.tenantId === tenantId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async delete(id: string, tenantId: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return false;
    return this.rows.delete(id);
  }
}

type EndpointRow = {
  id: string;
  tenant_id: string;
  url: string;
  events: unknown;
  secret_ciphertext: string;
  created_at: Date | string;
};

export class PostgresWebhookEndpointStore implements WebhookEndpointStore {
  constructor(private readonly db: PgDatabase) {}

  async insert(e: StoredEndpoint): Promise<void> {
    await this.db.ensure();
    await this.db.sql.query(
      `INSERT INTO webhook_endpoints (id, tenant_id, url, events, secret_ciphertext, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [e.id, e.tenantId, e.url, JSON.stringify(e.events), e.secretCiphertext, e.createdAt],
    );
  }

  async listByTenant(tenantId: string): Promise<StoredEndpoint[]> {
    await this.db.ensure();
    const rows = await this.db.sql.query<EndpointRow>(
      `SELECT id, tenant_id, url, events, secret_ciphertext, created_at
         FROM webhook_endpoints WHERE tenant_id = $1 ORDER BY created_at ASC`,
      [tenantId],
    );
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      url: r.url,
      events: (Array.isArray(r.events) ? r.events : []) as WebhookEventType[],
      secretCiphertext: r.secret_ciphertext,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }));
  }

  async delete(id: string, tenantId: string): Promise<boolean> {
    await this.db.ensure();
    const rows = await this.db.sql.query<{ id: string }>(
      `DELETE FROM webhook_endpoints WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [id, tenantId],
    );
    return rows.length > 0;
  }
}

function aadFor(tenantId: string, id: string): string {
  return `webhook\0${tenantId}\0${id}`;
}

function toPublic(row: StoredEndpoint): WebhookEndpoint {
  const { secretCiphertext: _omit, ...rest } = row;
  return rest;
}

export type DeliveryTarget = { id: string; url: string; secret: string };

/** Per-tenant webhook destinations with sealed signing secrets. */
export class WebhookRegistry {
  constructor(
    private readonly store: WebhookEndpointStore,
    private readonly masterKey: string,
    private readonly opts: { allowInsecureUrls?: boolean } = {},
  ) {}

  validateUrl(raw: unknown): string | null {
    return validateWebhookUrl(raw, { allowInsecure: this.opts.allowInsecureUrls });
  }

  /** Returns the endpoint plus its secret. The secret is shown exactly once. */
  async create(input: {
    tenantId: string;
    url: string;
    events?: WebhookEventType[];
  }): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
    const existing = await this.store.listByTenant(input.tenantId);
    if (existing.length >= MAX_WEBHOOK_ENDPOINTS_PER_TENANT) {
      throw new WebhookLimitError();
    }
    const id = newId("whe");
    const secret = `whsec_${randomToken(32)}`;
    const sealed = sealSecret(this.masterKey, secret, aadFor(input.tenantId, id));
    const stored: StoredEndpoint = {
      id,
      tenantId: input.tenantId,
      url: input.url,
      events: input.events ?? [],
      createdAt: new Date().toISOString(),
      secretCiphertext: Buffer.from(sealed).toString("base64"),
    };
    await this.store.insert(stored);
    return { endpoint: toPublic(stored), secret };
  }

  async list(tenantId: string): Promise<WebhookEndpoint[]> {
    return (await this.store.listByTenant(tenantId)).map(toPublic);
  }

  delete(id: string, tenantId: string): Promise<boolean> {
    return this.store.delete(id, tenantId);
  }

  /** Endpoints subscribed to `type`, with secrets opened for signing. */
  async targetsFor(tenantId: string, type: WebhookEventType): Promise<DeliveryTarget[]> {
    const rows = await this.store.listByTenant(tenantId);
    const out: DeliveryTarget[] = [];
    for (const row of rows) {
      if (row.events.length > 0 && !row.events.includes(type)) continue;
      try {
        const secret = openSecret(
          this.masterKey,
          new Uint8Array(Buffer.from(row.secretCiphertext, "base64")),
          aadFor(row.tenantId, row.id),
        );
        out.push({ id: row.id, url: row.url, secret });
      } catch {
        // Undecryptable (e.g. master key changed): skip rather than fail delivery for others.
      }
    }
    return out;
  }
}

export class WebhookLimitError extends Error {
  constructor() {
    super("webhook_limit_reached");
  }
}

export function parseEventTypes(raw: unknown): WebhookEventType[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const known = new Set<string>(WEBHOOK_EVENT_TYPES);
  const out: WebhookEventType[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !known.has(item)) return null;
    if (!out.includes(item as WebhookEventType)) out.push(item as WebhookEventType);
  }
  return out;
}

function isPrivateIPv4(host: string): boolean {
  const [a, b] = host.split(".").map(Number) as [number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isPrivateHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  const kind = isIP(host);
  if (kind === 4) return isPrivateIPv4(host);
  if (kind === 6) {
    return (
      host === "::1" ||
      host === "::" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe80") ||
      host.startsWith("::ffff:")
    );
  }
  return false;
}

/**
 * Accept only public https URLs (no credentials). `allowInsecure` (non-hosted dev)
 * also permits http and localhost. DNS rebinding is not defended here.
 */
export function validateWebhookUrl(
  raw: unknown,
  opts: { allowInsecure?: boolean } = {},
): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (opts.allowInsecure) {
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  }
  if (url.protocol !== "https:") return null;
  if (isPrivateHost(url.hostname)) return null;
  return url.toString();
}
