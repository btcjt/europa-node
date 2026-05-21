import type { OperatorDb } from './db';

export class IpPool {
  private readonly all: string[];

  constructor(cidr: string) {
    this.all = expandIpv4Cidr(cidr);
  }

  /** Pick the first IP not currently used by an active/pending session. */
  next(db: OperatorDb): string | null {
    const used = db.usedIps();
    for (const ip of this.all) {
      if (!used.has(ip)) return ip;
    }
    return null;
  }

  contains(ip: string): boolean {
    return this.all.includes(ip);
  }
}

/**
 * Expand an IPv4 CIDR into the usable host range, skipping the network
 * and broadcast addresses *and* the conventional `.1` operator gateway.
 * Only /16 through /30 are supported — adequate for any realistic VPN
 * subnet.
 */
export function expandIpv4Cidr(cidr: string): string[] {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr);
  if (!match) throw new Error(`bad CIDR: ${cidr}`);
  const [, a, b, c, d, prefix] = match;
  const base = (parseInt(a!, 10) << 24) | (parseInt(b!, 10) << 16) | (parseInt(c!, 10) << 8) | parseInt(d!, 10);
  const bits = parseInt(prefix!, 10);
  if (bits < 16 || bits > 30) throw new Error(`unsupported prefix /${bits}`);
  const hosts = 1 << (32 - bits);
  const network = base & (~((1 << (32 - bits)) - 1));
  const broadcast = network | ((1 << (32 - bits)) - 1);
  const skipGateway = network + 1;
  const out: string[] = [];
  for (let n = network + 2; n < broadcast; n++) {
    if (n === skipGateway) continue;
    out.push(toDotted(n >>> 0));
  }
  return out;
}

function toDotted(n: number): string {
  return [
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ].join('.');
}
