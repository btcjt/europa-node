/**
 * NIP-56 report parser per spec §6.2.
 *
 * Marketplace-relevant reports are kind-1984 events that p-tag an
 * operator (optionally with a NIP-56 standard report type) and carry
 * `["t", "vpn-marketplace"]` for namespacing.
 *
 * Clients aggregate reports from npubs the user follows. The protocol
 * does not auto-hide operators based on reports — surfacing counts and
 * categories is the marketplace's job; thresholding is the user's.
 */

import {
  KIND_REPORT,
  EUROPA_PROTOCOL_TAG,
  LEGACY_MARKETPLACE_TAG,
  NIP56_REPORT_TYPES,
} from './constants';
import type { Nip56ReportType } from './constants';
import type { NostrEventShape } from './listing';

export interface Report {
  id?: string;
  reporter: string;
  createdAt: number;
  /** Subject pubkeys (operators) named in `p` tags. */
  targets: { pubkey: string; reportType?: Nip56ReportType | string }[];
  /** Subject event-ids named in `e` tags, if the reporter pointed at a specific listing. */
  eventTargets: string[];
  content: string;
}

const REPORT_TYPE_SET: ReadonlySet<string> = new Set(NIP56_REPORT_TYPES);

export function isKnownReportType(value: string): value is Nip56ReportType {
  return REPORT_TYPE_SET.has(value);
}

export type ReportParseResult =
  | { ok: true; report: Report }
  | { ok: false; reason: string };

export function parseReport(event: NostrEventShape): ReportParseResult {
  if (event.kind !== KIND_REPORT) return { ok: false, reason: 'wrong-kind' };

  // Accept both the canonical Europa Protocol tag and the legacy
  // `vpn-marketplace` tag — historical reports tagged with the old
  // value still count during the back-compat window.
  let isProtocolTagged = false;
  const targets: Report['targets'] = [];
  const eventTargets: string[] = [];
  for (const tag of event.tags) {
    if (
      tag[0] === 't' &&
      (tag[1] === EUROPA_PROTOCOL_TAG || tag[1] === LEGACY_MARKETPLACE_TAG)
    ) {
      isProtocolTagged = true;
    } else if (tag[0] === 'p') {
      const pubkey = tag[1];
      if (pubkey) targets.push({ pubkey, reportType: tag[2] });
    } else if (tag[0] === 'e') {
      const id = tag[1];
      if (id) eventTargets.push(id);
    }
  }
  if (!isProtocolTagged) return { ok: false, reason: 'not-europa-protocol' };
  if (targets.length === 0 && eventTargets.length === 0) {
    return { ok: false, reason: 'no-target' };
  }

  return {
    ok: true,
    report: {
      id: event.id,
      reporter: event.pubkey,
      createdAt: event.created_at,
      targets,
      eventTargets,
      content: event.content ?? '',
    },
  };
}

export interface ReportSummary {
  count: number;
  reporters: string[];
  /** Count per NIP-56 report type. Unknown/missing types bucket under `'other'`. */
  byType: Map<string, number>;
}

/**
 * Group reports by target operator pubkey. Each (operator, reporter) pair
 * counts once, even if a single reporter publishes multiple reports against
 * the same operator — defensive against spam.
 */
export function aggregateReports(reports: Report[]): Map<string, ReportSummary> {
  const seen = new Set<string>();
  const out = new Map<string, ReportSummary>();
  for (const r of reports) {
    for (const t of r.targets) {
      const key = `${t.pubkey}::${r.reporter}::${t.reportType ?? 'unspecified'}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const entry: ReportSummary =
        out.get(t.pubkey) ?? { count: 0, reporters: [], byType: new Map() };
      entry.count += 1;
      if (!entry.reporters.includes(r.reporter)) entry.reporters.push(r.reporter);
      const bucket = t.reportType ?? 'other';
      entry.byType.set(bucket, (entry.byType.get(bucket) ?? 0) + 1);
      out.set(t.pubkey, entry);
    }
  }
  return out;
}
