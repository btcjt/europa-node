// MUST be the first import — installs `global.WebSocket` so NDK and
// nostr-tools work in Node. Without it the relay connect attempts
// fail silently with "Resource temporarily unavailable" (1006) at the
// strfry side and "0 published, 1 required" at NDK's. See
// docs/conventions/ndk.md.
import 'websocket-polyfill';

import { loadConfig, loadNsec } from './config';
import { OperatorDb } from './db';
import { IpPool } from './ipPool';
import { WgController, InMemoryWireGuardController } from './wireguard';
import { ListingPublisher } from './listingPublisher';
import { PhoenixdBackend, StubLightningBackend, type LightningBackend } from './lightning';
import { CashuAdapter } from './cashu';
import { ExpiryWatcher } from './expiry';
import { BandwidthAccountant } from './accounting';
import { LightningSettlementWatcher } from './lightningWatcher';
import { buildServer } from './server';

async function main(): Promise<void> {
  const configPath = process.env.EUROPA_NODE_CONFIG ?? '/etc/europa-node/config.toml';
  const config = loadConfig(configPath);
  const nsec = loadNsec(config);

  const db = new OperatorDb(config.db.path);
  const ipPool = new IpPool(config.wireguard.subnet_cidr);

  const wg =
    process.env.EUROPA_OPERATOR_WIREGUARD_MODE === 'in-memory'
      ? new InMemoryWireGuardController()
      : new WgController(config.wireguard.interface);

  let lightning: LightningBackend = new StubLightningBackend();
  if (config.lightning.enabled && config.lightning.backend === 'phoenixd') {
    if (!config.lightning.base_url || !config.lightning.api_token) {
      throw new Error('lightning.base_url and lightning.api_token required for phoenixd');
    }
    lightning = new PhoenixdBackend(config.lightning.base_url, config.lightning.api_token);
  }

  let cashu: CashuAdapter | null = null;
  if (config.cashu.enabled && config.cashu.mint_url) {
    cashu = new CashuAdapter(config.cashu.mint_url, config.cashu.p2pk_privkey_hex);
  }

  const publisher = new ListingPublisher(config, nsec);
  await publisher.start();
  const operatorPubkey = publisher.pubkey();

  const expiry = new ExpiryWatcher(db, wg);
  expiry.start();

  const accounting = new BandwidthAccountant(db, wg);
  accounting.start();

  const lnWatcher = new LightningSettlementWatcher(db, lightning, wg);
  if (config.lightning.enabled) lnWatcher.start();

  const app = buildServer({
    config,
    db,
    ipPool,
    wg,
    lightning,
    cashu,
    operatorPubkey,
  });

  await app.listen({ host: config.server.host, port: config.server.port });
  console.log({
    event: 'europa-node-up',
    pubkey: operatorPubkey.slice(0, 12),
    port: config.server.port,
    public_host: config.server.public_host,
    listing: config.listing.d_tag,
  });

  const shutdown = async (signal: string) => {
    console.log({ event: 'shutdown', signal });
    expiry.stop();
    accounting.stop();
    lnWatcher.stop();
    publisher.stop();
    await app.close().catch(() => {});
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error({ event: 'fatal', err: String(err) });
  process.exit(1);
});
