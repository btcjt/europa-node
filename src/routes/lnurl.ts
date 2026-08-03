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

  app.get('/config-viewer', async (_req, reply) => {
    reply
      .header('Cache-Control', 'no-store, max-age=0')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff')
      .header(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      )
      .type('text/html; charset=utf-8');

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Europa WireGuard Config</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #080b12;
      color: #eef2ff;
    }
    body {
      margin: 0;
      padding: 24px;
      background: #080b12;
    }
    main {
      max-width: 920px;
      margin: 0 auto;
    }
    h1 {
      font-size: 1.35rem;
      margin: 0 0 12px;
    }
    p {
      color: #aab3c5;
      line-height: 1.45;
    }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      background: #111827;
      border: 1px solid #2b3446;
      border-radius: 12px;
      padding: 16px;
      overflow: auto;
      font-size: 0.9rem;
      line-height: 1.45;
    }
    button {
      border: 0;
      border-radius: 10px;
      padding: 12px 16px;
      font-weight: 700;
      background: #38bdf8;
      color: #03111c;
    }
    .error {
      color: #fca5a5;
    }
  </style>
</head>
<body>
  <main>
    <h1>Europa WireGuard Config</h1>
    <p>Copy this config into WireGuard. Your private key remains on your device.</p>
    <button id="copy" type="button">Copy config</button>
    <pre id="config">Loading…</pre>
  </main>

  <script>
    function decodeBase64Url(value) {
      const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
      const binary = atob(padded);
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }

    const pre = document.getElementById('config');
    const button = document.getElementById('copy');

    try {
      const fragment = window.location.hash.slice(1);
      if (!fragment) {
        throw new Error('No config fragment was provided.');
      }

      const config = decodeBase64Url(fragment);
      pre.textContent = config;

      button.addEventListener('click', async () => {
        await navigator.clipboard.writeText(config);
        button.textContent = 'Copied';
      });
    } catch (err) {
      pre.className = 'error';
      pre.textContent = err instanceof Error ? err.message : String(err);
      button.disabled = true;
    }
  </script>
</body>
</html>`;
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

    const invoicePreimage = Buffer.from(invoice.preimage, 'hex');
    if (invoicePreimage.length !== 32) {
      throw new Error(`lightning backend returned invalid preimage length: ${invoicePreimage.length}`);
    }

    // Phoenix Wallet exposes AES successAction payloads as an "Open link"
    // action. Use a normal HTTPS URL for wallet/browser compatibility, but
    // place the WireGuard config in the URL fragment so it is decoded locally
    // by /config-viewer and is not sent to the server in the HTTP request.
    const wgConfigFragment = Buffer.from(wgConfig, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');

    const wgConfigUrl =
      `https://${deps.config.server.public_host}/config-viewer#${wgConfigFragment}`;

    const enc = aesEncryptWithPreimage(wgConfigUrl, invoicePreimage);

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
      payment_hash: invoice.paymentHash || paymentHash,
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
