import { describe, it, expect } from 'vitest';
import { Secrets, type SafeStorage } from '@secrets/safe';

const stub: SafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
};

describe('Secrets', () => {
  it('round-trips plaintext through stubbed safeStorage', () => {
    const s = new Secrets(stub);
    const blob = s.encrypt('hunter2');
    expect(blob.toString()).toBe('enc:hunter2');
    expect(s.decrypt(blob)).toBe('hunter2');
  });
  it('throws SECRETS_UNAVAILABLE when encryption is not available', () => {
    const off: SafeStorage = { ...stub, isEncryptionAvailable: () => false };
    expect(() => new Secrets(off).encrypt('x')).toThrow(/SECRETS_UNAVAILABLE/);
    expect(() => new Secrets(off).decrypt(Buffer.from('x'))).toThrow(/SECRETS_UNAVAILABLE/);
  });
  it('round-trips empty string', () => {
    const s = new Secrets(stub);
    expect(s.decrypt(s.encrypt(''))).toBe('');
  });
  it('round-trips unicode', () => {
    const s = new Secrets(stub);
    const original = '🔑 héllo wørld';
    expect(s.decrypt(s.encrypt(original))).toBe(original);
  });
});
