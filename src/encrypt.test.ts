import { describe, expect, it } from 'vitest';
import { createDecipheriv, randomBytes } from 'node:crypto';
import { aesEncryptWithPreimage, sha256Hex } from './encrypt';

function decryptWithPreimage(
  ciphertextBase64: string,
  ivBase64: string,
  preimage: Buffer,
): string {
  const encrypted = Buffer.from(ciphertextBase64, 'base64');
  const iv = Buffer.from(ivBase64, 'base64');
  const decipher = createDecipheriv('aes-256-cbc', preimage, iv);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf-8');
}

describe('aesEncryptWithPreimage', () => {
  it('rejects a preimage that is not 32 bytes', () => {
    expect(() => aesEncryptWithPreimage('hi', Buffer.alloc(31))).toThrow(/32 bytes/);
    expect(() => aesEncryptWithPreimage('hi', Buffer.alloc(33))).toThrow(/32 bytes/);
  });

  it('round-trips with AES-CBC and the matching preimage', () => {
    const preimage = randomBytes(32);
    const plaintext = 'Tunnel: foo-bar baz_qux 🛰️';
    const { ciphertext, iv } = aesEncryptWithPreimage(plaintext, preimage);

    expect(Buffer.from(iv, 'base64')).toHaveLength(16);

    const recovered = decryptWithPreimage(ciphertext, iv, preimage);
    expect(recovered).toBe(plaintext);
  });

  it('does not decrypt correctly with a wrong preimage', () => {
    const preimage = randomBytes(32);
    const wrong = randomBytes(32);
    const plaintext = 'secret';
    const { ciphertext, iv } = aesEncryptWithPreimage(plaintext, preimage);

    let recovered: string | undefined;
    let threw = false;

    try {
      recovered = decryptWithPreimage(ciphertext, iv, wrong);
    } catch {
      threw = true;
    }

    expect(threw || recovered !== plaintext).toBe(true);
  });

  it('produces different ciphertext for the same plaintext', () => {
    const preimage = randomBytes(32);
    const a = aesEncryptWithPreimage('repeat me', preimage);
    const b = aesEncryptWithPreimage('repeat me', preimage);

    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('handles an empty plaintext', () => {
    const preimage = randomBytes(32);
    const { ciphertext, iv } = aesEncryptWithPreimage('', preimage);
    expect(decryptWithPreimage(ciphertext, iv, preimage)).toBe('');
  });

  it('handles a multi-line plaintext', () => {
    const preimage = randomBytes(32);
    const conf = `[Interface]\nPrivateKey=…\nAddress=10.42.0.2/32\n\n[Peer]\nPublicKey=…`;
    const { ciphertext, iv } = aesEncryptWithPreimage(conf, preimage);
    expect(decryptWithPreimage(ciphertext, iv, preimage)).toBe(conf);
  });
});

describe('sha256Hex', () => {
  it('matches the canonical sha256 of "abc"', () => {
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
