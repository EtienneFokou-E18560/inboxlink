import type { EmailAddress, Message } from "@inboxlink/core";

export type GmailMessageResource = {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
};

type GmailPart = {
  mimeType?: string;
  filename?: string;
  headers?: { name?: string; value?: string }[];
  body?: { data?: string; attachmentId?: string };
  parts?: GmailPart[];
};

const MAX_BODY_CHARS = 100_000;

const FOLDER_LABELS = new Set([
  "INBOX",
  "SENT",
  "DRAFT",
  "DRAFTS",
  "TRASH",
  "SPAM",
  "STARRED",
  "IMPORTANT",
  "CHAT",
]);

/** Map a Gmail users.messages resource onto the InboxLink message shape. */
export function normalizeGmailMessage(raw: GmailMessageResource, grantId: string): Message | undefined {
  if (!raw.id) return undefined;
  const headers = headerMap(raw.payload?.headers);
  const labels = raw.labelIds ?? [];
  const receivedAt = fromInternalDate(raw.internalDate) ?? fromHttpDate(headers.get("date"));
  const sentAt = fromHttpDate(headers.get("date")) ?? receivedAt;
  const body = collectBody(raw.payload);
  const message: Message = {
    id: `msg_${raw.id}`,
    grantId,
    providerMessageId: raw.id,
    subject: headers.get("subject") ?? "",
    snippet: raw.snippet ?? "",
    from: parseAddressList(headers.get("from")),
    to: parseAddressList(headers.get("to")),
    sentAt: sentAt ?? new Date(0).toISOString(),
    receivedAt: receivedAt ?? new Date(0).toISOString(),
    folderIds: labels.filter((label) => FOLDER_LABELS.has(label) || label.startsWith("CATEGORY_")),
    labels,
    hasAttachments: body.hasAttachments,
  };
  if (raw.threadId) message.threadId = raw.threadId;
  const cc = parseAddressList(headers.get("cc"));
  if (cc.length) message.cc = cc;
  if (body.text || body.html) {
    message.body = {};
    if (body.text) message.body.text = body.text;
    if (body.html) message.body.html = body.html;
  }
  return message;
}

function headerMap(headers: GmailPart["headers"]): Map<string, string> {
  const map = new Map<string, string>();
  for (const header of headers ?? []) {
    if (!header.name || header.value === undefined) continue;
    const key = header.name.toLowerCase();
    if (!map.has(key)) map.set(key, header.value);
  }
  return map;
}

function collectBody(part: GmailPart | undefined): {
  text?: string;
  html?: string;
  hasAttachments: boolean;
} {
  const found: { text?: string; html?: string; hasAttachments: boolean } = { hasAttachments: false };
  walk(part, found);
  return found;
}

function walk(part: GmailPart | undefined, found: { text?: string; html?: string; hasAttachments: boolean }): void {
  if (!part) return;
  const filename = part.filename?.trim() ?? "";
  if (filename || part.body?.attachmentId) found.hasAttachments = true;
  const mime = part.mimeType ?? "";
  const data = part.body?.data;
  if (data && mime === "text/plain" && !found.text) found.text = decodeBody(data);
  if (data && mime === "text/html" && !found.html) found.html = decodeBody(data);
  for (const child of part.parts ?? []) walk(child, found);
}

function decodeBody(data: string): string | undefined {
  try {
    const pad = data.length % 4 === 0 ? "" : "=".repeat(4 - (data.length % 4));
    const text = Buffer.from(data.replaceAll("-", "+").replaceAll("_", "/") + pad, "base64").toString("utf8");
    if (!text) return undefined;
    return text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text;
  } catch {
    return undefined;
  }
}

function parseAddressList(value: string | undefined): EmailAddress[] {
  if (!value?.trim()) return [];
  const addresses: EmailAddress[] = [];
  for (const part of splitAddresses(value)) {
    const parsed = parseAddress(part);
    if (parsed) addresses.push(parsed);
  }
  return addresses;
}

function splitAddresses(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    if (ch === "," && !quoted) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function parseAddress(raw: string): EmailAddress | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const angled = trimmed.match(/^(.*)<([^<>]+)>\s*$/);
  if (angled) {
    const name = angled[1]?.trim().replace(/^"|"$/g, "").trim() ?? "";
    const email = angled[2]?.trim() ?? "";
    if (!email) return undefined;
    return name ? { name, email } : { email };
  }
  return { email: trimmed.replace(/^"|"$/g, "") };
}

function fromInternalDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Number(value);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function fromHttpDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}
