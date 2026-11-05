import { describe, expect, it } from 'vitest';
import { DevIdentityProvider } from '../../src/lib/server/adapters/local/dev-identity';
import { IdentityError } from '../../src/lib/server/ports/identity';

const member = 'admin@example.com';

describe('DevIdentityProvider', () => {
  it('R-AUTH-13 refuses a non-local host', async () => {
    const provider = new DevIdentityProvider(member, true);
    await expect(
      provider.requireIdentity(new Request('https://classhub.example.com/')),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it('R-AUTH-13 refuses a non-dev build', async () => {
    const provider = new DevIdentityProvider(member, false);
    await expect(
      provider.requireIdentity(new Request('http://localhost:5173/')),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it.each(['x-forwarded-for', 'forwarded', 'x-real-ip'])(
    'R-AUTH-13 refuses a localhost request carrying %s',
    async (header) => {
      const provider = new DevIdentityProvider(member, true);
      await expect(
        provider.requireIdentity(
          new Request('http://127.0.0.1:5173/', { headers: { [header]: '203.0.113.5' } }),
        ),
      ).rejects.toBeInstanceOf(IdentityError);
    },
  );

  it('R-AUTH-13 refuses when no fixture member is configured', async () => {
    const provider = new DevIdentityProvider(undefined, true);
    await expect(
      provider.requireIdentity(new Request('http://localhost:5173/')),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it('R-AUTH-13 returns the configured member on localhost in a dev build', async () => {
    const provider = new DevIdentityProvider(member, true);
    await expect(provider.requireIdentity(new Request('http://127.0.0.1:5173/'))).resolves.toEqual({
      email: member,
      subject: `dev:${member}`,
    });
  });
});
