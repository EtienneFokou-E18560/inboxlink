# `@inboxlink/adapters-imap`

Password / app-password IMAP adapter for InboxLink.

## License

This package is **MIT**. It depends on **[imapflow](https://github.com/postalsys/imapflow)** (MIT), not EmailEngine or RustMailer (commercial / source-available products). Do not vendor those products into this repo.

## Scope (v0)

- Connect: verify TLS IMAP login, then seal `{ host, port, secure, user, password }` in the vault.
- List: open the vaulted secret, fetch a page of **INBOX** messages, normalize to InboxLink `Message`.
- CI uses an injectable transport — **no live IMAP** required.

## Honest limitations

- App-password / password auth only (no XOAUTH2 in this slice).
- INBOX only; no folder picker, IDLE, or UIDVALIDITY sync.
- Envelope + best-effort text body; MIME coverage is incomplete across servers.
- Diverse IMAP servers (STARTTLS quirks, AUTH mechanisms) are not fully explored.

## Security

- Never log `password`, sealed secrets, or full credential JSON.
- imapflow logging is disabled (`logger: false`) in the default transport.
