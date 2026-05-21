/**
 * Purchase-flow primitives per spec §6.
 *
 * Two paths land here:
 *  - Lightning (LNURL-pay): the client embeds a JSON `comment` in the
 *    LNURL-pay callback (§6.3). `buildLnurlPurchaseComment` /
 *    `parseLnurlPurchaseComment` shape that JSON.
 *  - Cashu (X-Cashu + BUD-11): the client signs a `kind: 24242` event
 *    and base64-encodes it into an `Authorization: Nostr <...>` header
 *    (§6.4). `buildAuthEvent` constructs the tag set;
 *    `verifyAuthEventTags` is the operator-side validation.
 *
 * Signing/verifying the event signature itself isn't done here — that's
 * the caller's job (Nostr libraries already provide that). This module
 * only owns the tag schema and the comment JSON shape.
 */

import {
  AUTH_ACTION_VPN_PURCHASE,
  AUTH_EXPIRATION_SECONDS,
  KIND_BUD11_AUTH,
  KIND_LISTING,
  PURCHASE_COMMENT_VERSION,
} from './constants';
import type { Price } from './listing';

/** A NIP-99 addressable coordinate, used in `a` tags. */
export function listingAddress(pubkey: string, identifier: string): string {
  return `${KIND_LISTING}:${pubkey}:${identifier}`;
}

export function parseListingAddress(
  address: string,
): { kind: number; pubkey: string; identifier: string } | null {
  const parts = address.split(':');
  if (parts.length < 3) return null;
  const [kindRaw, pubkey, ...identifierParts] = parts as [
    string,
    string,
    ...string[],
  ];
  const kind = Number(kindRaw);
  if (!Number.isFinite(kind)) return null;
  return { kind, pubkey, identifier: identifierParts.join(':') };
}

export interface LnurlPurchaseComment {
  version: string;
  /** NIP-99 address: `30402:<operator-pubkey>:<d-tag>`. */
  listing: string;
  /** The exact `price` tag the client is paying against. */
  price: [string, string, string, string];
  protocol: 'wireguard' | 'openvpn' | string;
  /** For WireGuard: base64 of the client's WG public key. For OpenVPN: client identifier. */
  client_pubkey?: string;
  client_id?: string;
}

export function buildLnurlPurchaseComment(input: {
  operatorPubkey: string;
  identifier: string;
  price: Price;
  protocol: string;
  clientPubkey?: string;
  clientId?: string;
}): LnurlPurchaseComment {
  return {
    version: PURCHASE_COMMENT_VERSION,
    listing: listingAddress(input.operatorPubkey, input.identifier),
    price: ['price', String(input.price.amount), input.price.currency, input.price.unit],
    protocol: input.protocol,
    ...(input.clientPubkey ? { client_pubkey: input.clientPubkey } : {}),
    ...(input.clientId ? { client_id: input.clientId } : {}),
  };
}

export type LnurlCommentParseResult =
  | { ok: true; comment: LnurlPurchaseComment }
  | { ok: false; reason: string };

export function parseLnurlPurchaseComment(raw: unknown): LnurlCommentParseResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'not-an-object' };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== PURCHASE_COMMENT_VERSION) {
    return { ok: false, reason: 'version-mismatch' };
  }
  if (typeof obj.listing !== 'string') return { ok: false, reason: 'no-listing' };
  if (!Array.isArray(obj.price) || obj.price.length !== 4) {
    return { ok: false, reason: 'bad-price' };
  }
  if (typeof obj.protocol !== 'string') return { ok: false, reason: 'no-protocol' };
  const [pTag, amount, currency, unit] = obj.price as unknown[];
  if (
    pTag !== 'price' ||
    typeof amount !== 'string' ||
    typeof currency !== 'string' ||
    typeof unit !== 'string'
  ) {
    return { ok: false, reason: 'bad-price' };
  }
  const comment: LnurlPurchaseComment = {
    version: obj.version,
    listing: obj.listing,
    price: [pTag, amount, currency, unit],
    protocol: obj.protocol,
    ...(typeof obj.client_pubkey === 'string' ? { client_pubkey: obj.client_pubkey } : {}),
    ...(typeof obj.client_id === 'string' ? { client_id: obj.client_id } : {}),
  };
  return { ok: true, comment };
}

export interface AuthEventInput {
  operatorPubkey: string;
  identifier: string;
  price: Price;
  /** Operator's HTTPS host (no scheme). Spec §6.4 calls this the `server` tag. */
  server: string;
  /** Unix-seconds. Defaults to now + AUTH_EXPIRATION_SECONDS. */
  expiration?: number;
  nowSeconds?: number;
}

export interface AuthEventDraft {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/**
 * Build the tag set + content for a BUD-11 (`kind: 24242`) auth event.
 * The caller signs it with the client's ephemeral key. The
 * `Authorization: Nostr` header is `'Nostr ' + base64(JSON(event))`.
 */
export function buildAuthEvent(input: AuthEventInput): AuthEventDraft {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = input.expiration ?? now + AUTH_EXPIRATION_SECONDS;
  return {
    kind: KIND_BUD11_AUTH,
    created_at: now,
    tags: [
      ['t', AUTH_ACTION_VPN_PURCHASE],
      ['expiration', String(exp)],
      ['server', input.server],
      ['a', listingAddress(input.operatorPubkey, input.identifier)],
      ['price', String(input.price.amount), input.price.currency, input.price.unit],
    ],
    content: 'Purchase VPN access',
  };
}

export interface AuthEventCheckInput {
  /** Unparsed kind, tags, content, pubkey. Caller verifies signature separately. */
  event: {
    pubkey: string;
    kind: number;
    created_at: number;
    tags: string[][];
    content?: string;
    sig?: string;
  };
  /** Operator's expected server hostname. */
  expectedServer: string;
  /** Operator's expected listing address (`30402:<pubkey>:<d>`). Any active listing. */
  expectedListings: string[];
  /** Allowed price tags for the matched listing. */
  allowedPrices: Price[];
  nowSeconds?: number;
}

export type AuthEventCheck =
  | {
      ok: true;
      matchedListing: string;
      matchedPrice: Price;
    }
  | {
      ok: false;
      reason:
        | 'wrong-kind'
        | 'wrong-action'
        | 'no-expiration'
        | 'expired'
        | 'wrong-server'
        | 'no-listing'
        | 'unknown-listing'
        | 'no-price'
        | 'price-mismatch';
    };

function pricesEqual(a: Price, tuple: string[]): boolean {
  if (tuple.length < 4) return false;
  const [, amountRaw, currency, unit] = tuple;
  if (!amountRaw || !currency || !unit) return false;
  return (
    Number(amountRaw) === a.amount && currency === a.currency && unit === a.unit
  );
}

/**
 * Operator-side validation of an inbound BUD-11 auth event. Caller has
 * already verified the signature. Everything else — kind, action, expiry,
 * server, listing, price-tier match — is checked here.
 */
export function verifyAuthEventTags(input: AuthEventCheckInput): AuthEventCheck {
  const { event } = input;
  if (event.kind !== KIND_BUD11_AUTH) return { ok: false, reason: 'wrong-kind' };

  let action: string | undefined;
  let expiration: number | undefined;
  let server: string | undefined;
  const listings: string[] = [];
  const priceTuples: string[][] = [];

  for (const tag of event.tags) {
    switch (tag[0]) {
      case 't':
        if (!action) action = tag[1];
        break;
      case 'expiration': {
        const n = Number(tag[1]);
        if (Number.isFinite(n)) expiration = n;
        break;
      }
      case 'server':
        if (!server) server = tag[1];
        break;
      case 'a':
        if (tag[1]) listings.push(tag[1]);
        break;
      case 'price':
        priceTuples.push(tag);
        break;
    }
  }

  if (action !== AUTH_ACTION_VPN_PURCHASE) return { ok: false, reason: 'wrong-action' };
  if (expiration === undefined) return { ok: false, reason: 'no-expiration' };
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (expiration <= now) return { ok: false, reason: 'expired' };
  if (!server || server !== input.expectedServer) return { ok: false, reason: 'wrong-server' };
  if (listings.length === 0) return { ok: false, reason: 'no-listing' };
  const matchedListing = listings.find((a) => input.expectedListings.includes(a));
  if (!matchedListing) return { ok: false, reason: 'unknown-listing' };
  if (priceTuples.length === 0) return { ok: false, reason: 'no-price' };

  for (const allowed of input.allowedPrices) {
    for (const tuple of priceTuples) {
      if (pricesEqual(allowed, tuple)) {
        return { ok: true, matchedListing, matchedPrice: allowed };
      }
    }
  }
  return { ok: false, reason: 'price-mismatch' };
}

/**
 * Encode an auth event into the `Authorization: Nostr <base64>` header
 * value. Uses `btoa`/`atob` which exist in modern browsers, Deno, and
 * Node 16+ — no Buffer reference.
 */
export function encodeAuthorizationHeader(event: unknown): string {
  const json = JSON.stringify(event);
  return `Nostr ${btoa(unescape(encodeURIComponent(json)))}`;
}

export function decodeAuthorizationHeader(
  header: string | undefined,
): unknown | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith('nostr ')) return null;
  const b64 = trimmed.slice(6).trim();
  let raw: string;
  try {
    raw = decodeURIComponent(escape(atob(b64)));
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
