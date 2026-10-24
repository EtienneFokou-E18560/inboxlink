# `@inboxlink/core` changelog

## 0.3.0

Companion release with `@inboxlink/sdk@0.3.0`. No public type changes. The server's synced store now keeps inbox metadata only, so a `Message` read from the store has empty `from`/`to`, no `body`, `sentAt` equal to `receivedAt` and `hasAttachments: false` (see the SDK changelog).

## 0.2.0

Companion release with `@inboxlink/sdk@0.2.0`. Additive only.

- `CreateLinkSessionInput.replacesGrantId?: string`: the host user's own grant a Connect replaces (see the SDK changelog for the per-tenant Connect rule).

## 0.1.3

Companion release with `@inboxlink/sdk@0.1.3`. Additive only.

- `MessageHeaders` and `Message.headers?: MessageHeaders`: raw `List-Unsubscribe`, `Precedence` and `Auto-Submitted` values, filled on the live messages list only (see the SDK changelog).
- `Message.folderIds` and `Message.labels` now document which carries Gmail's `labelIds` (`labels`, unchanged) and which is the folder-like subset (`folderIds`).
- `Grant.replacedBy?: string`: set on a grant that a later Connect of the same mailbox (same tenant, provider and address) took over; such a grant is `revoked`. Additive, no breaking change.

## 0.1.2

Companion release with `@inboxlink/sdk@0.1.2`. No public type changes. Published with npm Trusted Publishing (no token) from `publish-npm.yml`, with a provenance attestation.

## 0.1.1

Companion release with `@inboxlink/sdk@0.1.1`. No new public types were required for Gmail message list filters (filter options live on the SDK client). Version kept in lockstep so hosts resolve a matching core dependency from the registry.

Publish path unchanged: Actions → **Publish npm packages** (`publish-npm.yml`). Public GitHub source enables npm provenance on this release.

## 0.1.0

Initial public npm release: shared types, normalized models, adapter interfaces, and vault crypto helpers.
