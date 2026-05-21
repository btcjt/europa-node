import Fastify, { type FastifyInstance } from 'fastify';
import type { OperatorConfig } from './config';
import type { OperatorDb } from './db';
import type { IpPool } from './ipPool';
import type { LightningBackend } from './lightning';
import type { CashuAdapter } from './cashu';
import type { WireGuardController } from './wireguard';
import { registerLnurlRoutes } from './routes/lnurl';
import { registerPurchaseRoute } from './routes/purchase';

export interface ServerDeps {
  config: OperatorConfig;
  db: OperatorDb;
  ipPool: IpPool;
  wg: WireGuardController;
  lightning: LightningBackend;
  cashu: CashuAdapter | null;
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

  app.get('/health', async () => ({
    ok: true,
    service: 'europa-node',
    pubkey: deps.operatorPubkey.slice(0, 12),
    listing: deps.config.listing.d_tag,
  }));

  app.get('/info', async () => ({
    title: deps.config.listing.title,
    summary: deps.config.listing.summary,
    protocols: deps.config.listing.protocols,
    region: deps.config.listing.region,
    prices: deps.config.listing.prices,
    payment_methods: deps.config.listing.payment_methods.map((p) => p.type),
    policies: deps.config.listing.policies ?? [],
    policy_url: deps.config.listing.policy_url,
  }));

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
    ipPool: deps.ipPool,
    wg: deps.wg,
    operatorPubkey: deps.operatorPubkey,
  });

  return app;
}
