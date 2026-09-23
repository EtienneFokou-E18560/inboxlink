import { openSecret, sealSecret, type TokenVault } from "@inboxlink/core";

/**
 * In-memory AES-GCM vault (dev / single-process).
 * Swap for Postgres `token_vault` + KMS KEK in production.
 */
export class MemoryTokenVault implements TokenVault {
  private readonly store = new Map<string, Uint8Array>();

  constructor(private readonly masterKey: string) {
    if (!masterKey || masterKey.length < 16) {
      throw new Error("INBOXLINK_MASTER_KEY must be at least 16 characters");
    }
  }

  async seal(
    plaintext: string,
    context: { grantId: string; tenantId: string },
  ): Promise<Uint8Array> {
    const ciphertext = sealSecret(this.masterKey, plaintext, aadFor(context));
    this.store.set(context.grantId, ciphertext);
    return ciphertext;
  }

  async open(
    ciphertext: Uint8Array,
    context: { grantId: string; tenantId: string },
  ): Promise<string> {
    return openSecret(this.masterKey, ciphertext, aadFor(context));
  }

  async destroy(grantId: string): Promise<void> {
    this.store.delete(grantId);
  }

  getCiphertext(grantId: string): Uint8Array | undefined {
    return this.store.get(grantId);
  }
}

function aadFor(context: { grantId: string; tenantId: string }): string {
  return `${context.tenantId}\0${context.grantId}`;
}
