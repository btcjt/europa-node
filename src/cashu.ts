import { CashuMint, CashuWallet, getDecodedToken } from '@cashu/cashu-ts';

export interface CashuSwapResult {
  amountReceived: number;
  proofIds: string[];
}

export class CashuAdapter {
  private readonly wallet: CashuWallet;
  private readonly p2pkPriv: string | undefined;

  constructor(mintUrl: string, p2pkPrivkeyHex?: string) {
    const mint = new CashuMint(mintUrl);
    this.wallet = new CashuWallet(mint);
    this.p2pkPriv = p2pkPrivkeyHex;
  }

  /**
   * Parse-and-swap an X-Cashu token. Returns the total amount the
   * operator collected, or throws with a stable reason string the
   * caller maps to an HTTP error response.
   */
  async receive(rawToken: string, expectedMint: string): Promise<CashuSwapResult> {
    let decoded;
    try {
      decoded = getDecodedToken(rawToken);
    } catch {
      throw new Error('invalid-token');
    }
    if (decoded.mint !== expectedMint) {
      throw new Error('wrong-mint');
    }
    if (!decoded.proofs || decoded.proofs.length === 0) {
      throw new Error('invalid-token');
    }

    const options = this.p2pkPriv ? { privkey: this.p2pkPriv } : undefined;
    const proofs = await this.wallet.receive(rawToken, options).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (/already.*spent|double.*spent|TOKEN_ALREADY_SPENT/i.test(message)) {
        throw new Error('double-spent');
      }
      throw new Error('invalid-token');
    });

    const amountReceived = proofs.reduce(
      (sum, p) => sum + (typeof p.amount === 'number' ? p.amount : 0),
      0,
    );
    const ids = proofs.map((p) => (typeof p.id === 'string' ? p.id : '')).filter(Boolean);
    return { amountReceived, proofIds: ids };
  }
}
