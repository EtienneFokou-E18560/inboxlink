/** Escape text for safe interpolation into HTML text/attribute contexts. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Decode entities produced by {@link escapeHtml} (e.g. attribute values in tests).
 * `&amp;` is replaced last so sequences like `&amp;quot;` are not double-unescaped.
 */
export function unescapeHtml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
