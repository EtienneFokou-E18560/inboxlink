const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
};

/**
 * Gmail returns `snippet` with HTML entities still in it ("We&#39;re grateful &amp; ready").
 * The preview is plain text for consumers, so decode it once here.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1]!.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return NAMED[entity.toLowerCase()] ?? match;
  });
}

/** `charset` parameter of a Content-Type header value, lower-cased. */
export function charsetOf(contentType: string | undefined): string | undefined {
  const match = contentType?.match(/charset\s*=\s*"?([^";\s]+)"?/i);
  return match?.[1]?.toLowerCase();
}

/**
 * Decode bytes with the part's declared charset (iso-8859-1, windows-1252, ...).
 * Unknown or missing charsets fall back to UTF-8 rather than failing.
 */
export function decodeWithCharset(bytes: Uint8Array, charset: string | undefined): string {
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      /* unsupported label: use UTF-8 */
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}
