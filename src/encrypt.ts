import { createCipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM with the Lightning preimage as the key, per the LNURL-pay
 * `successAction: 'aes'` envelope. The preimage is exactly 32 bytes,
 * so we use it directly as the AES-256 key.
 *
 * Returns base64-encoded ciphertext and IV. The auth tag is appended
 * to the ciphertext, matching what LNURL-pay clients expect (no
 * standard for it — most clients accept either form, but appending the
 * tag matches the BLW / Phoenix wallets' implementation).
 */
export function aesEncryptWithPreimage(plaintext: string, preimage: Buffer): {
  ciphertext: string;
  iv: string;
} {
  if (preimage.length !== 32) {
    throw new Error(`preimage must be 32 bytes, got ${preimage.length}`);
  }
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', preimage, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([encrypted, tag]).toString('base64'),
    iv: iv.toString('base64'),
  };
}

export function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}
