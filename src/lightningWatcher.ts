import type { OperatorDb, SessionRow } from './db';
import type { LightningBackend } from './lightning';
import type { WireGuardController } from './wireguard';

/**
 * Poll the Lightning backend for pending sessions, flipping each to
 * `active` once the invoice settles. The LNURL callback inserts
 * sessions as `pending`; this watcher is what binds them into the
 * WireGuard interface.
 *
 * Phoenixd doesn't ship a "subscribe-on-invoice" feature in the bare
 * HTTP API, so polling is the simplest path. 3s cadence keeps the
 * pay→connect gap small without hammering.
 */
export class LightningSettlementWatcher {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: OperatorDb,
    private readonly ln: LightningBackend,
    private readonly wg: WireGuardController,
    private readonly intervalMs = 3_000,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error({ event: 'ln-watcher-failed', err: String(err) });
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const pending = this.db
      .active()
      .filter((s) => s.payment_method === 'lightning' && s.status === 'pending');
    for (const row of pending) {
      if (!row.payment_hash) continue;
      try {
        const paid = await this.ln.isPaid(row.payment_hash);
        if (paid) await this.activate(row);
      } catch (err) {
        console.warn({ event: 'ln-isPaid-failed', session: row.session_id, err: String(err) });
      }
    }
  }

  private async activate(row: SessionRow): Promise<void> {
    try {
      if (row.protocol === 'wireguard') {
        await this.wg.addPeer({ pubkey: row.client_identity, assignedIp: row.assigned_ip });
      }
    } catch (err) {
      console.error({ event: 'activate-peer-failed', session: row.session_id, err: String(err) });
      return;
    }
    this.db.setStatus(row.session_id, 'active');
    console.log({
      event: 'session-activated',
      session: row.session_id,
      method: 'lightning',
      ip: row.assigned_ip,
    });
  }
}
