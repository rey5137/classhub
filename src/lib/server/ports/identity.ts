export class IdentityError extends Error {
  constructor(message = 'no verified identity') {
    super(message);
    this.name = 'IdentityError';
  }
}

export interface IdentityProvider {
  /**
   * Throws IdentityError when no verified identity is present (INV-1). `peer` is the
   * connection's address from `event.getClientAddress()`, never a request header.
   */
  requireIdentity(
    request: Request,
    peer: { clientAddress: string },
  ): Promise<{ email: string; subject: string }>;
}
