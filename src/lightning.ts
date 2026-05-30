import { createHash, randomBytes } from 'node:crypto';

export interface CreatedInvoice {
  bolt11: string;
  paymentHash: string;
  preimage: string;
}

export interface LightningBackend {
  /**
   * Create an invoice with a payment hash derived from the supplied
   * preimage. The operator owns the preimage so it can encrypt the
   * LNURL successAction; on payment the network reveals the same
   * preimage to the client.
   */
  createInvoice(opts: {
    amountSat: number;
    preimage: Buffer;
    description: string;
  }): Promise<CreatedInvoice>;

  /** Returns true once the invoice for this paymentHash has settled. */
  isPaid(paymentHash: string): Promise<boolean>;
}

export function newPreimage(): { preimage: Buffer; paymentHash: string } {
  const preimage = randomBytes(32);
  const paymentHash = createHash('sha256').update(preimage).digest('hex');
  return { preimage, paymentHash };
}

/**
 * Stub backend — used in tests and when `lightning.enabled = false`.
 * Issues "invoices" that are never payable; isPaid() always returns false.
 * The operator daemon refuses to advertise Lightning payments under the
 * stub backend, so this path only activates when something else misroutes.
 */
export class StubLightningBackend implements LightningBackend {
  async createInvoice(): Promise<CreatedInvoice> {
    throw new Error('lightning backend is stubbed — set lightning.enabled and configure phoenixd');
  }

  async isPaid(): Promise<boolean> {
    return false;
  }
}

/**
 * Phoenixd adapter — phoenix.acinq.co/server. The HTTP API is small
 * enough that we hand-roll requests rather than pulling a client lib.
 */
export class PhoenixdBackend implements LightningBackend {
  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string,
  ) {}

  private auth(): string {
    return 'Basic ' + btoa(`:${this.apiToken}`);
  }

  async createInvoice(opts: {
    amountSat: number;
    preimage: Buffer;
    description: string;
  }): Promise<CreatedInvoice> {
    const body = new URLSearchParams({
      amountSat: String(opts.amountSat),
      description: opts.description,
      externalId: opts.preimage.toString('hex'),
    });
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/createinvoice`, {
      method: 'POST',
      headers: {
        Authorization: this.auth(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`phoenixd createinvoice ${res.status}: ${txt}`);
    }
    const data = (await res.json()) as {
      serialized?: string;
      paymentHash?: string;
    };
    if (!data.serialized || !data.paymentHash) {
      throw new Error('phoenixd createinvoice missing fields');
    }
    const incomingRes = await fetch(
      `${this.baseUrl.replace(/\/$/, '')}/payments/incoming/${data.paymentHash}`,
      { headers: { Authorization: this.auth() } },
    );
    if (!incomingRes.ok) {
      const txt = await incomingRes.text().catch(() => '');
      throw new Error(`phoenixd incoming payment lookup ${incomingRes.status}: ${txt}`);
    }

    const incoming = (await incomingRes.json()) as {
      preimage?: string;
    };
    if (!incoming.preimage || !/^[0-9a-fA-F]{64}$/.test(incoming.preimage)) {
      throw new Error('phoenixd incoming payment lookup missing valid preimage');
    }

    return {
      bolt11: data.serialized,
      paymentHash: data.paymentHash,
      preimage: incoming.preimage,
    };
  }

  async isPaid(paymentHash: string): Promise<boolean> {
    const res = await fetch(
      `${this.baseUrl.replace(/\/$/, '')}/payments/incoming/${paymentHash}`,
      { headers: { Authorization: this.auth() } },
    );
    if (!res.ok) return false;
    const data = (await res.json()) as { isPaid?: boolean; received?: number };
    if (typeof data.isPaid === 'boolean') return data.isPaid;
    if (typeof data.received === 'number') return data.received > 0;
    return false;
  }
}
