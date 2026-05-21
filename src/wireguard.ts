import { execa } from 'execa';

export interface PeerTransfer {
  pubkey: string;
  rx: number;
  tx: number;
}

export interface WireGuardController {
  addPeer(opts: { pubkey: string; assignedIp: string }): Promise<void>;
  removePeer(pubkey: string): Promise<void>;
  showTransfer(): Promise<PeerTransfer[]>;
}

/**
 * Production controller: shells out to `wg`. Requires NET_ADMIN
 * capability on the running container and the wg interface (default `wg0`)
 * to be up.
 */
export class WgController implements WireGuardController {
  constructor(private readonly iface: string) {}

  async addPeer({ pubkey, assignedIp }: { pubkey: string; assignedIp: string }): Promise<void> {
    await execa('wg', [
      'set',
      this.iface,
      'peer',
      pubkey,
      'allowed-ips',
      `${assignedIp}/32`,
    ]);
  }

  async removePeer(pubkey: string): Promise<void> {
    await execa('wg', ['set', this.iface, 'peer', pubkey, 'remove']);
  }

  async showTransfer(): Promise<PeerTransfer[]> {
    const { stdout } = await execa('wg', ['show', this.iface, 'transfer']);
    return parseTransferOutput(stdout);
  }
}

/** Test/dev double: keeps state in-memory, runs no shell commands. */
export class InMemoryWireGuardController implements WireGuardController {
  private readonly peers = new Map<string, { ip: string; rx: number; tx: number }>();

  async addPeer({ pubkey, assignedIp }: { pubkey: string; assignedIp: string }): Promise<void> {
    this.peers.set(pubkey, { ip: assignedIp, rx: 0, tx: 0 });
  }

  async removePeer(pubkey: string): Promise<void> {
    this.peers.delete(pubkey);
  }

  async showTransfer(): Promise<PeerTransfer[]> {
    return Array.from(this.peers.entries()).map(([pubkey, t]) => ({
      pubkey,
      rx: t.rx,
      tx: t.tx,
    }));
  }

  /** Test-only: simulate traffic for accounting tests. */
  bumpTransfer(pubkey: string, rx: number, tx: number): void {
    const existing = this.peers.get(pubkey);
    if (!existing) return;
    existing.rx += rx;
    existing.tx += tx;
  }

  list(): { pubkey: string; ip: string }[] {
    return Array.from(this.peers.entries()).map(([pubkey, t]) => ({
      pubkey,
      ip: t.ip,
    }));
  }
}

export function parseTransferOutput(output: string): PeerTransfer[] {
  const out: PeerTransfer[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    const [pubkey, rxRaw, txRaw] = parts;
    const rx = Number(rxRaw);
    const tx = Number(txRaw);
    if (!pubkey || !Number.isFinite(rx) || !Number.isFinite(tx)) continue;
    out.push({ pubkey, rx, tx });
  }
  return out;
}
