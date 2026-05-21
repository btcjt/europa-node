import type { OperatorDb, SessionRow } from './db';
import type { WireGuardController } from './wireguard';

/**
 * Bandwidth accountant: every `intervalMs`, reads `wg show wg0 transfer`
 * and credits each active session's `data_used_bytes` by the delta since
 * last check. WireGuard's per-peer counters are monotonic until a peer
 * is removed; we always trust the kernel and just track our previous
 * snapshot.
 */
export class BandwidthAccountant {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: OperatorDb,
    private readonly wg: WireGuardController,
    private readonly intervalMs = 30_000,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error({ event: 'accounting-tick-failed', err: String(err) });
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const transfers = await this.wg.showTransfer();
    if (transfers.length === 0) return;

    const active = new Map<string, SessionRow>();
    for (const row of this.db.active()) {
      if (row.protocol === 'wireguard') active.set(row.client_identity, row);
    }

    for (const t of transfers) {
      const row = active.get(t.pubkey);
      if (!row) continue;
      const prevTotal = row.last_rx_counter + row.last_tx_counter;
      const newTotal = t.rx + t.tx;
      if (newTotal < prevTotal) {
        // Counter reset (peer was removed and re-added) — restart from zero.
        this.db.updateTransfer(row.session_id, t.rx, t.tx, newTotal);
        continue;
      }
      const delta = newTotal - prevTotal;
      this.db.updateTransfer(row.session_id, t.rx, t.tx, delta);
    }
  }
}
