import type { EmailAddress, Message } from "@inboxlink/core";

export type GraphRecipient = {
  emailAddress?: { name?: string; address?: string };
};

export type GraphMessageResource = {
  id?: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  sentDateTime?: string;
  receivedDateTime?: string;
  parentFolderId?: string;
  hasAttachments?: boolean;
  body?: { contentType?: string; content?: string };
  categories?: string[];
};

const MAX_BODY_CHARS = 100_000;

/** Map a Microsoft Graph message resource onto the InboxLink message shape. */
export function normalizeGraphMessage(
  raw: GraphMessageResource,
  grantId: string,
): Message | undefined {
  if (!raw.id) return undefined;
  const receivedAt = toIso(raw.receivedDateTime) ?? toIso(raw.sentDateTime);
  const sentAt = toIso(raw.sentDateTime) ?? receivedAt;
  const message: Message = {
    id: `msg_${raw.id}`,
    grantId,
    providerMessageId: raw.id,
    subject: raw.subject ?? "",
    snippet: raw.bodyPreview ?? "",
    from: recipientList(raw.from ? [raw.from] : []),
    to: recipientList(raw.toRecipients),
    sentAt: sentAt ?? new Date(0).toISOString(),
    receivedAt: receivedAt ?? new Date(0).toISOString(),
    folderIds: raw.parentFolderId ? [raw.parentFolderId] : [],
    hasAttachments: Boolean(raw.hasAttachments),
  };
  if (raw.conversationId) message.threadId = raw.conversationId;
  const cc = recipientList(raw.ccRecipients);
  if (cc.length) message.cc = cc;
  if (raw.categories?.length) message.labels = [...raw.categories];
  const body = extractBody(raw.body);
  if (body.text || body.html) {
    message.body = {};
    if (body.text) message.body.text = body.text;
    if (body.html) message.body.html = body.html;
  }
  return message;
}

function recipientList(recipients: GraphRecipient[] | undefined): EmailAddress[] {
  const out: EmailAddress[] = [];
  for (const recipient of recipients ?? []) {
    const email = recipient.emailAddress?.address?.trim();
    if (!email) continue;
    const name = recipient.emailAddress?.name?.trim();
    out.push(name ? { name, email } : { email });
  }
  return out;
}

function extractBody(body: GraphMessageResource["body"]): { text?: string; html?: string } {
  if (!body?.content) return {};
  const content =
    body.content.length > MAX_BODY_CHARS
      ? body.content.slice(0, MAX_BODY_CHARS)
      : body.content;
  const kind = (body.contentType ?? "").toLowerCase();
  if (kind === "text") return { text: content };
  if (kind === "html") return { html: content };
  return { text: content };
}

function toIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}
