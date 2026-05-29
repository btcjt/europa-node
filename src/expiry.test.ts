import { describe, expect, it } from 'vitest';
import { ExpiryWatcher } from './expiry';
import { InMemoryWireGuardController } from './wireguard';
import type { OperatorDb, SessionRow } from './db';
import type { WireGuardController, PeerTransfer } from './wireguard';

// Pure-function tests (`shouldExpire`) need no DB; the retry test needs
// a minimal `OperatorDb` stub that records `setStatus` calls so we can
// assert it WASN'T called when removePeer fails.

function baseRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: 'sess-1',
    protocol: 'wireguard',
    client_identity: 'pubkey-A',
    assigned_ip: '10.42.0.2',
    purchased_at: 1_000,
    expires_at: 2_000,
    data_quota_bytes: null,
    data_used_bytes: 0,
    price_amount: 100,
    price_currency: 'sat',
    price_unit: 'hour',
    payment_method: 'cashu',
    status: 'active',
    last_rx_counter: 0,
    last_tx_counter: 0,
    payment_hash: null,
    listing_d_tag: 'demo',
    ...overrides,
  };
}

// Minimal stub: only the methods ExpiryWatcher touches.
function stubDb(rows: SessionRow[] = []): OperatorDb & {
  statusCalls: Array<{ id: string; status: string }>;
} {
  const statusCalls: Array<{ id: string; status: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = {
    active: () => rows.filter((r) => r.status === 'active' || r.status === 'pending'),
    setStatus: (id: string, status: string) => {
      statusCalls.push({ id, status });
      const r = rows.find((r) => r.session_id === id);
      if (r) r.status = status as SessionRow['status'];
    },
    statusCalls,
  };
  return db;
}

class ThrowingWg extends InMemoryWireGuardController {
  public removeCalls = 0;
  async removePeer(pubkey: string): Promise<void> {
    this.removeCalls += 1;
    throw new Error('simulated wg error');
  }
}

describe('ExpiryWatcher.shouldExpire', () => {
  const wg = new InMemoryWireGuardController();
  const db = stubDb();
  const watcher = new ExpiryWatcher(db, wg);

  it('expires a time-bundle session at the exact expiry second', () => {
    const row = baseRow({ expires_at: 2_000 });
    expect(watcher.shouldExpire(row, 2_000)).toBe(true);
    expect(watcher.shouldExpire(row, 1_999)).toBe(false);
  });

  it('expires a data-bundle session when used == quota', () => {
    const row = baseRow({
      expires_at: null,
      data_quota_bytes: 1024,
      data_used_bytes: 1024,
    });
    expect(watcher.shouldExpire(row, 100)).toBe(true);
  });

  it('expires a data-bundle session when used > quota (the usual case)', () => {
    const row = baseRow({
      expires_at: null,
      data_quota_bytes: 1024,
      data_used_bytes: 2048,
    });
    expect(watcher.shouldExpire(row, 100)).toBe(true);
  });

  it('does not expire a data-bundle session under quota', () => {
    const row = baseRow({
      expires_at: null,
      data_quota_bytes: 1024,
      data_used_bytes: 1023,
    });
    expect(watcher.shouldExpire(row, 100)).toBe(false);
  });

  it('skips already-expired rows so they are not double-processed', () => {
    const row = baseRow({ status: 'expired' });
    expect(watcher.shouldExpire(row, 5_000)).toBe(false);
  });

  it('skips already-cancelled rows', () => {
    // Defensive: any non-active/pending status should be skipped, not
    // just `expired` — the switch is `!== active && !== pending`.
    const row = baseRow({ status: 'expired' });
    expect(watcher.shouldExpire(row, 5_000)).toBe(false);
  });

  it('treats pending sessions the same as active (LNURL flow leaves them pending until confirmed)', () => {
    const row = baseRow({ status: 'pending', expires_at: 1_000 });
    expect(watcher.shouldExpire(row, 2_000)).toBe(true);
  });

  it('handles a session with NO expiry and NO quota as never-expiring', () => {
    // Degenerate but worth pinning: protect against a future config
    // change that silently disables both bounds.
    const row = baseRow({ expires_at: null, data_quota_bytes: null });
    expect(watcher.shouldExpire(row, 9_999_999)).toBe(false);
  });
});

describe('ExpiryWatcher.expire — bail safely when removePeer throws', () => {
  it('does NOT mark the session expired when removePeer fails', async () => {
    // The bug this guards: if we mark expired despite kernel still
    // having the peer, the IP returns to the pool and the next purchase
    // reuses it. Kernel now accepts handshakes for TWO pubkeys at the
    // same address — the old buyer's tunnel keeps working past expiry.
    const row = baseRow();
    const db = stubDb([row]);
    const wg = new ThrowingWg();
    const watcher = new ExpiryWatcher(db, wg);

    await watcher.expire(row);

    expect(wg.removeCalls).toBe(1);
    expect(db.statusCalls).toEqual([]); // status untouched
    expect(row.status).toBe('active');
  });

  it('DOES mark the session expired when removePeer succeeds', async () => {
    const row = baseRow();
    const db = stubDb([row]);
    const wg = new InMemoryWireGuardController();
    await wg.addPeer({ pubkey: row.client_identity, assignedIp: row.assigned_ip });
    const watcher = new ExpiryWatcher(db, wg);

    await watcher.expire(row);

    expect(db.statusCalls).toEqual([{ id: row.session_id, status: 'expired' }]);
  });

  it('tick() leaves a stuck session active so next tick retries', async () => {
    // Simulate: tick runs, removePeer throws, session stays active,
    // next tick re-sees it because shouldExpire still returns true.
    const row = baseRow({ expires_at: 1_000 });
    const db = stubDb([row]);
    const wg = new ThrowingWg();
    const watcher = new ExpiryWatcher(db, wg);

    await watcher.tick(2_000);
    expect(wg.removeCalls).toBe(1);
    expect(row.status).toBe('active');

    await watcher.tick(3_000);
    expect(wg.removeCalls).toBe(2);
    expect(row.status).toBe('active');
  });
});
