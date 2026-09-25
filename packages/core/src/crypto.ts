/**
 * Envelope helpers for vaulted secrets (AES-256-GCM).
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Etienne Fokou
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function deriveKey(masterKey: string): Buffer {
  return createHash("sha256").update(masterKey, "utf8").digest();
}

/**
 * AES-256-GCM envelope helpers for the local/dev vault.
 * Production deployments should swap the KEK source for KMS while keeping this envelope shape.
 */
export function sealSecret(masterKey: string, plaintext: string, aad?: string): Uint8Array {
  const key = deriveKey(masterKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([iv, tag, encrypted]));
}

export function openSecret(masterKey: string, ciphertext: Uint8Array, aad?: string): string {
  const buf = Buffer.from(ciphertext);
  if (buf.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error("ciphertext too short");
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const data = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const key = deriveKey(masterKey);
  const decipher = createDecipheriv(ALGO, key, iv);
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}
