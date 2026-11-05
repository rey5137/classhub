export class IdentityError extends Error {
  constructor(message = 'no verified identity') {
    super(message);
    this.name = 'IdentityError';
  }
}

export interface IdentityProvider {
  /** Throws IdentityError when no verified identity is present (INV-1). */
  requireIdentity(request: Request): Promise<{ email: string; subject: string }>;
}
