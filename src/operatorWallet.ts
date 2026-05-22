import type NDK from '@nostr-dev-kit/ndk';
import type { NDKEvent } from '@nostr-dev-kit/ndk';
import { NDKCashuWallet } from '@nostr-dev-kit/wallet';

// The operator's own NIP-60 Cashu wallet.
//
// Why the daemon has a wallet at all: a buyer's X-Cashu token is
// P2PK-locked to the operator. CashuAdapter.receive() unlocks + swaps
// it, leaving the operator holding fresh proofs — but proofs are just
// strings; if nothing persists them the operator's revenue is lost
// the moment the request handler returns.
//
// Storing those proofs as a NIP-60 wallet (kind-17375 wallet event +
// kind-7375 token events, encrypted to the operator's own pubkey,
// published to the operator's relays) means:
//   - the earnings are backed up off-box, on relays;
//   - the operator can open the exact same wallet in ANY NIP-60
//     client — including europa.westernbtc.com/account/wallet — by
//     signing in with the node's nsec, and withdraw from there.
//
// The wallet is keyed to the same nsec that signs the kind-30402
// listing. No new key, no new secret to manage.

/**
 * Load the operator's existing NIP-60 wallet, or create one if the
 * nsec has never set one up. Throws on any failure — the caller
 * (index.ts) treats that as fatal when Cashu is enabled, because a
 * daemon that accepts Cashu without a place to keep the proceeds
 * silently burns money.
 *
 * @param ndk    NDK bound to the operator's signer (the same instance
 *               ListingPublisher uses).
 * @param operatorPubkey  hex pubkey of the operator.
 * @param mints  Mints the operator accepts — seeded into a freshly
 *               created wallet's mint list (kind 10019).
 * @param relays Relays the wallet's events publish to.
 */
export async function loadOrCreateOperatorWallet(
  ndk: NDK,
  operatorPubkey: string,
  mints: string[],
  relays: string[],
): Promise<NDKCashuWallet> {
  // kind 17375 is the NIP-60 wallet event. One per identity.
  const existing = await ndk.fetchEvent({
    kinds: [17375 as number],
    authors: [operatorPubkey],
  });

  let wallet: NDKCashuWallet | undefined;
  if (existing) {
    wallet = await NDKCashuWallet.from(existing as NDKEvent);
    if (!wallet) {
      throw new Error(
        'found a kind-17375 wallet event for the operator but could not parse it',
      );
    }
    console.log({ event: 'operator-wallet-loaded', mints: wallet.mints });
  } else {
    // Auto-create: the nsec has no wallet yet. Seed it with the mints
    // the operator accepts and publish the kind-10019 nutzap-info so
    // the wallet is discoverable by NIP-61 senders too.
    wallet = await NDKCashuWallet.create(ndk, mints, relays);
    await wallet.publishMintList();
    console.log({ event: 'operator-wallet-created', mints });
  }

  // start() subscribes to the wallet's own token events so the
  // in-memory balance stays current as new kind-7375 events land.
  await wallet.start();
  return wallet;
}
