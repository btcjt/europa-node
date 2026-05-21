import { CashuMint, CashuWallet, getDecodedToken } from '@cashu/cashu-ts';

export interface CashuSwapResult {
  amountReceived: number;
  proofIds: string[];
  /** Which of the operator's configured mints the token came from. */
  mint: string;
}

/**
 * Parse-and-swap X-Cashu tokens across one or more mints the operator
 * accepts.
 *
 * Multi-mint model: the operator holds a single P2PK keypair — NUT-11
 * locks are mint-agnostic, so the same `p2pk_privkey_hex` unlocks
 * tokens issued by any mint. Each accepted mint just needs its own
 * `CashuWallet` (a thin client bound to that mint's URL) to run the
 * swap. The adapter keeps one wallet per mint and dispatches on the
 * decoded token's `mint` field.
 */
export class CashuAdapter {
  /** mint URL → wallet bound to that mint. */
  private readonly wallets = new Map<string, CashuWallet>();
  private readonly p2pkPriv: string | undefined;

  constructor(mintUrls: string[], p2pkPrivkeyHex?: string) {
    for (const url of mintUrls) {
      // Dedupe — an operator listing the same mint on two price tiers
      // would otherwise build two wallets for it.
      if (!this.wallets.has(url)) {
        this.wallets.set(url, new CashuWallet(new CashuMint(url)));
      }
    }
    this.p2pkPriv = p2pkPrivkeyHex;
  }

  /** The set of mint URLs this adapter will accept tokens from. */
  get mints(): string[] {
    return [...this.wallets.keys()];
  }

  /**
   * Parse-and-swap an X-Cashu token. The token's own mint must be one
   * of the operator's configured mints; the matching wallet runs the
   * swap. Returns the total amount collected (+ which mint), or throws
   * with a stable reason string the caller maps to an HTTP error.
   */
  async receive(rawToken: string): Promise<CashuSwapResult> {
    let decoded;
    try {
      decoded = getDecodedToken(rawToken);
    } catch {
      throw new Error('invalid-token');
    }
    if (!decoded.proofs || decoded.proofs.length === 0) {
      throw new Error('invalid-token');
    }
    const wallet = decoded.mint ? this.wallets.get(decoded.mint) : undefined;
    if (!wallet) {
      // Token is from a mint this operator doesn't accept. `wrong-mint`
      // is the spec reason code; the buyer-side error map explains it
      // and lists which mints the operator does take.
      throw new Error('wrong-mint');
    }

    const options = this.p2pkPriv ? { privkey: this.p2pkPriv } : undefined;
    const proofs = await wallet.receive(rawToken, options).catch((err: unknown) => {
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
    return { amountReceived, proofIds: ids, mint: decoded.mint };
  }
}
