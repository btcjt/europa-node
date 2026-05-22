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
import { loadOrCreateOperatorWallet } from './operatorWallet';
import { Notifier } from './notifier';
import type { NDKCashuWallet } from '@nostr-dev-kit/wallet';
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

  // Accepted-mint set = every mint in the listing's cashu payment
  // methods, plus the legacy `[cashu].mint_url` if an older config
  // still sets it. The listing is the source of truth — buyers pay
  // the mints the listing advertises, so the daemon accepts exactly
  // those. `[cashu].mint_url` is kept only so pre-multi-mint configs
  // don't silently stop accepting payments after an upgrade.
  let cashu: CashuAdapter | null = null;
  if (config.cashu.enabled) {
    const mintSet = new Set<string>();
    for (const pm of config.listing.payment_methods) {
      if (pm.type === 'cashu') mintSet.add(pm.mint);
    }
    if (config.cashu.mint_url) mintSet.add(config.cashu.mint_url);
    if (mintSet.size > 0) {
      cashu = new CashuAdapter([...mintSet], config.cashu.p2pk_privkey_hex);
    }
  }

  const publisher = new ListingPublisher(config, nsec);
  await publisher.start();
  const operatorPubkey = publisher.pubkey();

  // Operator's NIP-60 wallet — where received Cashu ecash is kept.
  // If Cashu is enabled the wallet is mandatory: a daemon that takes
  // Cashu payments with nowhere to store the proceeds silently burns
  // money. Fail startup loudly rather than run in that state. The
  // wallet shares the publisher's NDK (same signer, same relay pool).
  let operatorWallet: NDKCashuWallet | null = null;
  if (cashu) {
    try {
      operatorWallet = await loadOrCreateOperatorWallet(
        publisher.getNdk(),
        operatorPubkey,
        cashu.mints,
        config.nostr.relays,
      );
    } catch (err) {
      throw new Error(
        `Cashu is enabled but the operator NIP-60 wallet could not be ` +
          `established — refusing to start (received ecash would be lost). ` +
          `Cause: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Optional NIP-17 sale notifications. Best-effort throughout — a
  // notification failure never affects a purchase. Built after the
  // wallet so the per-sale DMs can include the live balance.
  let notifier: Notifier | null = null;
  if (config.notifications.enabled) {
    try {
      notifier = Notifier.fromConfig(config, nsec, publisher.getNdk(), operatorWallet);
      if (notifier) {
        await notifier.init();
        void notifier.notifyStartup(config.listing.title);
        notifier.startHeartbeat(config.notifications.heartbeat_hours);
      }
    } catch (err) {
      // A bad recipient pubkey is the only throw here. Don't take the
      // whole daemon down over a notifications misconfig — log loudly
      // and run without them.
      console.error({ event: 'notifications-disabled', err: String(err) });
      notifier = null;
    }
  }

  const expiry = new ExpiryWatcher(db, wg);
  expiry.start();

  const accounting = new BandwidthAccountant(db, wg);
  accounting.start();

  const lnWatcher = new LightningSettlementWatcher(db, lightning, wg, notifier);
  if (config.lightning.enabled) lnWatcher.start();

  const app = buildServer({
    config,
    db,
    ipPool,
    wg,
    lightning,
    cashu,
    operatorWallet,
    operatorPubkey,
    notifier,
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
    notifier?.stop();
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
