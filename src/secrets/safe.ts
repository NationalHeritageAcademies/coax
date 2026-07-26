export interface SafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export class Secrets {
  constructor(private readonly safe: SafeStorage) {}

  encrypt(plaintext: string): Buffer {
    if (!this.safe.isEncryptionAvailable()) throw new Error('SECRETS_UNAVAILABLE');
    return this.safe.encryptString(plaintext);
  }

  decrypt(blob: Buffer): string {
    if (!this.safe.isEncryptionAvailable()) throw new Error('SECRETS_UNAVAILABLE');
    return this.safe.decryptString(blob);
  }
}
