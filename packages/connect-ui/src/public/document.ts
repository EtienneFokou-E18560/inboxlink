import { CONNECT_STYLES } from "../styles.js";
import { escapeHtml } from "../escape.js";

export type PublicDocumentOptions = {
  title: string;
  body: string;
  /** Extra CSS appended after shared Connect tokens (landing, status, docs). */
  extraStyles?: string;
  /** Optional class on the outer `.shell` wrapper. */
  shellClass?: string;
  /** Optional status for assistive tech. */
  statusRole?: "status" | "alert";
};

/**
 * Shared HTML document for public browser surfaces (landing, status, docs).
 * Reuses Connect ink/teal tokens + Fraunces/Figtree so parallel PRs share one system.
 */
export function renderPublicDocument(opts: PublicDocumentOptions): string {
  const title = escapeHtml(opts.title);
  const shellClass = opts.shellClass ? `shell ${opts.shellClass}` : "shell";
  const roleAttr = opts.statusRole ? ` role="${opts.statusRole}"` : "";
  const styles = opts.extraStyles
    ? `${CONNECT_STYLES}\n${opts.extraStyles}`
    : CONNECT_STYLES;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="color-scheme" content="light"/>
  <title>${title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;600;700&family=Fraunces:opsz,wght@9..144,600&display=swap" rel="stylesheet"/>
  <style>${styles}</style>
</head>
<body>
  <div class="${shellClass}"${roleAttr}>
    ${opts.body}
  </div>
</body>
</html>`;
}
