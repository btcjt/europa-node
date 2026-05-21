import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type SessionStatus = 'pending' | 'active' | 'expired' | 'revoked';
export type SessionProtocol = 'wireguard' | 'openvpn';
export type SessionPaymentMethod = 'lightning' | 'cashu';

export interface SessionRow {
  session_id: string;
  protocol: SessionProtocol;
  client_identity: string;
  assigned_ip: string;
  purchased_at: number;
  expires_at: number | null;
  data_quota_bytes: number | null;
  data_used_bytes: number;
  price_amount: number;
  price_currency: string;
  price_unit: string;
  payment_method: SessionPaymentMethod;
  status: SessionStatus;
  /** Per-protocol stats checkpoint: last seen rx/tx counters from `wg show wg0 transfer`. */
  last_rx_counter: number;
  last_tx_counter: number;
  /** Payment hash for Lightning sessions (used to reconcile the LN backend). */
  payment_hash: string | null;
  /** Listing d-tag the purchase referenced. */
  listing_d_tag: string;
}

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    protocol TEXT NOT NULL,
    client_identity TEXT NOT NULL,
    assigned_ip TEXT NOT NULL,
    purchased_at INTEGER NOT NULL,
    expires_at INTEGER,
    data_quota_bytes INTEGER,
    data_used_bytes INTEGER NOT NULL DEFAULT 0,
    price_amount REAL NOT NULL,
    price_currency TEXT NOT NULL,
    price_unit TEXT NOT NULL,
    payment_method TEXT NOT NULL,
    status TEXT NOT NULL,
    last_rx_counter INTEGER NOT NULL DEFAULT 0,
    last_tx_counter INTEGER NOT NULL DEFAULT 0,
    payment_hash TEXT,
    listing_d_tag TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_by_status ON sessions(status)`,
  `CREATE INDEX IF NOT EXISTS sessions_by_expires ON sessions(expires_at)`,
  `CREATE INDEX IF NOT EXISTS sessions_by_client ON sessions(client_identity)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS sessions_by_ip ON sessions(assigned_ip) WHERE status IN ('pending','active')`,
];

export class OperatorDb {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    for (const stmt of MIGRATIONS) this.db.exec(stmt);
  }

  close(): void {
    this.db.close();
  }

  newSessionId(): string {
    return randomUUID();
  }

  insertSession(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (
          session_id, protocol, client_identity, assigned_ip, purchased_at,
          expires_at, data_quota_bytes, data_used_bytes,
          price_amount, price_currency, price_unit,
          payment_method, status,
          last_rx_counter, last_tx_counter,
          payment_hash, listing_d_tag
        ) VALUES (
          @session_id, @protocol, @client_identity, @assigned_ip, @purchased_at,
          @expires_at, @data_quota_bytes, @data_used_bytes,
          @price_amount, @price_currency, @price_unit,
          @payment_method, @status,
          @last_rx_counter, @last_tx_counter,
          @payment_hash, @listing_d_tag
        )`,
      )
      .run(row);
  }

  setStatus(sessionId: string, status: SessionStatus): void {
    this.db
      .prepare(`UPDATE sessions SET status = ? WHERE session_id = ?`)
      .run(status, sessionId);
  }

  setStatusByPaymentHash(paymentHash: string, status: SessionStatus): SessionRow | null {
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare(`SELECT * FROM sessions WHERE payment_hash = ?`)
        .get(paymentHash) as SessionRow | undefined;
      if (!row) return null;
      this.db
        .prepare(`UPDATE sessions SET status = ? WHERE session_id = ?`)
        .run(status, row.session_id);
      return { ...row, status };
    });
    return tx();
  }

  updateTransfer(
    sessionId: string,
    rxCounter: number,
    txCounter: number,
    deltaBytes: number,
  ): void {
    this.db
      .prepare(
        `UPDATE sessions SET
          last_rx_counter = ?,
          last_tx_counter = ?,
          data_used_bytes = data_used_bytes + ?
        WHERE session_id = ?`,
      )
      .run(rxCounter, txCounter, Math.max(0, deltaBytes), sessionId);
  }

  active(): SessionRow[] {
    return this.db
      .prepare(`SELECT * FROM sessions WHERE status IN ('pending','active')`)
      .all() as SessionRow[];
  }

  findById(sessionId: string): SessionRow | undefined {
    return this.db
      .prepare(`SELECT * FROM sessions WHERE session_id = ?`)
      .get(sessionId) as SessionRow | undefined;
  }

  findByClientIdentity(identity: string): SessionRow | undefined {
    return this.db
      .prepare(`SELECT * FROM sessions WHERE client_identity = ? ORDER BY purchased_at DESC LIMIT 1`)
      .get(identity) as SessionRow | undefined;
  }

  usedIps(): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT assigned_ip FROM sessions WHERE status IN ('pending','active')`,
      )
      .all() as { assigned_ip: string }[];
    return new Set(rows.map((r) => r.assigned_ip));
  }
}
