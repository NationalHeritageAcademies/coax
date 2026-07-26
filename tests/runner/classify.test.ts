import { describe, expect, it } from 'vitest';
import { classify } from '@runner/worker.js';

function err(message: string, code?: string, causeCode?: string): Error & { code?: string; cause?: { code?: string } } {
  const e = new Error(message) as Error & { code?: string; cause?: { code?: string } };
  if (code !== undefined) e.code = code;
  if (causeCode !== undefined) e.cause = { code: causeCode };
  return e;
}

describe('classify()', () => {
  it('categorizes DEPTH_ZERO_SELF_SIGNED_CERT as tls', () => {
    expect(classify(err('self signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT'))).toBe('tls');
  });

  it('categorizes SELF_SIGNED_CERT_IN_CHAIN as tls', () => {
    expect(classify(err('self signed certificate in certificate chain', 'SELF_SIGNED_CERT_IN_CHAIN'))).toBe('tls');
  });

  it('categorizes UNABLE_TO_VERIFY_LEAF_SIGNATURE as tls', () => {
    expect(classify(err('unable to verify the first certificate', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'))).toBe('tls');
  });

  it('categorizes ERR_TLS_CERT_ALTNAME_INVALID as tls', () => {
    expect(classify(err("Hostname/IP doesn't match", 'ERR_TLS_CERT_ALTNAME_INVALID'))).toBe('tls');
  });

  it('catches "self signed" in the message even without a known code', () => {
    expect(classify(err('self signed certificate'))).toBe('tls');
  });

  it('catches "self-signed" (hyphenated) in the message', () => {
    expect(classify(err('peer used self-signed cert'))).toBe('tls');
  });

  it('still categorizes CERT_HAS_EXPIRED as tls', () => {
    expect(classify(err('certificate has expired', 'CERT_HAS_EXPIRED'))).toBe('tls');
  });

  it('uses cause.code when the outer error has no code', () => {
    expect(classify(err('self signed certificate', undefined, 'DEPTH_ZERO_SELF_SIGNED_CERT'))).toBe('tls');
  });

  it('returns network for ECONNREFUSED', () => {
    expect(classify(err('connect ECONNREFUSED', 'ECONNREFUSED'))).toBe('network');
  });

  it('returns aborted for ABORT_ERR', () => {
    expect(classify(err('aborted', 'ABORT_ERR'))).toBe('aborted');
  });

  it('returns unknown for unrelated errors', () => {
    expect(classify(err('something weird'))).toBe('unknown');
  });
});
