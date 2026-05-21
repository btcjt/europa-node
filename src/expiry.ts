import type { OperatorDb, SessionRow } from './db';
import type { WireGuardController } from './wireguard';

export class ExpiryWatcher {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: OperatorDb,
    private readonly wg: WireGuardController,
    private readonly intervalMs = 60_000,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error({ event: 'expiry-tick-failed', err: String(err) });
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(nowSeconds: number = Math.floor(Date.now() / 1000)): Promise<void> {
    const sessions = this.db.active();
    for (const row of sessions) {
      if (this.shouldExpire(row, nowSeconds)) {
        await this.expire(row);
      }
    }
  }

  shouldExpire(row: SessionRow, nowSeconds: number): boolean {
    if (row.status !== 'active' && row.status !== 'pending') return false;
    if (row.expires_at !== null && nowSeconds >= row.expires_at) return true;
    if (
      row.data_quota_bytes !== null &&
      row.data_used_bytes >= row.data_quota_bytes
    ) {
      return true;
    }
    return false;
  }

  async expire(row: SessionRow): Promise<void> {
    try {
      if (row.protocol === 'wireguard') {
        await this.wg.removePeer(row.client_identity);
      }
      // OpenVPN revoke: out of scope for first iteration; the operator-spec
      // walks through easyrsa revoke + CRL regen if that ships later.
    } catch (err) {
      console.warn({ event: 'expire-peer-failed', session: row.session_id, err: String(err) });
    }
    this.db.setStatus(row.session_id, 'expired');
    console.log({ event: 'session-expired', session: row.session_id, ip: row.assigned_ip });
  }
}
