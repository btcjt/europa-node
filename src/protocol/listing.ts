/**
 * NIP-99 classified listing parser for Europa VPN-marketplace listings
 * (spec §4).
 *
 * A `kind: 30402` event qualifies as a marketplace listing iff it carries
 * a `["t", "vpn-marketplace"]` tag and at least one supported VPN-protocol
 * tag (`wireguard` or `openvpn`). Anything else returns
 * `{ ok: false, reason }` so a client filter pass over the wider NIP-99
 * universe doesn't crash on neighboring listings.
 */

import {
  KIND_LISTING,
  LISTING_STALENESS_MS,
  LISTING_STATUS,
  LIGHTNING_MECHANISMS,
  EUROPA_PROTOCOL_TAG,
  LEGACY_MARKETPLACE_TAG,
  SUPPORTED_PAYMENT_METHODS,
  SUPPORTED_PRICE_UNITS,
  SUPPORTED_VPN_PROTOCOLS,
  type LightningMechanism,
  type ListingStatus,
  type PaymentMethod,
  type PriceUnit,
  type VpnProtocol,
} from './constants';

export interface Price {
  amount: number;
  currency: string;
  unit: string;
}

export interface LightningPayment {
  kind: 'lightning';
  target: string;
  mechanism: LightningMechanism;
}

export interface CashuPayment {
  kind: 'cashu';
  mint: string;
  p2pk: string;
  /**
   * Operator's HTTPS purchase endpoint that accepts the X-Cashu /
   * BUD-11 POST per spec §6.2. Present in 5-field `payment` tags;
   * older 4-field tags omit it (clients must reject those for Cashu
   * purchases — without an endpoint there's nowhere to send the token).
   */
  endpoint?: string;
}

/**
 * Catch-all for payment methods this version doesn't model — the wire
 * `method` field is preserved so UIs can display "operator advertised X,
 * we don't know how to talk to it" without erasing the value.
 */
export interface UnknownPayment {
  kind: 'unknown';
  method: string;
  args: string[];
}

export type Payment = LightningPayment | CashuPayment | UnknownPayment;

export interface NostrEventShape {
  id?: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content?: string;
  sig?: string;
}

export interface Listing {
  id?: string;
  pubkey: string;
  createdAt: number;
  /** NIP-99 addressable identifier (`d` tag). */
  identifier: string;
  title: string;
  /** All `t` tags except `vpn-marketplace`. */
  topics: string[];
  protocols: VpnProtocol[];
  prices: Price[];
  payments: Payment[];
  status: ListingStatus;
  location: string[];
  /**
   * Geohashes from `g` tags — the marketplace's convention for putting
   * a listing on a map without committing operators to exact GPS. The
   * operator publishes a **hash ladder**: for an operator-set precision
   * of e.g. `dhvr5`, the event carries `g` tags for every prefix:
   * `d`, `dh`, `dhv`, `dhvr`, `dhvr5`. This makes relay-side `#g`
   * filters work at any precision (`#g: ['d']` matches every listing
   * in the eastern US; `#g: ['dhvr5']` matches just the specific
   * cell). Empty array if the operator only published ISO `location`
   * strings.
   *
   * The array preserves *all* ladder entries from the event. Use
   * {@link mostSpecificGeohashes} when you want only the operator-set
   * "tips" (one per region, the longest in each chain) — e.g. for
   * map-pin rendering, where iterating the whole ladder would drop
   * five overlapping pins per listing.
   */
  geohashes: string[];
  summary?: string;
  minPurchase?: { amount: number; unit: string };
  maxPurchase?: { amount: number; unit: string };
  publishedAt?: number;
  image?: string;
  capacity?: { amount: number; unit: string };
  policies: string[];
  policyUrl?: string;
  protocolConfigUrl?: string;
  content: string;
}

export interface ListingSpec {
  pubkey: string;
  createdAt: number;
  identifier: string;
  title: string;
  protocols: VpnProtocol[];
  prices: Price[];
  payments: Payment[];
  status?: ListingStatus;
  topics?: string[];
  location?: string[];
  geohashes?: string[];
  summary?: string;
  minPurchase?: { amount: number; unit: string };
  maxPurchase?: { amount: number; unit: string };
  publishedAt?: number;
  image?: string;
  capacity?: { amount: number; unit: string };
  policies?: string[];
  policyUrl?: string;
  protocolConfigUrl?: string;
  content?: string;
}

export type ParseResult =
  | { ok: true; listing: Listing }
  | { ok: false; reason: string };

const PRICE_UNIT_SET: ReadonlySet<string> = new Set(SUPPORTED_PRICE_UNITS);
const VPN_PROTOCOL_SET: ReadonlySet<string> = new Set(SUPPORTED_VPN_PROTOCOLS);
const PAYMENT_METHOD_SET: ReadonlySet<string> = new Set(SUPPORTED_PAYMENT_METHODS);
const LIGHTNING_MECHANISM_SET: ReadonlySet<string> = new Set(LIGHTNING_MECHANISMS);

export function isKnownPriceUnit(value: string): value is PriceUnit {
  return PRICE_UNIT_SET.has(value);
}

export function isKnownVpnProtocol(value: string): value is VpnProtocol {
  return VPN_PROTOCOL_SET.has(value);
}

export function isKnownPaymentMethod(value: string): value is PaymentMethod {
  return PAYMENT_METHOD_SET.has(value);
}

function bucketTags(tags: string[][]): Map<string, string[][]> {
  const map = new Map<string, string[][]>();
  for (const tag of tags) {
    const name = tag[0];
    if (!name) continue;
    const bucket = map.get(name);
    if (bucket) bucket.push(tag);
    else map.set(name, [tag]);
  }
  return map;
}

function parsePrice(tag: string[]): Price | null {
  const amountRaw = tag[1];
  const currency = tag[2];
  const unit = tag[3];
  if (!amountRaw || !currency || !unit) return null;
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return { amount, currency, unit };
}

function parsePayment(tag: string[]): Payment | null {
  const method = tag[1];
  if (!method) return null;
  if (method === 'lightning') {
    const target = tag[2];
    const mechanism = tag[3];
    if (!target || !mechanism) return null;
    return { kind: 'lightning', target, mechanism: mechanism as LightningMechanism };
  }
  if (method === 'cashu') {
    const mint = tag[2];
    const p2pk = tag[3];
    if (!mint || !p2pk) return null;
    const endpoint = tag[4];
    return { kind: 'cashu', mint, p2pk, ...(endpoint ? { endpoint } : {}) };
  }
  return {
    kind: 'unknown',
    method,
    args: tag.slice(2).filter((v): v is string => Boolean(v)),
  };
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function parseAmountUnit(tag: string[]): { amount: number; unit: string } | undefined {
  const amount = Number(tag[1]);
  const unit = tag[2];
  if (!Number.isFinite(amount) || !unit) return undefined;
  return { amount, unit };
}

/**
 * Parse a NIP-99 (kind:30402) event into a typed Europa marketplace listing.
 * Returns `{ ok: false, reason }` when the event is shaped like a NIP-99
 * listing but doesn't carry the marketplace's discriminator tags — clients
 * use this to filter against the wider NIP-99 universe.
 */
export function parseListing(event: NostrEventShape): ParseResult {
  if (event.kind !== KIND_LISTING) return { ok: false, reason: 'wrong-kind' };

  const tagMap = bucketTags(event.tags);

  const tTags = tagMap.get('t') ?? [];
  const tValues = tTags
    .map((t) => t[1])
    .filter((v): v is string => Boolean(v));

  // Accept BOTH the canonical Europa Protocol tag and the legacy
  // `vpn-marketplace` tag — operators on europa-node ≤ 0.6.x still
  // emit only the legacy value, and we want them visible to buyers
  // during the transition window. See `LEGACY_MARKETPLACE_TAG` in
  // ./constants.ts for the sunset target. Emit always uses the new
  // tag (see `buildListingTags` below).
  if (!tValues.includes(EUROPA_PROTOCOL_TAG) && !tValues.includes(LEGACY_MARKETPLACE_TAG)) {
    return { ok: false, reason: 'not-europa-protocol' };
  }

  const protocols: VpnProtocol[] = [];
  for (const v of tValues) {
    if (isKnownVpnProtocol(v) && !protocols.includes(v)) protocols.push(v);
  }
  if (protocols.length === 0) return { ok: false, reason: 'no-protocol' };

  const identifier = tagMap.get('d')?.[0]?.[1];
  if (!identifier) return { ok: false, reason: 'no-identifier' };

  const title = tagMap.get('title')?.[0]?.[1];
  if (!title) return { ok: false, reason: 'no-title' };

  const prices: Price[] = [];
  for (const t of tagMap.get('price') ?? []) {
    const price = parsePrice(t);
    if (price) prices.push(price);
  }
  if (prices.length === 0) return { ok: false, reason: 'no-price' };

  const payments: Payment[] = [];
  for (const t of tagMap.get('payment') ?? []) {
    const payment = parsePayment(t);
    if (payment) payments.push(payment);
  }
  if (payments.length === 0) return { ok: false, reason: 'no-payment' };

  const statusTag = tagMap.get('status')?.[0]?.[1];
  const status: ListingStatus =
    statusTag && (LISTING_STATUS as readonly string[]).includes(statusTag)
      ? (statusTag as ListingStatus)
      : 'active';

  const locationTag = tagMap.get('location')?.[0];
  const location = locationTag ? locationTag.slice(1).filter((s): s is string => Boolean(s)) : [];

  const geohashes: string[] = [];
  for (const t of tagMap.get('g') ?? []) {
    const value = t[1];
    if (value && !geohashes.includes(value)) geohashes.push(value);
  }

  const summary = tagMap.get('summary')?.[0]?.[1];

  const minPurchaseTag = tagMap.get('min-purchase')?.[0];
  const minPurchase = minPurchaseTag ? parseAmountUnit(minPurchaseTag) : undefined;
  const maxPurchaseTag = tagMap.get('max-purchase')?.[0];
  const maxPurchase = maxPurchaseTag ? parseAmountUnit(maxPurchaseTag) : undefined;

  const publishedAt = parsePositiveInt(tagMap.get('published_at')?.[0]?.[1]);

  const image = tagMap.get('image')?.[0]?.[1];

  const capacityTag = tagMap.get('capacity')?.[0];
  const capacity = capacityTag ? parseAmountUnit(capacityTag) : undefined;

  const policies: string[] = [];
  for (const t of tagMap.get('policy') ?? []) {
    for (const v of t.slice(1)) {
      if (v && !policies.includes(v)) policies.push(v);
    }
  }

  const policyUrl = tagMap.get('policy-url')?.[0]?.[1];
  const protocolConfigUrl = tagMap.get('protocol-config')?.[0]?.[1];

  // Both the new and the legacy discriminator tags are protocol-level,
  // not user-defined topics — strip both so a legacy listing's
  // `t: vpn-marketplace` doesn't show up in `listing.topics`.
  const topics = tValues.filter(
    (v) =>
      v !== EUROPA_PROTOCOL_TAG &&
      v !== LEGACY_MARKETPLACE_TAG &&
      !VPN_PROTOCOL_SET.has(v),
  );

  return {
    ok: true,
    listing: {
      id: event.id,
      pubkey: event.pubkey,
      createdAt: event.created_at,
      identifier,
      title,
      topics,
      protocols,
      prices,
      payments,
      status,
      location,
      geohashes,
      summary,
      minPurchase,
      maxPurchase,
      publishedAt,
      image,
      capacity,
      policies,
      policyUrl,
      protocolConfigUrl,
      content: event.content ?? '',
    },
  };
}

export function buildListingTags(spec: ListingSpec): string[][] {
  const tags: string[][] = [
    ['d', spec.identifier],
    ['title', spec.title],
    ['t', EUROPA_PROTOCOL_TAG],
  ];
  for (const proto of spec.protocols) tags.push(['t', proto]);
  for (const topic of spec.topics ?? []) {
    if (
      topic !== EUROPA_PROTOCOL_TAG &&
      topic !== LEGACY_MARKETPLACE_TAG &&
      !VPN_PROTOCOL_SET.has(topic)
    ) {
      tags.push(['t', topic]);
    }
  }
  for (const p of spec.prices) tags.push(['price', String(p.amount), p.currency, p.unit]);
  for (const pay of spec.payments) {
    if (pay.kind === 'lightning') {
      tags.push(['payment', 'lightning', pay.target, pay.mechanism]);
    } else if (pay.kind === 'cashu') {
      const base = ['payment', 'cashu', pay.mint, pay.p2pk];
      tags.push(pay.endpoint ? [...base, pay.endpoint] : base);
    } else {
      tags.push(['payment', pay.method, ...pay.args]);
    }
  }
  if (spec.status && spec.status !== 'active') tags.push(['status', spec.status]);
  if (spec.location && spec.location.length > 0) tags.push(['location', ...spec.location]);
  // Expand operator-supplied geohashes into a hash ladder so
  // `#g`-filtered subscriptions match at any precision.
  for (const gh of expandLadderForSet(spec.geohashes)) tags.push(['g', gh]);
  if (spec.summary) tags.push(['summary', spec.summary]);
  if (spec.minPurchase) {
    tags.push(['min-purchase', String(spec.minPurchase.amount), spec.minPurchase.unit]);
  }
  if (spec.maxPurchase) {
    tags.push(['max-purchase', String(spec.maxPurchase.amount), spec.maxPurchase.unit]);
  }
  if (spec.publishedAt !== undefined) tags.push(['published_at', String(spec.publishedAt)]);
  if (spec.image) tags.push(['image', spec.image]);
  if (spec.capacity) tags.push(['capacity', String(spec.capacity.amount), spec.capacity.unit]);
  if (spec.policies && spec.policies.length > 0) tags.push(['policy', ...spec.policies]);
  if (spec.policyUrl) tags.push(['policy-url', spec.policyUrl]);
  if (spec.protocolConfigUrl) tags.push(['protocol-config', spec.protocolConfigUrl]);
  return tags;
}

export function buildListingEvent(spec: ListingSpec): NostrEventShape {
  return {
    pubkey: spec.pubkey,
    created_at: spec.createdAt,
    kind: KIND_LISTING,
    tags: buildListingTags(spec),
    content: spec.content ?? '',
  };
}

export function isListingStale(listing: Listing, nowSeconds: number): boolean {
  if (listing.status === 'sold') return false;
  const ageMs = (nowSeconds - listing.createdAt) * 1000;
  return ageMs > LISTING_STALENESS_MS;
}

const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const GEOHASH_BASE32_SET = new Set(GEOHASH_BASE32);

/**
 * Expand a single geohash into its prefix ladder.
 *
 *   expandGeohashLadder('dhvr5')
 *   // => ['d', 'dh', 'dhv', 'dhvr', 'dhvr5']
 *
 * Used by {@link buildListingTags} so a kind-30402 event carries one
 * `g` tag per ladder level — `#g` filters at any precision then
 * match. Lower-cased; returns `[]` for an empty string or any input
 * with a non-geohash character (silent fail mirrors {@link decodeGeohash}).
 */
export function expandGeohashLadder(hash: string): string[] {
  if (typeof hash !== 'string' || hash.length === 0) return [];
  const lower = hash.toLowerCase();
  for (const c of lower) {
    if (!GEOHASH_BASE32_SET.has(c)) return [];
  }
  const out: string[] = [];
  for (let i = 1; i <= lower.length; i++) out.push(lower.slice(0, i));
  return out;
}

// Expand a *set* of operator-supplied geohashes into the deduped ladder
// union, preserving first-seen order within each input chain. Internal
// helper for buildListingTags.
function expandLadderForSet(hashes: readonly string[] | undefined): string[] {
  if (!hashes || hashes.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hashes) {
    for (const step of expandGeohashLadder(h)) {
      if (!seen.has(step)) {
        seen.add(step);
        out.push(step);
      }
    }
  }
  return out;
}

/**
 * Pick the operator-set "tips" out of a geohash array — every entry
 * that no other entry strictly extends. Use this when you want one
 * value per region (e.g. for a map pin), not every level of the
 * ladder.
 *
 *   mostSpecificGeohashes(['d', 'dh', 'dhv', 'dhvr', 'dhvr5'])
 *   // => ['dhvr5']
 *
 *   mostSpecificGeohashes(['d', 'dh', 'dhv', 'dhvr', 'dhvr5',
 *                          'dq', 'dq8', 'dq8x'])
 *   // => ['dhvr5', 'dq8x']
 *
 * Order matches first appearance in the input. Returns `[]` for
 * empty input. Works against a {@link Listing}'s `geohashes` field
 * regardless of whether the operator used the ladder convention —
 * if they only published `dhvr5` directly, that's already a tip.
 */
export function mostSpecificGeohashes(hashes: readonly string[]): string[] {
  if (!hashes || hashes.length === 0) return [];
  const out: string[] = [];
  for (const h of hashes) {
    let isPrefix = false;
    for (const other of hashes) {
      if (other.length > h.length && other.startsWith(h)) {
        isPrefix = true;
        break;
      }
    }
    if (!isPrefix && !out.includes(h)) out.push(h);
  }
  return out;
}


/**
 * Decode a geohash to a centroid `{ lat, lon }` and the lat/lon error
 * bounds. Implements the standard base-32 Geohash algorithm — no NIP
 * needed; the `g` tag's value is just whatever the operator chose at
 * whatever precision they like (typically 4–6 chars).
 *
 * Returns `null` if the input contains characters outside the
 * geohash alphabet.
 */
export function decodeGeohash(hash: string): {
  lat: number;
  lon: number;
  latError: number;
  lonError: number;
} | null {
  if (hash.length === 0) return null;
  let evenBit = true;
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;

  for (const rawChar of hash) {
    const idx = GEOHASH_BASE32.indexOf(rawChar.toLowerCase());
    if (idx < 0) return null;
    for (let n = 4; n >= 0; n--) {
      const bitN = (idx >> n) & 1;
      if (evenBit) {
        const lonMid = (lonMin + lonMax) / 2;
        if (bitN === 1) lonMin = lonMid;
        else lonMax = lonMid;
      } else {
        const latMid = (latMin + latMax) / 2;
        if (bitN === 1) latMin = latMid;
        else latMax = latMid;
      }
      evenBit = !evenBit;
    }
  }

  return {
    lat: (latMin + latMax) / 2,
    lon: (lonMin + lonMax) / 2,
    latError: (latMax - latMin) / 2,
    lonError: (lonMax - lonMin) / 2,
  };
}

export function cheapestPrice(prices: Price[], unit: string): Price | null {
  let best: Price | null = null;
  for (const p of prices) {
    if (p.unit !== unit) continue;
    if (!best || p.amount < best.amount) best = p;
  }
  return best;
}
