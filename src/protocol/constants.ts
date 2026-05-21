/**
 * Spec defaults from §11 of docs/architecture/vpn-marketplace/spec.md.
 *
 * The marketplace is built almost entirely from existing Nostr
 * primitives — these constants name the kinds and discriminator
 * tags every implementation must agree on.
 */

export const KIND_LISTING = 30402;
/**
 * NIP-51 **App curation set** (the convention Zap Store uses).
 * `["a", "<kind>:<pubkey>:<d-tag>"]` tags point at the listings the
 * endorser recommends. Per the spec, marketplace clients filter
 * curation sets to those whose `a` tags reference kind-30402 listings
 * — no `d`-tag convention is enforced, endorsers pick freely.
 */
export const KIND_APP_CURATION_SET = 30267;
export const KIND_REPORT = 1984;
export const KIND_TRUSTED_ASSERTION = 30382;
export const KIND_BADGE_AWARD = 8;
export const KIND_BADGE_DEFINITION = 30009;

/** Every marketplace listing carries `["t", "vpn-marketplace"]`. */
export const MARKETPLACE_TAG = 'vpn-marketplace';

/** §10: listings older than 30 days without a refresh are considered stale. */
export const LISTING_STALENESS_MS = 30 * 24 * 60 * 60 * 1000;

export const SUPPORTED_VPN_PROTOCOLS = ['wireguard', 'openvpn'] as const;
export type VpnProtocol = (typeof SUPPORTED_VPN_PROTOCOLS)[number];

export const SUPPORTED_PRICE_TIME_UNITS = ['hour', 'day', 'week', 'month'] as const;
export const SUPPORTED_PRICE_DATA_UNITS = ['GiB', 'TiB'] as const;
export const SUPPORTED_PRICE_UNITS = [
  ...SUPPORTED_PRICE_TIME_UNITS,
  ...SUPPORTED_PRICE_DATA_UNITS,
] as const;
export type PriceUnit = (typeof SUPPORTED_PRICE_UNITS)[number];

export const SUPPORTED_PAYMENT_METHODS = ['lightning', 'cashu'] as const;
export type PaymentMethod = (typeof SUPPORTED_PAYMENT_METHODS)[number];

export const LIGHTNING_MECHANISMS = ['bolt11', 'lnurl-pay', 'keysend'] as const;
export type LightningMechanism = (typeof LIGHTNING_MECHANISMS)[number];

/**
 * BUD-11 Nostr-authorization wire layer per spec §6.4. Operators
 * authenticate `POST /purchase` via `Authorization: Nostr <base64(event)>`
 * with these literals.
 */
export const KIND_BUD11_AUTH = 24242;
export const AUTH_ACTION_VPN_PURCHASE = 'vpn-purchase';
export const AUTH_EXPIRATION_SECONDS = 5 * 60;

/** Per-spec recommended interval at which operators republish the listing. */
export const LISTING_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Stable version string carried in the LNURL-pay purchase comment (§6.3). */
export const PURCHASE_COMMENT_VERSION = 'vpn-marketplace/1';

/** NIP-56 standard report types. The marketplace doesn't add new ones — it only namespaces with `t: vpn-marketplace`. */
export const NIP56_REPORT_TYPES = [
  'nudity',
  'malware',
  'profanity',
  'illegal',
  'spam',
  'impersonation',
  'other',
] as const;
export type Nip56ReportType = (typeof NIP56_REPORT_TYPES)[number];

export const LISTING_STATUS = ['active', 'sold'] as const;
export type ListingStatus = (typeof LISTING_STATUS)[number];
