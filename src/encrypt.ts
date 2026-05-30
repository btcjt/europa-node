import { createCipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * LNURL-pay LUD-10 `successAction: 'aes'` encryption.
 *
 * LUD-10 specifies AES/CBC/PKCS5Padding with the Lightning payment
 * preimage as the 32-byte AES-256 key and a 16-byte IV.
 */
export function aesEncryptWithPreimage(plaintext: string, preimage: Buffer): {
  ciphertext: string;
  iv: string;
} {
  if (preimage.length !== 32) {
    throw new Error(`preimage must be 32 bytes, got ${preimage.length}`);
  }

  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', preimage, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);

  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
  };
}

export function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}
