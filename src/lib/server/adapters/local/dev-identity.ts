import { IdentityError, type IdentityProvider } from '../../ports/identity';

// R-AUTH-13: this provider exists only in the local/dev build and only answers
// for a localhost request. Production code never imports it (bundle check).
export class DevIdentityProvider implements IdentityProvider {
  constructor(
    private readonly email: string | undefined,
    private readonly devBuild: boolean = import.meta.env.DEV,
  ) {}

  async requireIdentity(request: Request): Promise<{ email: string; subject: string }> {
    if (!this.devBuild) throw new IdentityError('dev identity is unavailable in this build');

    const hostname = new URL(request.url).hostname;
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
      throw new IdentityError('dev identity is only available on localhost');
    }
    // A proxy header means the request may have been forwarded from elsewhere.
    if (
      request.headers.has('x-forwarded-for') ||
      request.headers.has('forwarded') ||
      request.headers.has('x-real-ip')
    ) {
      throw new IdentityError('dev identity refuses proxied requests');
    }
    if (!this.email) throw new IdentityError('CLASSHUB_DEV_MEMBER is not set');

    return { email: this.email, subject: `dev:${this.email}` };
  }
}

export function createDevIdentity(email: string | undefined): IdentityProvider {
  return new DevIdentityProvider(email);
}
