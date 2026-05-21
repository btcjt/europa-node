import type { OperatorConfig } from './config';

/**
 * Generate a complete WireGuard `.conf` file for the client to import.
 * The PrivateKey line is intentionally blank — the client generated
 * their key locally, the operator only ever sees the public key.
 */
export function generateWireGuardConfig(opts: {
  config: OperatorConfig;
  assignedIp: string;
}): string {
  const { config, assignedIp } = opts;
  const dns = config.wireguard.dns.join(', ');
  return `[Interface]
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
