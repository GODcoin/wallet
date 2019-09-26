import { createHash, randomBytes } from 'crypto';
import sodium from 'libsodium-wrappers';
import assert from 'assert';

/**
 * Provides a friendly interface around the secretbox crypto APIs provided by libsodium.
 */
export class SecretKey {
  private key?: Uint8Array;

  constructor(key: Uint8Array) {
    this.key = key;
    assert(key.byteLength === sodium.crypto_secretbox_KEYBYTES, 'expected key length to be secretbox KEYBYTES');
  }

  public encrypt(data: Buffer | Uint8Array): Buffer {
    assert(this.key !== undefined, 'key has been zeroed');
    const nonce = randomBytes(sodium.crypto_secretbox_NONCEBYTES);
    const enc = sodium.crypto_secretbox_easy(data, nonce, this.key!);
    return Buffer.concat([nonce, enc]);
  }

  public decrypt(data: Buffer | Uint8Array): Buffer {
    assert(this.key !== undefined, 'key has been zeroed');
    assert(data.byteLength > sodium.crypto_secretbox_NONCEBYTES, 'data must be at least NONCEBYTES + 1 bytes');
    const nonce = data.slice(0, sodium.crypto_secretbox_NONCEBYTES);
    const enc = data.slice(sodium.crypto_secretbox_NONCEBYTES);

    try {
      const dec = sodium.crypto_secretbox_open_easy(enc, nonce, this.key!);
      return Buffer.from(dec);
    } catch (e) {
      throw new DecryptError(e.message);
    }
  }

  public bytes(): Uint8Array {
    assert(this.key !== undefined, 'key has been zeroed');
    return this.key!;
  }

  public zero(): void {
    if (this.key) {
      sodium.memzero(this.key);
      this.key = undefined;
    }
  }

  public static fromString(password: string): SecretKey {
    const hasher = createHash('sha256');
    hasher.update(password);
    const hash = hasher.digest();
    return new SecretKey(hash);
  }
}

export enum DecryptErrorType {
  INCORRECT_PASSWORD = 'incorrect_password',
  UNKNOWN = 'unknown_error',
}

export class DecryptError extends Error {
  public readonly type: DecryptErrorType;

  constructor(msg: string) {
    super(msg);
    switch (msg) {
      case 'wrong secret key for the given ciphertext':
        this.type = DecryptErrorType.INCORRECT_PASSWORD;
        break;
      default:
        this.type = DecryptErrorType.UNKNOWN;
    }
    Object.setPrototypeOf(this, DecryptError.prototype);
  }
}
