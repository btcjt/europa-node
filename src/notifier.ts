import NDK, { NDKEvent, NDKRelaySet, type NostrEvent } from '@nostr-dev-kit/ndk';
import { nip19 } from 'nostr-tools';
import { wrapEvent } from 'nostr-tools/nip17';
import type { NDKCashuWallet } from '@nostr-dev-kit/wallet';
import type { OperatorConfig } from './config';

// Optional operator notifications over NIP-17 private direct messages.
//
// When `[notifications]` is enabled the daemon DMs the operator on
// every completed sale and (optionally) on a periodic balance
// heartbeat. The message is a NIP-17 gift-wrapped DM: a kind-14 chat
// rumor, sealed (kind 13) and gift-wrapped (kind 1059, NIP-59), so
// relays only ever see opaque wraps. The operator reads them in any
// NIP-17-capable client (0xchat, Amethyst, …) signed in as the
// configured recipient pubkey.
//
// Sender = the node's own nsec (the one that signs the listing).
// Recipient = `[notifications].pubkey` — point it at the operator's
// personal npub, not the node's.
//
// Hard rule: a notification failure must NEVER affect a purchase.
// Every send is best-effort and swallows its own errors; callers
// fire-and-forget.

const KIND_DM_RELAYS = 10050; // NIP-17 "relays to receive DMs" list.

export interface PurchaseNotice {
  /** Sats actually collected for this sale. */
  amountSat: number;
  /** Human label for the price tier, e.g. "1000 sat/day". */
  priceLabel: string;
  paymentMethod: 'cashu' | 'lightning';
  /** The listing's d-tag, so an operator running several nodes can tell them apart. */
  listingDTag: string;
  /**
   * Unix seconds the bought tunnel expires, or null for a data-metered
   * tier that has no time expiry.
   */
  expiresAt: number | null;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error('invalid hex string');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Decode an `nsec1…` or raw-hex secret key to the 32 raw bytes. */
function nsecToBytes(nsec: string): Uint8Array {
  const t = nsec.trim();
  if (t.startsWith('nsec1')) {
    const d = nip19.decode(t);
    if (d.type !== 'nsec') throw new Error('not an nsec');
    return d.data;
  }
  return hexToBytes(t);
}

/** Decode an `npub1…` or raw-hex pubkey to the 64-char hex form. */
function pubkeyToHex(pubkey: string): string {
  const t = pubkey.trim();
  if (t.startsWith('npub1')) {
    const d = nip19.decode(t);
    if (d.type !== 'npub') throw new Error('not an npub');
    return d.data;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(t)) {
    throw new Error('notifications.pubkey must be an npub or 64-char hex pubkey');
  }
  return t.toLowerCase();
}

function fmtSats(n: number): string {
  return `${n.toLocaleString('en-US')} sat`;
}

function fmtExpiry(unixSeconds: number): string {
  // 2026-05-23 14:30 UTC
  return `${new Date(unixSeconds * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

export class Notifier {
  private readonly ndk: NDK;
  private readonly senderSk: Uint8Array;
  private readonly recipientHex: string;
  private readonly nodeRelays: string[];
  private readonly wallet: NDKCashuWallet | null;
  private readonly listingDTag: string;
  private relaySet: NDKRelaySet | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  private constructor(opts: {
    ndk: NDK;
    senderSk: Uint8Array;
    recipientHex: string;
    nodeRelays: string[];
    wallet: NDKCashuWallet | null;
    listingDTag: string;
  }) {
    this.ndk = opts.ndk;
    this.senderSk = opts.senderSk;
    this.recipientHex = opts.recipientHex;
    this.nodeRelays = opts.nodeRelays;
    this.wallet = opts.wallet;
    this.listingDTag = opts.listingDTag;
  }

  /**
   * Build a Notifier from config, or return null when notifications
   * are disabled. Throws only on a genuinely broken config (bad
   * recipient pubkey) — that's an operator misconfiguration worth
   * failing loudly on, the same way a bad nsec is.
   */
  static fromConfig(
    config: OperatorConfig,
    nsec: string,
    ndk: NDK,
    wallet: NDKCashuWallet | null,
  ): Notifier | null {
    if (!config.notifications.enabled) return null;
    if (!config.notifications.pubkey) return null;
    return new Notifier({
      ndk,
      senderSk: nsecToBytes(nsec),
      recipientHex: pubkeyToHex(config.notifications.pubkey),
      nodeRelays: config.nostr.relays,
      wallet,
      listingDTag: config.listing.d_tag,
    });
  }

  /**
   * Resolve where to publish the gift wraps. NIP-17 says a sender
   * should deliver DMs to the recipient's kind-10050 relay list; we
   * union that with the node's own relays so the message lands even
   * if the recipient never published a 10050. Best-effort — on any
   * failure we just use the node relays.
   */
  async init(): Promise<void> {
    const urls = new Set(this.nodeRelays);
    try {
      const dmList = await this.ndk.fetchEvent({
        kinds: [KIND_DM_RELAYS],
        authors: [this.recipientHex],
      });
      for (const tag of dmList?.tags ?? []) {
        if (tag[0] === 'relay' && tag[1]) urls.add(tag[1]);
      }
    } catch {
      // Recipient has no reachable 10050 — node relays it is.
    }
    this.relaySet = NDKRelaySet.fromRelayUrls([...urls], this.ndk);
  }

  /** Start a periodic balance-heartbeat DM. `hours <= 0` is a no-op. */
  startHeartbeat(hours: number): void {
    if (hours <= 0) return;
    this.heartbeatTimer = setInterval(
      () => void this.notifyBalance(),
      hours * 3_600_000,
    );
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async notifyStartup(listingTitle: string): Promise<void> {
    const lines = [
      'europa-node is online.',
      `Listing: ${listingTitle}`,
      this.balanceLine(),
      "You'll get a private message here on every sale.",
    ].filter((l): l is string => !!l);
    await this.send(lines.join('\n'));
  }

  async notifyPurchase(notice: PurchaseNotice): Promise<void> {
    const lines = [
      'New VPN sale.',
      `Listing: ${notice.listingDTag}`,
      `Paid: ${fmtSats(notice.amountSat)} via ${notice.paymentMethod}`,
      `Tier: ${notice.priceLabel}`,
      notice.expiresAt
        ? `Tunnel expires: ${fmtExpiry(notice.expiresAt)}`
        : 'Tunnel: data-metered (no time expiry)',
      this.balanceLine(),
    ].filter((l): l is string => !!l);
    await this.send(lines.join('\n'));
  }

  async notifyBalance(): Promise<void> {
    const balance = this.balanceLine();
    if (!balance) return; // no wallet — nothing to heartbeat
    await this.send(`europa-node balance check.\n${balance}`);
  }

  /** Current NIP-60 wallet balance line, or null when there's no wallet. */
  private balanceLine(): string | null {
    if (!this.wallet) return null;
    try {
      return `Wallet balance: ${fmtSats(this.wallet.state.getBalance())}`;
    } catch {
      return null;
    }
  }

  /** Gift-wrap `message` to the recipient and publish it. Never throws. */
  private async send(message: string): Promise<void> {
    try {
      const wrap = wrapEvent(
        this.senderSk,
        { publicKey: this.recipientHex },
        message,
        `europa-node (${this.listingDTag})`,
      );
      const relaySet =
        this.relaySet ?? NDKRelaySet.fromRelayUrls(this.nodeRelays, this.ndk);
      const event = new NDKEvent(this.ndk, wrap as unknown as NostrEvent);
      const published = await event.publish(relaySet, 10_000);
      console.log({ event: 'notification-sent', relays: published.size });
    } catch (err) {
      // A notification failure must never surface to a buyer or crash
      // a timer. Log and move on.
      console.error({ event: 'notification-failed', err: String(err) });
    }
  }
}
