import { verifyEvent, type Event as NostrEvent } from 'nostr-tools';
import {
  decodeAuthorizationHeader,
  listingAddress,
  verifyAuthEventTags,
  type AuthEventCheck,
} from './protocol';
import type { OperatorConfig } from './config';

export type BudAuthResult =
  | {
      ok: true;
      check: Extract<AuthEventCheck, { ok: true }>;
      event: NostrEvent;
    }
  | { ok: false; status: number; reason: string };

/**
 * Validate a BUD-11 `Authorization: Nostr <base64>` header in a
 * purchase request. The signature is verified here; everything else
 * (action verb, expiration, server, listing, price tier) is delegated
 * to `verifyAuthEventTags`.
 */
export function checkBudAuthHeader(
  header: string | undefined,
  operatorPubkey: string,
  config: OperatorConfig,
): BudAuthResult {
  const decoded = decodeAuthorizationHeader(header);
  if (!decoded || typeof decoded !== 'object') {
    return { ok: false, status: 401, reason: 'bad-request' };
  }

  let event: NostrEvent;
  try {
    event = decoded as NostrEvent;
  } catch {
    return { ok: false, status: 401, reason: 'bad-request' };
  }

  try {
    if (!verifyEvent(event)) {
      return { ok: false, status: 401, reason: 'bad-signature' };
    }
  } catch {
    return { ok: false, status: 401, reason: 'bad-signature' };
  }

  const tagCheck = verifyAuthEventTags({
    event,
    expectedServer: config.server.public_host,
    expectedListings: [listingAddress(operatorPubkey, config.listing.d_tag)],
    allowedPrices: config.listing.prices.map((p) => ({
      amount: p.amount,
      currency: p.currency,
      unit: p.unit,
    })),
  });

  if (!tagCheck.ok) {
    return {
      ok: false,
      status: tagCheck.reason === 'expired' ? 401 : 400,
      reason: tagCheck.reason,
    };
  }

  return { ok: true, check: tagCheck, event };
}
