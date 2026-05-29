import type { OperatorConfig } from './config';

/**
 * Optional metadata for the comment header at the top of the generated
 * `.conf`. WireGuard's parser ignores any line starting with `#`, so
 * this is purely human-facing — most mobile import previews show it.
 * All fields are optional; missing values are omitted from the header.
 */
export interface TunnelMeta {
  purchasedAt?: number;            // unix seconds
  expiresAt?: number | null;       // unix seconds; null = no time expiry
  priceLabel?: string;              // e.g. "100 sat / hour"
  dataQuotaBytes?: number | null;  // null = no data quota
  paymentMethod?: 'lightning' | 'cashu';
}

function formatUtc(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(1)} TiB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${n} bytes`;
}

function buildHeader(config: OperatorConfig, meta: TunnelMeta): string {
  const lines: string[] = [];
  lines.push('# europa-node tunnel');
  lines.push(`# Operator:  ${config.listing.title} (${config.wireguard.endpoint_host})`);
  lines.push(`# Listing:   ${config.listing.d_tag}`);
  if (meta.purchasedAt) lines.push(`# Purchased: ${formatUtc(meta.purchasedAt)}`);
  if (meta.expiresAt) lines.push(`# Expires:   ${formatUtc(meta.expiresAt)}`);
  if (meta.dataQuotaBytes) lines.push(`# Quota:     ${formatBytes(meta.dataQuotaBytes)}`);
  if (meta.priceLabel) lines.push(`# Tier:      ${meta.priceLabel}`);
  if (meta.paymentMethod) lines.push(`# Payment:   ${meta.paymentMethod}`);
  lines.push('#');
  lines.push('# Replace the placeholder PrivateKey below with the private key');
  lines.push('# matching the public key you sent at purchase, then import into');
  lines.push("# WireGuard. Don't share this file — the Address identifies your");
  lines.push('# session to the operator.');
  lines.push('');
  return lines.join('\n') + '\n';
}

/**
 * Generate a complete WireGuard `.conf` file for the client to import.
 * The PrivateKey line is intentionally blank — the client generated
 * their key locally, the operator only ever sees the public key.
 *
 * Pass `meta` to prepend a `#`-comment header with operator + purchase
 * details (see {@link TunnelMeta}). The header is informational only
 * — WireGuard ignores `#` lines — but mobile import previews and a
 * later glance at the file both surface it.
 */
export function generateWireGuardConfig(opts: {
  config: OperatorConfig;
  assignedIp: string;
  meta?: TunnelMeta;
}): string {
  const { config, assignedIp, meta } = opts;
  const dns = config.wireguard.dns.join(', ');
  const header = meta ? buildHeader(config, meta) : '';
  return `${header}[Interface]
PrivateKey = <PASTE YOUR OWN PRIVATE KEY HERE>
Address = ${assignedIp}/32
DNS = ${dns}

[Peer]
PublicKey = ${config.wireguard.server_pubkey}
Endpoint = ${config.wireguard.endpoint_host}:${config.wireguard.endpoint_port}
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
`;
}

/**
 * Compute when a purchased session expires.
 *
 * Time-bundled units (hour/day/week/month) advance from "now" by the
 * unit's seconds. Data-bundled units (GiB/TiB) don't have a hard time
 * expiry; we still apply a soft 30-day ceiling so abandoned data sessions
 * eventually flush.
 */
export function computeExpiresAt(
  unit: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): number | null {
  switch (unit) {
    case 'hour':
      return nowSeconds + 3_600;
    case 'day':
      return nowSeconds + 86_400;
    case 'week':
      return nowSeconds + 7 * 86_400;
    case 'month':
      return nowSeconds + 30 * 86_400;
    case 'GiB':
    case 'TiB':
      return nowSeconds + 30 * 86_400;
    default:
      return null;
  }
}

export function computeDataQuota(
  unit: string,
  amount: number,
): number | null {
  if (unit === 'GiB') return amount * 1024 * 1024 * 1024;
  if (unit === 'TiB') return amount * 1024 * 1024 * 1024 * 1024;
  return null;
}

const TIME_UNIT_SECONDS: Record<string, number> = {
  hour: 3_600,
  day: 86_400,
  week: 7 * 86_400,
  month: 30 * 86_400,
};

const DATA_UNIT_BYTES: Record<string, number> = {
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
};

function unitClass(unit: string): 'time' | 'data' | null {
  if (unit in TIME_UNIT_SECONDS) return 'time';
  if (unit in DATA_UNIT_BYTES) return 'data';
  return null;
}

function unitQuantity(amount: number, unit: string): number | null {
  const t = TIME_UNIT_SECONDS[unit];
  if (t !== undefined) return amount * t;
  const d = DATA_UNIT_BYTES[unit];
  if (d !== undefined) return amount * d;
  return null;
}

/**
 * Enforce the listing's optional `min_purchase` / `max_purchase`
 * bounds against the matched price tier. Returns the spec's reason
 * string when violated, or `null` when the buy is in range.
 *
 * Convention matches the rest of the daemon's per-unit handling:
 *
 *   - **Time tiers** (`hour`/`day`/`week`/`month`) advertise the price
 *     per ONE unit, so one purchase = one unit (1 hour, 1 day, …).
 *     Compare 1 × unit-seconds against the bound's amount × bound-unit-seconds.
 *   - **Data tiers** (`GiB`/`TiB`) advertise an amount that doubles as
 *     the quota (see `computeDataQuota`), so one purchase = amount × unit-bytes.
 *     Compare that against the bound's amount × bound-unit-bytes.
 *   - **Mixed classes** (time tier + data bound, or vice versa) are
 *     orthogonal axes — skip the comparison; the operator advertised
 *     two independent constraints, not a conversion.
 *   - **Unknown units** on either side — skip; we don't invent semantics.
 */
export function checkPurchaseBounds(
  tier: { amount: number; unit: string },
  bounds: {
    min_purchase?: { amount: number; unit: string };
    max_purchase?: { amount: number; unit: string };
  },
): 'below-min-purchase' | 'above-max-purchase' | null {
  const tierKlass = unitClass(tier.unit);
  if (!tierKlass) return null;

  const tierQty =
    tierKlass === 'time'
      ? unitQuantity(1, tier.unit)
      : unitQuantity(tier.amount, tier.unit);
  if (tierQty === null) return null;

  if (bounds.min_purchase && unitClass(bounds.min_purchase.unit) === tierKlass) {
    const minQty = unitQuantity(
      bounds.min_purchase.amount,
      bounds.min_purchase.unit,
    );
    if (minQty !== null && tierQty < minQty) return 'below-min-purchase';
  }
  if (bounds.max_purchase && unitClass(bounds.max_purchase.unit) === tierKlass) {
    const maxQty = unitQuantity(
      bounds.max_purchase.amount,
      bounds.max_purchase.unit,
    );
    if (maxQty !== null && tierQty > maxQty) return 'above-max-purchase';
  }

  return null;
}
