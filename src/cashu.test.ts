import { describe, expect, it } from 'vitest';
import { normalizeMintUrl } from './cashu';

// We only unit-test the URL normaliser here. The rest of CashuAdapter
// (constructor, receive) does real network I/O against a CashuMint
// instance — covered by integration tests against a local nutshell.

describe('normalizeMintUrl', () => {
  it('strips a single trailing slash', () => {
    expect(normalizeMintUrl('https://mint.example.com/')).toBe(
      'https://mint.example.com',
    );
  });

  it('strips multiple trailing slashes', () => {
    expect(normalizeMintUrl('https://mint.example.com///')).toBe(
      'https://mint.example.com',
    );
  });

  it('lowercases the scheme and host', () => {
    expect(normalizeMintUrl('HTTPS://Mint.Example.Com')).toBe(
      'https://mint.example.com',
    );
  });

  it('preserves the path so sub-path-mounted mints still compare equal', () => {
    // The bolverker.com/cashu case from the buyer-side bug.
    expect(normalizeMintUrl('https://bolverker.com/cashu')).toBe(
      'https://bolverker.com/cashu',
    );
    expect(normalizeMintUrl('https://bolverker.com/cashu/')).toBe(
      'https://bolverker.com/cashu',
    );
  });

  it('preserves path casing (some servers are case-sensitive on paths)', () => {
    expect(normalizeMintUrl('https://host.com/Cashu/Mint')).toBe(
      'https://host.com/Cashu/Mint',
    );
  });

  it('makes two superficially-different URLs compare equal', () => {
    // The actual money bug: operator publishes `https://mint.com`,
    // wallet sends a token whose decoded.mint is `https://mint.com/`,
    // adapter used to reject as wrong-mint. Now they normalize to the
    // same key.
    expect(normalizeMintUrl('https://Mint.Com/')).toBe(
      normalizeMintUrl('https://mint.com'),
    );
  });

  it('idempotent: normalising the result again yields the same string', () => {
    const inputs = [
      'https://mint.example.com',
      'https://mint.example.com/',
      'HTTPS://Mint.Example.Com//',
      'https://bolverker.com/cashu/',
    ];
    for (const i of inputs) {
      const once = normalizeMintUrl(i);
      const twice = normalizeMintUrl(once);
      expect(twice).toBe(once);
    }
  });

  it('falls back to a best-effort lowercase + trim on malformed input', () => {
    // `new URL` throws on these — exercise the fallback path.
    expect(normalizeMintUrl('not-a-url/')).toBe('not-a-url');
    expect(normalizeMintUrl('  Spaces ')).toBe('spaces');
  });

  it('preserves non-standard ports', () => {
    expect(normalizeMintUrl('https://mint.com:8443/')).toBe(
      'https://mint.com:8443',
    );
  });
});
