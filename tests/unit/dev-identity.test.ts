import { describe, expect, it } from 'vitest';
import { DevIdentityProvider } from '../../src/lib/server/adapters/local/dev-identity';
import { IdentityError } from '../../src/lib/server/ports/identity';

const member = 'admin@example.com';
const loopback = { clientAddress: '127.0.0.1' };

describe('DevIdentityProvider', () => {
  it('R-AUTH-13 refuses a non-local host', async () => {
    const provider = new DevIdentityProvider(member, true);
    await expect(
      provider.requireIdentity(new Request('https://classhub.example.com/'), loopback),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it('R-AUTH-13 refuses a DNS-rebinding Host from a loopback peer', async () => {
    const provider = new DevIdentityProvider(member, true);
    await expect(
      provider.requireIdentity(new Request('http://evil.example:5173/'), loopback),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it.each(['192.168.1.20', '203.0.113.5', '2001:db8::1', '::ffff:192.168.1.20', '', undefined])(
    'R-AUTH-13 refuses Host: localhost from the non-loopback peer %s',
    async (clientAddress) => {
      const provider = new DevIdentityProvider(member, true);
      await expect(
        provider.requireIdentity(new Request('http://localhost:5173/'), {
          clientAddress: clientAddress as string,
        }),
      ).rejects.toBeInstanceOf(IdentityError);
    },
  );

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])(
    'R-AUTH-13 accepts the loopback peer %s',
    async (clientAddress) => {
      const provider = new DevIdentityProvider(member, true);
      await expect(
        provider.requireIdentity(new Request('http://localhost:5173/'), { clientAddress }),
      ).resolves.toEqual({ email: member, subject: `dev:${member}` });
    },
  );

  it.each(['http://[::1]:5173/', 'http://[::1]/'])(
    'R-AUTH-13 accepts Host %s from a loopback peer',
    async (url) => {
      const provider = new DevIdentityProvider(member, true);
      await expect(
        provider.requireIdentity(new Request(url), { clientAddress: '::1' }),
      ).resolves.toEqual({ email: member, subject: `dev:${member}` });
    },
  );

  it('R-AUTH-13 refuses a non-dev build', async () => {
    const provider = new DevIdentityProvider(member, false);
    await expect(
      provider.requireIdentity(new Request('http://localhost:5173/'), loopback),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it.each(['x-forwarded-for', 'forwarded', 'x-real-ip'])(
    'R-AUTH-13 refuses a localhost request carrying %s',
    async (header) => {
      const provider = new DevIdentityProvider(member, true);
      await expect(
        provider.requireIdentity(
          new Request('http://127.0.0.1:5173/', { headers: { [header]: '203.0.113.5' } }),
          loopback,
        ),
      ).rejects.toBeInstanceOf(IdentityError);
    },
  );

  it('R-AUTH-13 refuses when no fixture member is configured', async () => {
    const provider = new DevIdentityProvider(undefined, true);
    await expect(
      provider.requireIdentity(new Request('http://localhost:5173/'), loopback),
    ).rejects.toBeInstanceOf(IdentityError);
  });
});
