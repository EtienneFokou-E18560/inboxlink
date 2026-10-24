import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Encryption for the subject and snippet the message store keeps (issue #86).
 * AES-256-GCM with a key derived from `INBOXLINK_MASTER_KEY` by HKDF-SHA256 under
 * its own label, so it is never the token vault's key. The grant id and the field
 * name are the additional data: a ciphertext opens only for its own grant and field.
 */

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HKDF_SALT = "inboxlink";
const HKDF_INFO = "inboxlink/message-metadata/v1";

export type MessageField = "subject" | "snippet";

export function deriveMessageKey(masterKey: string): Buffer {
  if (!masterKey || masterKey.length < 16) {
    throw new Error("INBOXLINK_MASTER_KEY must be at least 16 characters");
  }
  return Buffer.from(hkdfSync("sha256", masterKey, HKDF_SALT, HKDF_INFO, 32));
}

function aad(context: { grantId: string; field: MessageField }): Buffer {
  return Buffer.from(`message\0${context.field}\0${context.grantId}`, "utf8");
}

/** `iv | tag | ciphertext`, the same layout as the token vault. */
export function sealMessageField(
  key: Buffer,
  plaintext: string,
  context: { grantId: string; field: MessageField },
): Uint8Array {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  cipher.setAAD(aad(context));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), encrypted]));
}

/** Throws when the key, the grant id or the field does not match. */
export function openMessageField(
  key: Buffer,
  ciphertext: Uint8Array,
  context: { grantId: string; field: MessageField },
): string {
  const buf = Buffer.from(ciphertext);
  if (buf.length < IV_LENGTH + TAG_LENGTH) throw new Error("ciphertext too short");
  const decipher = createDecipheriv(ALGO, key, buf.subarray(0, IV_LENGTH));
  decipher.setAAD(aad(context));
  decipher.setAuthTag(buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
  return Buffer.concat([decipher.update(buf.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]).toString("utf8");
}
