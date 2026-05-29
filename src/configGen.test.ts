import { describe, expect, it } from 'vitest';
import {
  checkPurchaseBounds,
  computeDataQuota,
  computeExpiresAt,
  generateWireGuardConfig,
} from './configGen';
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
  notifications: { enabled: false, heartbeat_hours: 24 },
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

  it('omits the header when no `meta` is passed', () => {
    const out = generateWireGuardConfig({ config, assignedIp: '10.42.0.42' });
    expect(out.startsWith('[Interface]')).toBe(true);
    expect(out).not.toContain('# europa-node tunnel');
  });

  it('prepends a #-comment header with operator + purchase details when `meta` is passed', () => {
    const out = generateWireGuardConfig({
      config,
      assignedIp: '10.42.0.42',
      meta: {
        purchasedAt: 1_700_000_000,
        expiresAt: 1_700_003_600, // +1h
        priceLabel: '100 sat / hour',
        paymentMethod: 'cashu',
      },
    });
    // Header lines appear before [Interface] and are all comments.
    const headerLines = out.split('\n').slice(0, 12);
    for (const line of headerLines) {
      if (line.length > 0) expect(line.startsWith('#')).toBe(true);
    }
    expect(out).toMatch(/# europa-node tunnel/);
    expect(out).toMatch(/# Operator:.*op\.example/);
    expect(out).toMatch(/# Purchased: 2023-11-14 \d{2}:\d{2} UTC/);
    expect(out).toMatch(/# Expires:   2023-11-14 \d{2}:\d{2} UTC/);
    expect(out).toMatch(/# Tier:      100 sat \/ hour/);
    expect(out).toMatch(/# Payment:   cashu/);
    expect(out).toMatch(/\[Interface\]/);
  });

  it('omits header fields whose meta value is missing/null', () => {
    const out = generateWireGuardConfig({
      config,
      assignedIp: '10.42.0.42',
      meta: { paymentMethod: 'lightning' }, // only paymentMethod set
    });
    expect(out).toMatch(/# europa-node tunnel/);
    expect(out).toMatch(/# Payment:   lightning/);
    expect(out).not.toMatch(/# Purchased:/);
    expect(out).not.toMatch(/# Expires:/);
    expect(out).not.toMatch(/# Quota:/);
    expect(out).not.toMatch(/# Tier:/);
  });

  it('renders data quota in GiB for typical sizes', () => {
    const out = generateWireGuardConfig({
      config,
      assignedIp: '10.42.0.42',
      meta: { dataQuotaBytes: 100 * 1024 ** 3 },
    });
    expect(out).toMatch(/# Quota:     100\.0 GiB/);
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

describe('checkPurchaseBounds', () => {
  it('passes when no bounds are set', () => {
    expect(checkPurchaseBounds({ amount: 100, unit: 'hour' }, {})).toBeNull();
  });

  it('time tier inside min/max passes', () => {
    expect(
      checkPurchaseBounds(
        { amount: 1000, unit: 'day' },
        {
          min_purchase: { amount: 1, unit: 'hour' },
          max_purchase: { amount: 30, unit: 'day' },
        },
      ),
    ).toBeNull();
  });

  it('time tier below min is rejected', () => {
    // 1-hour tier vs 8-hour minimum.
    expect(
      checkPurchaseBounds(
        { amount: 100, unit: 'hour' },
        { min_purchase: { amount: 8, unit: 'hour' } },
      ),
    ).toBe('below-min-purchase');
  });

  it('time tier above max is rejected', () => {
    // 1-month tier vs 30-day maximum — month is 30 days so it equals;
    // a slightly bigger max ceiling forces failure.
    expect(
      checkPurchaseBounds(
        { amount: 8000, unit: 'month' },
        { max_purchase: { amount: 1, unit: 'week' } },
      ),
    ).toBe('above-max-purchase');
  });

  it('data tier uses tier.amount × unit-bytes', () => {
    // 10 GiB tier vs 5 GiB minimum passes; vs 50 GiB minimum fails.
    expect(
      checkPurchaseBounds(
        { amount: 10, unit: 'GiB' },
        { min_purchase: { amount: 5, unit: 'GiB' } },
      ),
    ).toBeNull();
    expect(
      checkPurchaseBounds(
        { amount: 10, unit: 'GiB' },
        { min_purchase: { amount: 50, unit: 'GiB' } },
      ),
    ).toBe('below-min-purchase');
  });

  it('mixed time/data bound is skipped (orthogonal axes)', () => {
    // hour tier with a GiB bound — no comparison.
    expect(
      checkPurchaseBounds(
        { amount: 100, unit: 'hour' },
        { min_purchase: { amount: 5, unit: 'GiB' } },
      ),
    ).toBeNull();
  });

  it('unknown units are skipped', () => {
    expect(
      checkPurchaseBounds(
        { amount: 100, unit: 'zorp' },
        { min_purchase: { amount: 1, unit: 'hour' } },
      ),
    ).toBeNull();
  });
});
