import { IdentityError, type IdentityProvider } from '../../ports/identity';

// R-AUTH-13: this provider exists only in the local/dev build and only answers
// for a request whose peer address and Host are both loopback. Production code never imports it (bundle check).
/** @param address the socket peer address, e.g. `127.0.0.1`, `::1`, `::ffff:127.0.0.1` */
function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const bare = address.replace(/^::ffff:/i, '');
  return bare === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

export class DevIdentityProvider implements IdentityProvider {
  constructor(
    private readonly email: string | undefined,
    private readonly devBuild: boolean = import.meta.env.DEV,
  ) {}

  async requireIdentity(
    request: Request,
    peer: { clientAddress: string },
  ): Promise<{ email: string; subject: string }> {
    if (!this.devBuild) throw new IdentityError('dev identity is unavailable in this build');

    // Both checks are required: the peer alone admits a DNS-rebinding page
    // (Host: evil.example resolving to 127.0.0.1) from the developer's own browser.
    const hostname = new URL(request.url).hostname;
    if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '[::1]') {
      throw new IdentityError('dev identity is only available on localhost');
    }
    if (!isLoopbackAddress(peer?.clientAddress)) {
      throw new IdentityError('dev identity is only available to a loopback peer');
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
