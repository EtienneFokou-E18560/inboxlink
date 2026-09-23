/**
 * Host-facing message list filters → Gmail `users.messages.list` params.
 *
 * SPDX-License-Identifier: MIT
 */

export type MessageListFilters = {
  /** Gmail search query (`q`), optionally composed with structured fields. */
  q?: string;
  /** Gmail `labelIds` (e.g. INBOX, UNREAD, CATEGORY_PERSONAL). */
  labelIds?: string[];
  includeSpamTrash?: boolean;
};

export type ParsedMessageFilters =
  | { ok: true; filters: MessageListFilters }
  | { ok: false; error: string };

const MAX_Q = 2048;
const MAX_FIELD = 320;
const MAX_LABELS = 10;
const MAX_LABEL_LEN = 128;
/** Gmail system/user label ids are alphanumeric with `_`, `-`, and rare `/`. */
const LABEL_RE = /^[A-Za-z0-9_./-]+$/;

/**
 * Parse list-filter query params from the host API.
 * Structured `from` / `to` / `subject` are AND-merged into Gmail `q`.
 */
export function parseMessageListFilters(input: {
  q?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  subject?: string | undefined;
  labels?: string[];
  includeSpamTrash?: string | undefined;
}): ParsedMessageFilters {
  const parts: string[] = [];

  const rawQ = input.q?.trim();
  if (rawQ !== undefined && rawQ !== "") {
    if (rawQ.length > MAX_Q) return { ok: false, error: "invalid_q" };
    if (hasControlChars(rawQ)) return { ok: false, error: "invalid_q" };
    parts.push(rawQ);
  }

  for (const [op, value] of [
    ["from", input.from],
    ["to", input.to],
    ["subject", input.subject],
  ] as const) {
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed === "") continue;
    if (trimmed.length > MAX_FIELD) return { ok: false, error: `invalid_${op}` };
    if (hasControlChars(trimmed)) return { ok: false, error: `invalid_${op}` };
    parts.push(`${op}:${quoteGmailTerm(trimmed)}`);
  }

  const labelIds: string[] = [];
  for (const raw of input.labels ?? []) {
    const label = raw.trim();
    if (!label) continue;
    if (label.length > MAX_LABEL_LEN || !LABEL_RE.test(label)) {
      return { ok: false, error: "invalid_label" };
    }
    labelIds.push(label);
  }
  if (labelIds.length > MAX_LABELS) return { ok: false, error: "invalid_label" };

  let includeSpamTrash: boolean | undefined;
  const spam = input.includeSpamTrash?.trim().toLowerCase();
  if (spam !== undefined && spam !== "") {
    if (spam === "true" || spam === "1") includeSpamTrash = true;
    else if (spam === "false" || spam === "0") includeSpamTrash = false;
    else return { ok: false, error: "invalid_include_spam_trash" };
  }

  const q = parts.length > 0 ? parts.join(" ") : undefined;
  if (q && q.length > MAX_Q) return { ok: false, error: "invalid_q" };

  return {
    ok: true,
    filters: {
      ...(q ? { q } : {}),
      ...(labelIds.length > 0 ? { labelIds } : {}),
      ...(includeSpamTrash !== undefined ? { includeSpamTrash } : {}),
    },
  };
}

function quoteGmailTerm(value: string): string {
  if (/^[^\s"']+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function hasControlChars(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}
