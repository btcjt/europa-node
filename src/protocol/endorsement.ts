/**
 * NIP-51 **App curation set** parser (kind 30267).
 *
 * This is the Zap Store convention for "list of apps I recommend"
 * — adopted unmodified for marketplace endorsements. Each curation
 * set's `a` tags point at the listing coordinates the endorser
 * recommends (NIP-99 addressable: `30402:<operator-pubkey>:<d-tag>`).
 *
 * The `d`-tag on the curation set itself is the endorser's choice
 * — `"vpn-operators"`, `"my-trusted-vpns"`, `"premium-vpns"`, whatever
 * scope they like. We do not enforce a convention there.
 *
 * Endorsements target LISTINGS, not pubkeys. Endorsing the
 * addressable coordinate follows the listing through replaceable
 * updates (operator changes prices, status, etc.) but does NOT
 * carry over to a new listing the operator publishes with a
 * different `d`-tag. That asymmetry is deliberate per §7.1 of the
 * marketplace spec.
 */

import { KIND_APP_CURATION_SET, KIND_LISTING } from './constants';
import { parseListingAddress } from './purchase';
import type { NostrEventShape } from './listing';

export interface ListingCoordinate {
  /** Always 30402 for marketplace endorsements. */
  kind: number;
  pubkey: string;
  identifier: string;
}

export function coordinateString(c: ListingCoordinate): string {
  return `${c.kind}:${c.pubkey}:${c.identifier}`;
}

export interface AppCurationSet {
  id?: string;
  endorser: string;
  createdAt: number;
  /** Endorser-chosen scope identifier. No convention enforced. */
  identifier: string;
  title?: string;
  description?: string;
  image?: string;
  /** All `a`-tagged listing coordinates. Filtered to kind 30402. */
  listings: ListingCoordinate[];
  /** Raw `a` tags that didn't parse as kind-30402 listings — surfaced for debugging. */
  unknownTargets: string[];
  content: string;
}

export type EndorsementParseResult =
  | { ok: true; set: AppCurationSet }
  | { ok: false; reason: string };

/**
 * Parse a `kind: 30267` event. Returns ok:false if the event has the
 * wrong kind, missing `d` tag, or no kind-30402 `a` tags — the last
 * case means "this is someone's curation set for something else
 * (games, nostr clients, …), not VPN listings."
 */
export function parseAppCurationSet(event: NostrEventShape): EndorsementParseResult {
  if (event.kind !== KIND_APP_CURATION_SET) return { ok: false, reason: 'wrong-kind' };

  let identifier: string | undefined;
  let title: string | undefined;
  let description: string | undefined;
  let image: string | undefined;
  const listings: ListingCoordinate[] = [];
  const unknownTargets: string[] = [];
  const seen = new Set<string>();

  for (const tag of event.tags) {
    switch (tag[0]) {
      case 'd':
        if (!identifier && tag[1]) identifier = tag[1];
        break;
      case 'title':
        if (!title && tag[1]) title = tag[1];
        break;
      case 'description':
        if (!description && tag[1]) description = tag[1];
        break;
      case 'image':
        if (!image && tag[1]) image = tag[1];
        break;
      case 'a': {
        const raw = tag[1];
        if (!raw || seen.has(raw)) break;
        seen.add(raw);
        const parsed = parseListingAddress(raw);
        if (parsed && parsed.kind === KIND_LISTING) {
          listings.push(parsed);
        } else {
          unknownTargets.push(raw);
        }
        break;
      }
    }
  }

  if (!identifier) return { ok: false, reason: 'no-identifier' };
  if (listings.length === 0) return { ok: false, reason: 'no-marketplace-listings' };

  return {
    ok: true,
    set: {
      id: event.id,
      endorser: event.pubkey,
      createdAt: event.created_at,
      identifier,
      title,
      description,
      image,
      listings,
      unknownTargets,
      content: event.content ?? '',
    },
  };
}

export interface EndorsementSummary {
  /** Distinct endorser count for this listing coordinate. */
  count: number;
  /** Endorser pubkeys, sorted for snapshot stability. */
  endorsers: string[];
}

/**
 * Aggregate curation sets across many endorsers. Returns a per-listing-
 * coordinate map: each endorser contributes at most one endorsement per
 * coordinate, regardless of how many lists they publish.
 *
 * An endorser publishing multiple curation lists (one for "premium",
 * one for "free-tier") still only counts once per listing — overlap
 * across their own lists collapses.
 */
export function aggregateEndorsements(
  sets: AppCurationSet[],
): Map<string, EndorsementSummary> {
  // Keep the freshest set per (endorser, identifier) — protects against
  // accidental republishes from the same endorser of the same list.
  const latestPerSet = new Map<string, AppCurationSet>();
  for (const set of sets) {
    const key = `${set.endorser}::${set.identifier}`;
    const existing = latestPerSet.get(key);
    if (!existing || set.createdAt > existing.createdAt) {
      latestPerSet.set(key, set);
    }
  }

  // Per-coordinate distinct-endorser count.
  const out = new Map<string, EndorsementSummary>();
  for (const set of latestPerSet.values()) {
    for (const coord of set.listings) {
      const coordKey = coordinateString(coord);
      const entry = out.get(coordKey) ?? { count: 0, endorsers: [] };
      if (!entry.endorsers.includes(set.endorser)) {
        entry.endorsers.push(set.endorser);
        entry.endorsers.sort();
        entry.count += 1;
      }
      out.set(coordKey, entry);
    }
  }
  return out;
}
