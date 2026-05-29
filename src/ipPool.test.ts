import { describe, expect, it } from 'vitest';
import { expandIpv4Cidr, IpPool } from './ipPool';
import type { OperatorDb } from './db';

describe('expandIpv4Cidr', () => {
  it('expands /24 minus network, broadcast, and .1 gateway', () => {
    const ips = expandIpv4Cidr('10.42.0.0/24');
    expect(ips[0]).toBe('10.42.0.2');
    expect(ips.at(-1)).toBe('10.42.0.254');
    expect(ips).not.toContain('10.42.0.0');
    expect(ips).not.toContain('10.42.0.1');
    expect(ips).not.toContain('10.42.0.255');
    expect(ips).toHaveLength(253);
  });

  it('expands /30 to two usable hosts (minus gateway)', () => {
    const ips = expandIpv4Cidr('10.0.0.0/30');
    // network 10.0.0.0, gateway 10.0.0.1, hosts 10.0.0.2, broadcast 10.0.0.3
    expect(ips).toEqual(['10.0.0.2']);
  });

  it('rejects bogus CIDR strings', () => {
    expect(() => expandIpv4Cidr('not-a-cidr')).toThrow();
    expect(() => expandIpv4Cidr('10.0.0.0/8')).toThrow();
  });
});

describe('IpPool', () => {
  function fakeDb(used: string[]): OperatorDb {
    return { usedIps: () => new Set(used) } as unknown as OperatorDb;
  }

  it('returns the first IP not currently used', () => {
    const pool = new IpPool('10.42.0.0/24');
    expect(pool.next(fakeDb([]))).toBe('10.42.0.2');
    expect(pool.next(fakeDb(['10.42.0.2', '10.42.0.3']))).toBe('10.42.0.4');
  });

  it('returns null when the pool is exhausted', () => {
    const pool = new IpPool('10.0.0.0/30');
    expect(pool.next(fakeDb(['10.0.0.2']))).toBeNull();
  });

  it('hasAvailable agrees with next() for the empty case', () => {
    const pool = new IpPool('10.0.0.0/30');
    expect(pool.hasAvailable(fakeDb([]))).toBe(true);
    expect(pool.hasAvailable(fakeDb(['10.0.0.2']))).toBe(false);
  });

  it('hasAvailable is the cheap pre-check that prevents money-loss', () => {
    // Used in routes/purchase.ts to fail-fast BEFORE swapping the
    // buyer's cashu token — a `no-ip-available` after the swap would
    // burn ecash with no refund path.
    const pool = new IpPool('10.42.0.0/24');
    // 252 of 253 used → still available
    const usedAll = Array.from({ length: 252 }, (_, i) => `10.42.0.${i + 2}`);
    expect(pool.hasAvailable(fakeDb(usedAll))).toBe(true);
    // All 253 used → exhausted
    const usedReally = Array.from({ length: 253 }, (_, i) => `10.42.0.${i + 2}`);
    expect(pool.hasAvailable(fakeDb(usedReally))).toBe(false);
  });
});
