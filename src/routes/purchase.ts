import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getEncodedToken } from '@cashu/cashu-ts';
import type { NDKCashuWallet } from '@nostr-dev-kit/wallet';
import type { OperatorConfig } from '../config';
import type { OperatorDb } from '../db';
import type { IpPool } from '../ipPool';
import type { WireGuardController } from '../wireguard';
import type { CashuAdapter } from '../cashu';
import { checkBudAuthHeader } from '../auth';
import {
  computeDataQuota,
  computeExpiresAt,
  generateWireGuardConfig,
} from '../configGen';

export interface PurchaseRouteDeps {
  config: OperatorConfig;
  db: OperatorDb;
  cashu: CashuAdapter | null;
  /**
   * The operator's NIP-60 wallet. Non-null whenever `cashu` is —
   * index.ts refuses to start a Cashu-enabled daemon without it, so
   * received ecash always has somewhere to land.
   */
  operatorWallet: NDKCashuWallet | null;
  ipPool: IpPool;
  wg: WireGuardController;
  operatorPubkey: string;
}

const purchaseBodySchema = z.object({
  protocol: z.enum(['wireguard', 'openvpn']),
  client_pubkey: z.string().optional(),
  client_id: z.string().optional(),
});

export function registerPurchaseRoute(app: FastifyInstance, deps: PurchaseRouteDeps): void {
  app.post('/purchase', async (req: FastifyRequest, reply) => {
    if (!deps.cashu) {
      reply.code(503);
      return { status: 'error', reason: 'cashu-not-configured' };
    }

    const auth = checkBudAuthHeader(
      req.headers['authorization'] as string | undefined,
      deps.operatorPubkey,
      deps.config,
    );
    if (!auth.ok) {
      reply.code(auth.status);
      return { status: 'error', reason: auth.reason };
    }

    const cashuToken = req.headers['x-cashu'] as string | undefined;
    if (!cashuToken) {
      reply.code(400);
      return { status: 'error', reason: 'bad-request', message: 'missing X-Cashu' };
    }

    const body = purchaseBodySchema.safeParse(req.body);
    if (!body.success) {
      reply.code(400);
      return { status: 'error', reason: 'bad-request', message: body.error.message };
    }
    if (body.data.protocol !== 'wireguard') {
      reply.code(400);
      return { status: 'error', reason: 'unsupported-protocol' };
    }
    if (!body.data.client_pubkey) {
      reply.code(400);
      return { status: 'error', reason: 'no-client-pubkey' };
    }

    // The CashuAdapter knows the operator's full accepted-mint set
    // (built at startup from every cashu entry in the listing). It
    // dispatches on the token's own mint and rejects with `wrong-mint`
    // if the buyer paid a mint this operator doesn't take — no need
    // to pin a single expected mint here anymore.
    if (deps.cashu.mints.length === 0) {
      reply.code(503);
      return { status: 'error', reason: 'no-cashu-in-listing' };
    }

    let swap;
    try {
      swap = await deps.cashu.receive(cashuToken);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'invalid-token';
      reply.code(402);
      return { status: 'error', reason };
    }

    if (swap.amountReceived < auth.check.matchedPrice.amount) {
      reply.code(402);
      return { status: 'error', reason: 'amount-mismatch' };
    }

    // Persist the just-received ecash into the operator's NIP-60
    // wallet. CashuAdapter.receive() already swapped + P2PK-unlocked
    // the buyer's token, so `swap.proofs` are plain, operator-owned
    // proofs. receiveToken() re-receives them into the wallet — one
    // extra mint swap, then a kind-7375 token event + kind-7376
    // history event on the operator's relays. Without this the proofs
    // exist only in this request's memory and the sale's revenue is
    // lost when the handler returns.
    //
    // This runs AFTER the amount check but BEFORE peer setup: if the
    // store fails we still want to know (loud log) but we don't fail
    // the buyer's purchase — they paid, they get their tunnel; the
    // money isn't lost, just not yet backed up to relays.
    if (deps.operatorWallet) {
      try {
        const token = getEncodedToken({ mint: swap.mint, proofs: swap.proofs });
        await deps.operatorWallet.receiveToken(
          token,
          `VPN sale · ${deps.config.listing.d_tag}`,
        );
      } catch (err) {
        app.log.error(
          { event: 'operator-wallet-store-failed', amount: swap.amountReceived, mint: swap.mint, err: String(err) },
          'received ecash but failed to persist it to the NIP-60 wallet',
        );
      }
    }

    const ip = deps.ipPool.next(deps.db);
    if (!ip) {
      reply.code(503);
      return { status: 'error', reason: 'no-ip-available' };
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = computeExpiresAt(auth.check.matchedPrice.unit, now);
    const dataQuota = computeDataQuota(
      auth.check.matchedPrice.unit,
      auth.check.matchedPrice.amount,
    );

    try {
      await deps.wg.addPeer({ pubkey: body.data.client_pubkey, assignedIp: ip });
    } catch (err) {
      console.error({ event: 'wg-add-failed', err: String(err) });
      reply.code(500);
      return { status: 'error', reason: 'policy', message: 'wg add failed' };
    }

    const sessionId = deps.db.newSessionId();
    deps.db.insertSession({
      session_id: sessionId,
      protocol: 'wireguard',
      client_identity: body.data.client_pubkey,
      assigned_ip: ip,
      purchased_at: now,
      expires_at: expiresAt,
      data_quota_bytes: dataQuota,
      data_used_bytes: 0,
      price_amount: auth.check.matchedPrice.amount,
      price_currency: auth.check.matchedPrice.currency,
      price_unit: auth.check.matchedPrice.unit,
      payment_method: 'cashu',
      status: 'active',
      last_rx_counter: 0,
      last_tx_counter: 0,
      payment_hash: null,
      listing_d_tag: deps.config.listing.d_tag,
    });

    return {
      status: 'ok',
      config: generateWireGuardConfig({ config: deps.config, assignedIp: ip }),
      expires_at: expiresAt,
    };
  });
}
