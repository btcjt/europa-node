import { describe, expect, it } from 'vitest';
import { computeDataQuota, computeExpiresAt, generateWireGuardConfig } from './configGen';
import type { OperatorConfig } from './config';

const config = {
  server: { host: '0.0.0.0', port: 8080, public_host: 'op.example' },
  db: { path: ':memory:' },
  wireguard: {
    interface: 'wg0',
    endpoint_host: 'op.example',
    endpoint_port: 51820,
    server_pubkey: 'SERVER_PUBKEY_B64',
    subnet_cidr: '10.42.0.0/24',
    dns: ['1.1.1.1', '9.9.9.9'],
  },
  lightning: { enabled: false, backend: 'stub' as const },
  cashu: { enabled: false },
  nostr: { relays: ['wss://x'], nsec: 'nsec' },
  listing: {
    d_tag: 'd',
    title: 't',
    protocols: ['wireguard' as const],
    prices: [{ amount: 1000, currency: 'sat', unit: 'day' }],
    payment_methods: [
      { type: 'lightning' as const, endpoint: 'https://x', mechanism: 'lnurl-pay' as const },
    ],
  },
} satisfies OperatorConfig;

describe('generateWireGuardConfig', () => {
  it('produces a wg-quick-compatible config with PrivateKey left blank', () => {
    const out = generateWireGuardConfig({ config, assignedIp: '10.42.0.42' });
    expect(out).toMatch(/\[Interface\]/);
    expect(out).toMatch(/PrivateKey = <PASTE/);
    expect(out).toMatch(/Address = 10\.42\.0\.42\/32/);
    expect(out).toMatch(/DNS = 1\.1\.1\.1, 9\.9\.9\.9/);
    expect(out).toMatch(/PublicKey = SERVER_PUBKEY_B64/);
    expect(out).toMatch(/Endpoint = op\.example:51820/);
    expect(out).toMatch(/AllowedIPs = 0\.0\.0\.0\/0, ::\/0/);
  });
});

describe('computeExpiresAt / computeDataQuota', () => {
  it('time units advance from `now`', () => {
    expect(computeExpiresAt('hour', 1_000)).toBe(1_000 + 3_600);
    expect(computeExpiresAt('day', 1_000)).toBe(1_000 + 86_400);
    expect(computeExpiresAt('week', 1_000)).toBe(1_000 + 7 * 86_400);
    expect(computeExpiresAt('month', 1_000)).toBe(1_000 + 30 * 86_400);
  });

  it('data units default to a 30-day soft ceiling', () => {
    expect(computeExpiresAt('GiB', 1_000)).toBe(1_000 + 30 * 86_400);
    expect(computeExpiresAt('TiB', 1_000)).toBe(1_000 + 30 * 86_400);
  });

  it('returns null for unknown units', () => {
    expect(computeExpiresAt('zorp', 0)).toBeNull();
  });

  it('computes data quotas in bytes', () => {
    expect(computeDataQuota('GiB', 1)).toBe(1024 ** 3);
    expect(computeDataQuota('TiB', 1)).toBe(1024 ** 4);
    expect(computeDataQuota('day', 1)).toBeNull();
  });
});
