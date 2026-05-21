import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

const priceSchema = z.object({
  amount: z.number().positive(),
  currency: z.string(),
  unit: z.string(),
});

const paymentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('lightning'),
    endpoint: z.string().url(),
    mechanism: z.enum(['bolt11', 'lnurl-pay', 'keysend']),
  }),
  z.object({
    type: z.literal('cashu'),
    mint: z.string().url(),
    p2pk: z.string(),
    endpoint: z.string().url(),
  }),
]);

const listingSchema = z.object({
  d_tag: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().optional(),
  protocols: z.array(z.enum(['wireguard', 'openvpn'])).min(1),
  region: z
    .object({
      country: z.string().optional(),
      sub: z.string().optional(),
      geohash: z.string().optional(),
    })
    .optional(),
  prices: z.array(priceSchema).min(1),
  payment_methods: z.array(paymentSchema).min(1),
  min_purchase: z.object({ amount: z.number().positive(), unit: z.string() }).optional(),
  max_purchase: z.object({ amount: z.number().positive(), unit: z.string() }).optional(),
  capacity: z.object({ amount: z.number().positive(), unit: z.string() }).optional(),
  policies: z.array(z.string()).optional(),
  policy_url: z.string().url().optional(),
  protocol_config_url: z.string().url().optional(),
  content: z.string().optional(),
});

const wireguardSchema = z.object({
  interface: z.string().default('wg0'),
  endpoint_host: z.string().min(1),
  endpoint_port: z.coerce.number().int().positive().default(51820),
  server_pubkey: z.string().min(1),
  subnet_cidr: z.string().default('10.42.0.0/24'),
  dns: z.array(z.string()).default(['1.1.1.1', '9.9.9.9']),
});

const lightningSchema = z.object({
  enabled: z.boolean().default(false),
  backend: z.enum(['phoenixd', 'stub']).default('stub'),
  base_url: z.string().url().optional(),
  api_token: z.string().optional(),
});

const cashuSchema = z.object({
  enabled: z.boolean().default(false),
  mint_url: z.string().url().optional(),
  p2pk_privkey_hex: z.string().optional(),
});

const nostrSchema = z.object({
  relays: z.array(z.string().url()).min(1),
  /** Either an inline nsec / hex string or a path to a 0600 file. */
  nsec: z.string().optional(),
  nsec_file: z.string().optional(),
});

const serverSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().positive().default(8080),
  /** Public hostname used in BUD-11 auth `server` tag validation. */
  public_host: z.string().min(1),
});

const dbSchema = z.object({
  path: z.string().default('/var/lib/europa-node/sessions.db'),
});

export const operatorConfigSchema = z.object({
  server: serverSchema,
  db: dbSchema.default({ path: '/var/lib/europa-node/sessions.db' }),
  wireguard: wireguardSchema,
  lightning: lightningSchema.default({ enabled: false, backend: 'stub' }),
  cashu: cashuSchema.default({ enabled: false }),
  nostr: nostrSchema,
  listing: listingSchema,
});

export type OperatorConfig = z.infer<typeof operatorConfigSchema>;
export type ListingConfig = z.infer<typeof listingSchema>;
export type PaymentConfig = z.infer<typeof paymentSchema>;
export type PriceConfig = z.infer<typeof priceSchema>;

export function loadConfig(path: string): OperatorConfig {
  const raw = readFileSync(resolve(path), 'utf-8');
  const parsed = parseToml(raw);
  return operatorConfigSchema.parse(parsed);
}

export function loadNsec(config: OperatorConfig): string {
  if (config.nostr.nsec) return config.nostr.nsec.trim();
  if (config.nostr.nsec_file) {
    return readFileSync(resolve(config.nostr.nsec_file), 'utf-8').trim();
  }
  throw new Error('nostr.nsec or nostr.nsec_file required in config');
}
