/**
 * R-AUTH-33: Cloudflare Access's External Evaluation rule. At login Access posts a token it signed
 * (the user's identity and a nonce) and accepts the answer only when it is signed by a key from
 * this site's keys URL and carries the same nonce.
 */
export interface AccessEvaluator {
  /** The public half of the answer key, as the JWKS Access fetches from the keys URL. */
  keys(): Promise<{ keys: Record<string, unknown>[] }>;
  /**
   * Verifies Access's token and returns the signed answer, `success` from `allow(email)`;
   * null when the token is not a valid Access evaluation request.
   */
  evaluate(token: string, allow: (email: string) => Promise<boolean>): Promise<string | null>;
}
