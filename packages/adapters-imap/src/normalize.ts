import type { EmailAddress, Message } from "@inboxlink/core";

/** Soft upper bound for text/html bodies returned to hosts. */
const MAX_BODY_CHARS = 100_000;

export type ImapEnvelopeAddress = {
  name?: string | null;
  address?: string | null;
};

export type ImapEnvelope = {
  subject?: string | null;
  from?: ImapEnvelopeAddress[] | null;
  to?: ImapEnvelopeAddress[] | null;
  cc?: ImapEnvelopeAddress[] | null;
  date?: Date | string | null;
  messageId?: string | null;
};

/** Minimal FETCH-shaped record used by the adapter (real or mock transport). */
export type ImapFetchedMessage = {
  uid: number;
  envelope?: ImapEnvelope | null;
  source?: Buffer | false | null;
  flags?: Set<string> | string[] | null;
};

/** Map an IMAP FETCH record onto the InboxLink message shape. */
export function normalizeImapMessage(
  raw: ImapFetchedMessage,
  grantId: string,
  folderId = "INBOX",
): Message | undefined {
  if (!Number.isFinite(raw.uid) || raw.uid <= 0) return undefined;
  const envelope = raw.envelope ?? {};
  const sentAt = fromDate(envelope.date) ?? new Date(0).toISOString();
  const body = extractBodies(raw.source);
  const flags = flagList(raw.flags);
  const message: Message = {
    id: `msg_imap_${folderId}_${raw.uid}`,
    grantId,
    providerMessageId: String(raw.uid),
    subject: envelope.subject?.trim() ?? "",
    snippet: snippetFrom(body.text, envelope.subject),
    from: mapAddresses(envelope.from),
    to: mapAddresses(envelope.to),
    sentAt,
    receivedAt: sentAt,
    folderIds: [folderId],
    labels: flags,
    hasAttachments: body.hasAttachments,
  };
  if (envelope.messageId?.trim()) {
    message.threadId = envelope.messageId.trim();
  }
  const cc = mapAddresses(envelope.cc);
  if (cc.length) message.cc = cc;
  if (body.text || body.html) {
    message.body = {};
    if (body.text) message.body.text = body.text;
    if (body.html) message.body.html = body.html;
  }
  return message;
}

function mapAddresses(list: ImapEnvelopeAddress[] | null | undefined): EmailAddress[] {
  if (!list?.length) return [];
  const out: EmailAddress[] = [];
  for (const entry of list) {
    const email = entry.address?.trim();
    if (!email) continue;
    const name = entry.name?.trim();
    out.push(name ? { name, email } : { email });
  }
  return out;
}

function fromDate(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return undefined;
    return value.toISOString();
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}

function flagList(flags: ImapFetchedMessage["flags"]): string[] {
  if (!flags) return [];
  if (flags instanceof Set) return [...flags];
  return [...flags];
}

function snippetFrom(text: string | undefined, subject: string | null | undefined): string {
  const source = (text ?? subject ?? "").replace(/\s+/g, " ").trim();
  if (!source) return "";
  return source.length > 160 ? `${source.slice(0, 157)}...` : source;
}

function extractBodies(source: Buffer | false | null | undefined): {
  text?: string;
  html?: string;
  hasAttachments: boolean;
} {
  if (!source || !Buffer.isBuffer(source) || source.length === 0) {
    return { hasAttachments: false };
  }
  const raw = source.toString("utf8");
  const hasAttachments = /Content-Disposition:\s*attachment/i.test(raw);
  const text = firstMimePart(raw, "text/plain");
  const html = firstMimePart(raw, "text/html");
  return {
    text: clip(text),
    html: clip(html),
    hasAttachments,
  };
}

/** Best-effort single-part extractor — not a full MIME parser. */
function firstMimePart(raw: string, mime: string): string | undefined {
  const boundaryMatch = raw.match(/boundary="?([^";\r\n]+)"?/i);
  if (!boundaryMatch?.[1]) {
    if (new RegExp(`Content-Type:\\s*${escapeRegExp(mime)}`, "i").test(raw)) {
      return bodyAfterHeaders(raw);
    }
    if (mime === "text/plain" && !/^Content-Type:/im.test(raw)) {
      return bodyAfterHeaders(raw);
    }
    return undefined;
  }
  const boundary = boundaryMatch[1];
  const parts = raw.split(`--${boundary}`);
  for (const part of parts) {
    if (!new RegExp(`Content-Type:\\s*${escapeRegExp(mime)}`, "i").test(part)) continue;
    if (/Content-Disposition:\s*attachment/i.test(part)) continue;
    const decoded = decodePart(part);
    if (decoded) return decoded;
  }
  return undefined;
}

function bodyAfterHeaders(part: string): string | undefined {
  const split = part.split(/\r?\n\r?\n/);
  if (split.length < 2) return undefined;
  return split.slice(1).join("\n\n").replace(/\r?\n--.*$/s, "").trim() || undefined;
}

function decodePart(part: string): string | undefined {
  const body = bodyAfterHeaders(part);
  if (!body) return undefined;
  const encoding = part.match(/Content-Transfer-Encoding:\s*(\S+)/i)?.[1]?.toLowerCase();
  if (encoding === "base64") {
    try {
      return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
    } catch {
      return undefined;
    }
  }
  if (encoding === "quoted-printable") {
    return decodeQuotedPrintable(body);
  }
  return body;
}

function decodeQuotedPrintable(value: string): string {
  const soft = value.replace(/=\r?\n/g, "");
  return soft.replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function clip(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.length > MAX_BODY_CHARS ? value.slice(0, MAX_BODY_CHARS) : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
