import NDK, { NDKEvent, NDKPrivateKeySigner } from '@nostr-dev-kit/ndk';
import { nip19 } from 'nostr-tools';
import {
  buildListingTags,
  LISTING_REFRESH_INTERVAL_MS,
  type ListingSpec,
  type Payment,
  type Price,
  type VpnProtocol,
} from './protocol';
import type { OperatorConfig } from './config';

function decodeNsec(nsec: string): string {
  const trimmed = nsec.trim();
  if (trimmed.startsWith('nsec1')) {
    const { data } = nip19.decode(trimmed);
    return data as string;
  }
  return trimmed; // assume hex
}

function paymentsFromConfig(config: OperatorConfig): Payment[] {
  const out: Payment[] = [];
  for (const p of config.listing.payment_methods) {
    if (p.type === 'lightning') {
      out.push({ kind: 'lightning', target: p.endpoint, mechanism: p.mechanism });
    } else {
      out.push({ kind: 'cashu', mint: p.mint, p2pk: p.p2pk, endpoint: p.endpoint });
    }
  }
  return out;
}

function pricesFromConfig(config: OperatorConfig): Price[] {
  return config.listing.prices.map((p) => ({
    amount: p.amount,
    currency: p.currency,
    unit: p.unit,
  }));
}

function listingSpec(config: OperatorConfig, pubkey: string, nowSec: number): ListingSpec {
  const location: string[] = [];
  if (config.listing.region?.country) location.push(config.listing.region.country);
  if (config.listing.region?.sub) location.push(config.listing.region.sub);

  return {
    pubkey,
    createdAt: nowSec,
    identifier: config.listing.d_tag,
    title: config.listing.title,
    protocols: config.listing.protocols as VpnProtocol[],
    prices: pricesFromConfig(config),
    payments: paymentsFromConfig(config),
    summary: config.listing.summary,
    location: location.length > 0 ? location : undefined,
    geohashes: config.listing.region?.geohash ? [config.listing.region.geohash] : undefined,
    minPurchase: config.listing.min_purchase,
    maxPurchase: config.listing.max_purchase,
    capacity: config.listing.capacity,
    policies: config.listing.policies,
    policyUrl: config.listing.policy_url,
    protocolConfigUrl: config.listing.protocol_config_url,
    content: config.listing.content ?? '',
    status: 'active',
  };
}

export class ListingPublisher {
  private readonly signer: NDKPrivateKeySigner;
  private readonly ndk: NDK;
  private readonly hexPubkey: string;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(private readonly config: OperatorConfig, nsec: string) {
    const priv = decodeNsec(nsec);
    this.signer = new NDKPrivateKeySigner(priv);
    this.ndk = new NDK({
      explicitRelayUrls: config.nostr.relays,
      signer: this.signer,
      // NDK 3.x default is outbox-enabled, which auto-adds discovery
      // relays (purplepag.es, nos.lol) for the signer's pubkey. We
      // know our own relays; skip the discovery dance.
      enableOutboxModel: false,
    });
    this.hexPubkey = nip19.npubEncode(this.signer.pubkey)
      ? this.signer.pubkey
      : this.signer.pubkey;
  }

  pubkey(): string {
    return this.hexPubkey;
  }

  /**
   * Count connected relays — pattern lifted from services/nsit-indexer,
   * which is proven inside this cluster. ndk.pool.connectedRelays()
   * is unreliable across NDK 3.x; iterating the pools' relay maps
   * and checking `relay.connected` reflects reality.
   */
  private connectedCount(): number {
    let count = 0;
    for (const pool of this.ndk.pools) {
      for (const [, relay] of pool.relays) {
        if ((relay as { connected?: boolean }).connected) count++;
      }
    }
    return count;
  }

  private async ensureConnected(): Promise<void> {
    if (this.connectedCount() > 0) return;
    try {
      await this.ndk.connect(5000);
    } catch {
      // swallow; we'll just see 0 connected and propagate the publish failure
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  async start(): Promise<void> {
    try {
      await this.ndk.connect(5000);
    } catch {
      // continue — we'll log relay status below and try again on publish
    }

    // Actively poll for at least one connected relay. The 3s fixed
    // stabilization that nsit-indexer uses works for it because it
    // publishes minutes after startup; we publish immediately, so
    // give NDK up to 60s to actually finish a handshake. Bail early
    // the moment any relay shows up.
    const deadline = Date.now() + 60000;
    while (this.connectedCount() === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log({
      event: 'startup-relay-status',
      connected: this.connectedCount(),
      waited_ms: 60000 - Math.max(0, deadline - Date.now()),
    });

    // Don't crash on initial publish failure — the refresh interval
    // retries every 24h, and operators sometimes spin up before a
    // home relay is reachable. The daemon is still useful (LNURL,
    // /purchase, /info) without the listing event landing on the
    // first attempt.
    try {
      await this.publishOnce();
    } catch (err) {
      console.error({ event: 'initial-listing-publish-failed', err: String(err) });
    }
    this.refreshTimer = setInterval(() => {
      this.publishOnce().catch((err) => {
        console.error({ event: 'listing-refresh-failed', err: String(err) });
      });
    }, LISTING_REFRESH_INTERVAL_MS);
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  async publishOnce(status: 'active' | 'sold' = 'active'): Promise<{ id: string }> {
    await this.ensureConnected();

    const nowSec = Math.floor(Date.now() / 1000);
    const spec = { ...listingSpec(this.config, this.hexPubkey, nowSec), status };
    const tags = buildListingTags(spec);
    const event = new NDKEvent(this.ndk);
    event.kind = 30402;
    event.content = spec.content ?? '';
    event.tags = tags;
    await event.sign(this.signer);

    const relayStatus: Array<{ url: string; connected: boolean }> = [];
    for (const pool of this.ndk.pools) {
      for (const [url, relay] of pool.relays) {
        relayStatus.push({ url, connected: !!(relay as { connected?: boolean }).connected });
      }
    }
    console.log({
      event: 'listing-publish-start',
      relays: relayStatus,
      configured: this.config.nostr.relays,
    });

    // 30s publish timeout (NDK default races past cold-start handshakes).
    const result = await event.publish(undefined, 30000);
    console.log({
      event: 'listing-published',
      d: this.config.listing.d_tag,
      pubkey: this.hexPubkey.slice(0, 12),
      relay_count: result.size,
      relays: [...result].map((r) => r.url),
      id: event.id,
    });
    return { id: event.id };
  }

  /** Publish a deletion event (NIP-09) for the current listing. */
  async retire(): Promise<void> {
    const event = new NDKEvent(this.ndk);
    event.kind = 5;
    event.content = 'Listing retired';
    event.tags = [['a', `30402:${this.hexPubkey}:${this.config.listing.d_tag}`]];
    await event.sign(this.signer);
    await event.publish();
  }
}
