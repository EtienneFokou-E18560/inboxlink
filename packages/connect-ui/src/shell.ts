import { CONNECT_STYLES } from "./styles.js";
import { escapeHtml } from "./escape.js";

export type ShellOptions = {
  title: string;
  body: string;
  /** Optional status for assistive tech (e.g. alert on error pages). */
  statusRole?: "status" | "alert";
};

export function renderShell(opts: ShellOptions): string {
  const title = escapeHtml(opts.title);
  const roleAttr = opts.statusRole ? ` role="${opts.statusRole}"` : "";
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
  <style>${CONNECT_STYLES}</style>
</head>
<body>
  <a class="skip-link" href="#connect-main">Skip to content</a>
  <div class="shell">
    <header>
      <p class="brand" aria-label="InboxLink">Inbox<span>Link</span></p>
    </header>
    <main id="connect-main" class="main"${roleAttr} tabindex="-1">
      <div class="panel">
        ${opts.body}
      </div>
    </main>
    <footer class="footer">Mailbox connection infrastructure · read-only access · host never holds your refresh token</footer>
  </div>
</body>
</html>`;
}
