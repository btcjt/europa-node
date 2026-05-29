import type { FastifyInstance } from 'fastify';
import {
  PURCHASE_COMMENT_VERSION,
  parseLnurlPurchaseComment,
  parseListingAddress,
} from '../protocol';
import type { OperatorConfig } from '../config';
import type { OperatorDb } from '../db';
import type { LightningBackend } from '../lightning';
import { newPreimage } from '../lightning';
import { aesEncryptWithPreimage } from '../encrypt';
import {
  checkPurchaseBounds,
  computeDataQuota,
  computeExpiresAt,
  generateWireGuardConfig,
} from '../configGen';
import type { IpPool } from '../ipPool';
import type { WireGuardController } from '../wireguard';

export interface LnurlRouteDeps {
  config: OperatorConfig;
  db: OperatorDb;
  lightning: LightningBackend;
  ipPool: IpPool;
  wg: WireGuardController;
  operatorPubkey: string;
}

interface MetadataQuery {
  /** Index into config.listing.prices selecting the tier. */
  p?: string;
}

interface CallbackQuery {
  amount?: string;
  comment?: string;
}

function metadataFor(priceLabel: string, operatorPubkey: string, dTag: string): string {
  return JSON.stringify([
    ['text/plain', `VPN access: ${priceLabel}`],
    ['text/identifier', `${operatorPubkey}:${dTag}`],
  ]);
}

export function registerLnurlRoutes(app: FastifyInstance, deps: LnurlRouteDeps): void {
  app.get<{ Querystring: MetadataQuery }>('/lnurlp', async (req, reply) => {
    const prices = deps.config.listing.prices;
    const idx = req.query.p ? Math.max(0, Math.min(prices.length - 1, parseInt(req.query.p, 10))) : 0;
    const tier = prices[idx]!;
    const sats = tier.currency === 'sat' ? tier.amount : 0;
    if (sats <= 0) {
      reply.code(400);
      return { status: 'error', reason: 'no-sat-tier' };
    }
    return {
      tag: 'payRequest',
      callback: `https://${deps.config.server.public_host}/lnurlp/callback`,
      minSendable: sats * 1000,
      maxSendable: sats * 1000,
      commentAllowed: 1024,
      metadata: metadataFor(`${tier.amount} sat/${tier.unit}`, deps.operatorPubkey, deps.config.listing.d_tag),
    };
  });

  app.get<{ Querystring: CallbackQuery }>('/lnurlp/callback', async (req, reply) => {
    const amountMsat = req.query.amount ? parseInt(req.query.amount, 10) : 0;
    if (!amountMsat || amountMsat <= 0) {
      reply.code(400);
      return { status: 'error', reason: 'bad-request' };
    }
    const amountSat = Math.floor(amountMsat / 1000);

    if (!req.query.comment) {
      reply.code(400);
      return { status: 'error', reason: 'bad-request' };
    }

    let commentJson: unknown;
    try {
      commentJson = JSON.parse(req.query.comment);
    } catch {
      reply.code(400);
      return { status: 'error', reason: 'bad-request' };
    }

    const parsed = parseLnurlPurchaseComment(commentJson);
    if (!parsed.ok) {
      reply.code(400);
      return { status: 'error', reason: parsed.reason };
    }
    if (parsed.comment.version !== PURCHASE_COMMENT_VERSION) {
      reply.code(400);
      return { status: 'error', reason: 'version-mismatch' };
    }

    const listingAddr = parseListingAddress(parsed.comment.listing);
    if (
      !listingAddr ||
      listingAddr.pubkey !== deps.operatorPubkey ||
      listingAddr.identifier !== deps.config.listing.d_tag
    ) {
      reply.code(400);
      return { status: 'error', reason: 'unknown-listing' };
    }

    const matchedTier = deps.config.listing.prices.find(
      (p) =>
        String(p.amount) === parsed.comment.price[1] &&
        p.currency === parsed.comment.price[2] &&
        p.unit === parsed.comment.price[3],
    );
    if (!matchedTier) {
      reply.code(400);
      return { status: 'error', reason: 'price-mismatch' };
    }
    // Enforce the listing's optional min/max_purchase bounds against
    // the matched tier before issuing the invoice — otherwise the
    // buyer pays and only then learns the tier they picked isn't
    // honored.
    const boundsReason = checkPurchaseBounds(matchedTier, {
      min_purchase: deps.config.listing.min_purchase,
      max_purchase: deps.config.listing.max_purchase,
    });
    if (boundsReason) {
      reply.code(400);
      return { status: 'error', reason: boundsReason };
    }
    if (matchedTier.currency === 'sat' && matchedTier.amount > amountSat) {
      reply.code(402);
      return { status: 'error', reason: 'amount-mismatch' };
    }

    if (parsed.comment.protocol !== 'wireguard') {
      reply.code(400);
      return { status: 'error', reason: 'unsupported-protocol' };
    }
    if (!parsed.comment.client_pubkey) {
      reply.code(400);
      return { status: 'error', reason: 'no-client-pubkey' };
    }

    const ip = deps.ipPool.next(deps.db);
    if (!ip) {
      reply.code(503);
      return { status: 'error', reason: 'no-ip-available' };
    }

    // Compute session timing + quota first so the .conf can carry them
    // in its informational `#`-comment header. Header is purely human-
    // facing; WireGuard ignores `#` lines.
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = computeExpiresAt(matchedTier.unit, now);
    const dataQuota = computeDataQuota(matchedTier.unit, matchedTier.amount);

    const wgConfig = generateWireGuardConfig({
      config: deps.config,
      assignedIp: ip,
      meta: {
        purchasedAt: now,
        expiresAt,
        priceLabel: `${matchedTier.amount} ${matchedTier.currency} / ${matchedTier.unit}`,
        dataQuotaBytes: dataQuota,
        paymentMethod: 'lightning',
      },
    });
    const { preimage, paymentHash } = newPreimage();
    const invoice = await deps.lightning.createInvoice({
      amountSat,
      preimage,
      description: `VPN ${matchedTier.amount} ${matchedTier.currency}/${matchedTier.unit}`,
    });

    const enc = aesEncryptWithPreimage(wgConfig, preimage);

    const sessionId = deps.db.newSessionId();
    deps.db.insertSession({
      session_id: sessionId,
      protocol: 'wireguard',
      client_identity: parsed.comment.client_pubkey,
      assigned_ip: ip,
      purchased_at: now,
      expires_at: expiresAt,
      data_quota_bytes: dataQuota,
      data_used_bytes: 0,
      price_amount: matchedTier.amount,
      price_currency: matchedTier.currency,
      price_unit: matchedTier.unit,
      payment_method: 'lightning',
      status: 'pending',
      last_rx_counter: 0,
      last_tx_counter: 0,
      payment_hash: paymentHash,
      listing_d_tag: deps.config.listing.d_tag,
    });

    // Active activation happens when the LN backend confirms payment;
    // see the polling loop in src/index.ts.

    return {
      pr: invoice.bolt11,
      successAction: {
        tag: 'aes',
        description: 'Your VPN configuration',
        ciphertext: enc.ciphertext,
        iv: enc.iv,
      },
      routes: [],
    };
  });
}
