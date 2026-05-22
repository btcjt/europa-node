import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import type { NDKCashuWallet } from '@nostr-dev-kit/wallet';
import pkg from '../package.json';
import type { OperatorConfig } from './config';
import type { OperatorDb } from './db';
import type { IpPool } from './ipPool';
import type { LightningBackend } from './lightning';
import type { CashuAdapter } from './cashu';
import type { WireGuardController } from './wireguard';
import { registerLnurlRoutes } from './routes/lnurl';
import { registerPurchaseRoute } from './routes/purchase';

/** Marketplace spec revision this daemon implements. Bump on protocol breaks. */
const SPEC_VERSION = 'vpn-marketplace/1';

export interface ServerDeps {
  config: OperatorConfig;
  db: OperatorDb;
  ipPool: IpPool;
  wg: WireGuardController;
  lightning: LightningBackend;
  cashu: CashuAdapter | null;
  /** Operator's NIP-60 wallet — non-null whenever `cashu` is. */
  operatorWallet: NDKCashuWallet | null;
  operatorPubkey: string;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // Don't log auth headers or request bodies — those carry payment data.
      redact: ['req.headers.authorization', 'req.headers["x-cashu"]'],
    },
  });

  // Permissive CORS — the marketplace is intentionally cross-origin.
  // Any directory site, CLI tool, or third-party Nostr client may need
  // to call /info and /purchase from a different origin. The endpoints
  // are payment-and-signature gated, not origin-gated.
  app.register(fastifyCors, {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Cashu'],
    maxAge: 86400,
  });

  app.get('/health', async () => ({
    ok: true,
    service: 'europa-node',
    pubkey: deps.operatorPubkey.slice(0, 12),
    listing: deps.config.listing.d_tag,
  }));

  app.get('/info', async () => {
    // Walk the configured payment methods once, picking out the
    // mint / lnurl endpoints into top-level arrays. Lets buyers
    // and tooling see "where do I send a Cashu token / dial a
    // Lightning invoice" without re-parsing the listing's payment
    // tags. Dedupe with Set in case the operator listed the same
    // mint twice for different tiers.
    const mints = new Set<string>();
    const cashu_endpoints = new Set<string>();
    const lightning_endpoints = new Set<string>();
    for (const p of deps.config.listing.payment_methods) {
      if (p.type === 'cashu') {
        mints.add(p.mint);
        cashu_endpoints.add(p.endpoint);
      } else if (p.type === 'lightning') {
        lightning_endpoints.add(p.endpoint);
      }
    }

    return {
      // Software identification — lets buyers/tooling know what
      // implementation they're talking to. New consumers can branch on
      // `spec_version` if/when the wire surface gets a v2.
      software: 'europa-node',
      version: pkg.version,
      spec_version: SPEC_VERSION,

      // Operator identity — a buyer cross-checks this against the npub
      // from the kind-30402 listing they're viewing. If they don't
      // match, the listing has been impersonated or the operator
      // recently rotated keys without republishing.
      pubkey: deps.operatorPubkey,
      endpoint: deps.config.server.public_host,

      // Listing snapshot — mirrors what the kind-30402 event advertises.
      title: deps.config.listing.title,
      summary: deps.config.listing.summary,
      content: deps.config.listing.content,
      protocols: deps.config.listing.protocols,
      region: deps.config.listing.region,
      prices: deps.config.listing.prices,
      policies: deps.config.listing.policies ?? [],
      policy_url: deps.config.listing.policy_url,

      // Payment surface. `payment_methods` stays a string[] for
      // backwards-compat with existing diagnose/match tooling that
      // expects ['lightning', 'cashu']. The new mints + endpoint
      // arrays expose the concrete URLs operators want to publish.
      payment_methods: deps.config.listing.payment_methods.map((p) => p.type),
      mints: [...mints],
      cashu_purchase_endpoints: [...cashu_endpoints],
      lightning_endpoints: [...lightning_endpoints],
    };
  });

  registerLnurlRoutes(app, {
    config: deps.config,
    db: deps.db,
    lightning: deps.lightning,
    ipPool: deps.ipPool,
    wg: deps.wg,
    operatorPubkey: deps.operatorPubkey,
  });

  registerPurchaseRoute(app, {
    config: deps.config,
    db: deps.db,
    cashu: deps.cashu,
    operatorWallet: deps.operatorWallet,
    ipPool: deps.ipPool,
    wg: deps.wg,
    operatorPubkey: deps.operatorPubkey,
  });

  return app;
}
