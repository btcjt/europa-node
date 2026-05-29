import { describe, expect, it } from 'vitest';
import { createDecipheriv, randomBytes } from 'node:crypto';
import { aesEncryptWithPreimage, sha256Hex } from './encrypt';

// Round-trip helper: the wallet-side decrypt for LNURL-pay
// `successAction: 'aes'`. Mirrors the BLW / Phoenix convention:
// auth tag is the last 16 bytes of the ciphertext.
function decryptWithPreimage(
  ciphertextBase64: string,
  ivBase64: string,
  preimage: Buffer,
): string {
  const combined = Buffer.from(ciphertextBase64, 'base64');
  const tag = combined.subarray(combined.length - 16);
  const encrypted = combined.subarray(0, combined.length - 16);
  const iv = Buffer.from(ivBase64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', preimage, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8');
}

describe('aesEncryptWithPreimage', () => {
  it('rejects a preimage that is not 32 bytes', () => {
    expect(() => aesEncryptWithPreimage('hi', Buffer.alloc(31))).toThrow(/32 bytes/);
    expect(() => aesEncryptWithPreimage('hi', Buffer.alloc(33))).toThrow(/32 bytes/);
  });

  it('round-trips: encrypt + matching-preimage decrypt → original plaintext', () => {
    const preimage = randomBytes(32);
    const plaintext = 'Tunnel: foo-bar baz_qux 🛰️';
    const { ciphertext, iv } = aesEncryptWithPreimage(plaintext, preimage);
    const recovered = decryptWithPreimage(ciphertext, iv, preimage);
    expect(recovered).toBe(plaintext);
  });

  it('a wrong preimage fails the GCM auth check (cannot silently decrypt)', () => {
    // Security property: GCM is authenticated; a wrong key must throw,
    // not produce garbage plaintext. This is the only thing standing
    // between a malicious wallet and reading another user's tunnel
    // metadata if it ever intercepts the successAction.
    const preimage = randomBytes(32);
    const wrong = randomBytes(32);
    const { ciphertext, iv } = aesEncryptWithPreimage('secret', preimage);
    expect(() => decryptWithPreimage(ciphertext, iv, wrong)).toThrow();
  });

  it('produces different ciphertext for the same plaintext (random IV)', () => {
    const preimage = randomBytes(32);
    const a = aesEncryptWithPreimage('repeat me', preimage);
    const b = aesEncryptWithPreimage('repeat me', preimage);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('handles an empty plaintext (auth-tag-only output)', () => {
    const preimage = randomBytes(32);
    const { ciphertext, iv } = aesEncryptWithPreimage('', preimage);
    expect(decryptWithPreimage(ciphertext, iv, preimage)).toBe('');
  });

  it('handles a multi-line plaintext (WireGuard configs are several lines)', () => {
    const preimage = randomBytes(32);
    const conf = `[Interface]\nPrivateKey=…\nAddress=10.42.0.2/32\n\n[Peer]\nPublicKey=…`;
    const { ciphertext, iv } = aesEncryptWithPreimage(conf, preimage);
    expect(decryptWithPreimage(ciphertext, iv, preimage)).toBe(conf);
  });
});

describe('sha256Hex', () => {
  it('matches the canonical sha256 of "abc"', () => {
    // NIST test vector — pins the algorithm choice.
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('works on a Buffer input the same as the string equivalent', () => {
    expect(sha256Hex(Buffer.from('abc', 'utf-8'))).toBe(sha256Hex('abc'));
  });

  it('returns a 64-char hex string for any input', () => {
    expect(sha256Hex('')).toHaveLength(64);
    expect(sha256Hex('x'.repeat(10_000))).toHaveLength(64);
  });
});
