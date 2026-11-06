import { describe, expect, it } from 'vitest';
import { CONTEXT_TTL_MS, signContext, verifyContext } from '../../src/lib/server/internal-context';

const KEY = 'test-internal-context-key';
const NOW = 1_800_000_000_000;
const member = {
  memberId: 'member-1',
  role: 'member' as const,
  displayName: 'Anh',
  authUntil: NOW + 3_600_000,
};

function flip(text: string, at: number): string {
  const char = text[at] === 'A' ? 'B' : 'A';
  return text.slice(0, at) + char + text.slice(at + 1);
}

describe('signed member context (R-CHAT-04)', () => {
  it('R-CHAT-04 round-trips a context and sets exp to now + 30 s', async () => {
    const token = await signContext(member, KEY, NOW);
    expect(await verifyContext(token, KEY, NOW)).toEqual({ ...member, exp: NOW + CONTEXT_TTL_MS });
    expect(CONTEXT_TTL_MS).toBe(30_000);
  });

  it('R-CHAT-04 refuses an expired token, at and after exp', async () => {
    const token = await signContext(member, KEY, NOW);
    expect(await verifyContext(token, KEY, NOW + CONTEXT_TTL_MS - 1)).not.toBeNull();
    expect(await verifyContext(token, KEY, NOW + CONTEXT_TTL_MS)).toBeNull();
    expect(await verifyContext(token, KEY, NOW + 60_000)).toBeNull();
  });

  it('R-CHAT-04 refuses a token signed under another key, and any key when none is set', async () => {
    const token = await signContext(member, KEY, NOW);
    expect(await verifyContext(token, 'another-key', NOW)).toBeNull();
    expect(await verifyContext(token, undefined, NOW)).toBeNull();
    expect(await verifyContext(token, '', NOW)).toBeNull();
    await expect(signContext(member, '', NOW)).rejects.toThrow('INTERNAL_CONTEXT_KEY');
  });

  it('R-CHAT-04 refuses a tampered payload or signature', async () => {
    const token = await signContext(member, KEY, NOW);
    const [body, signature] = token.split('.') as [string, string];
    expect(await verifyContext(`${flip(body, 5)}.${signature}`, KEY, NOW)).toBeNull();
    expect(await verifyContext(`${body}.${flip(signature, 5)}`, KEY, NOW)).toBeNull();
    // A payload claiming admin, re-encoded without the key, does not verify.
    const forged = btoa(JSON.stringify({ ...member, role: 'admin', exp: NOW + 1000 }))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
    expect(await verifyContext(`${forged}.${signature}`, KEY, NOW)).toBeNull();
  });

  it.each([null, undefined, '', 'one-part', 'a.b.c', '.', 'body.', '.sig', 'b@d.s!g', '{}.{}'])(
    'R-CHAT-04 refuses the malformed token %j',
    async (token) => {
      expect(await verifyContext(token, KEY, NOW)).toBeNull();
    },
  );

  it('R-CHAT-04 refuses a correctly signed body that is not a member context', async () => {
    const encode = (value: unknown) =>
      btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(KEY),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signed = async (body: string) => {
      const signature = new Uint8Array(
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
      );
      return `${body}.${btoa(String.fromCharCode(...signature))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '')}`;
    };
    for (const value of [
      { ...member, role: 'owner', exp: NOW + 1000 },
      { ...member, exp: NOW + 1000, extra: true },
      { memberId: 'member-1', exp: NOW + 1000 },
      'not an object',
    ]) {
      expect(await verifyContext(await signed(encode(value)), KEY, NOW)).toBeNull();
    }
    // The same helper does produce a valid token for a real context.
    expect(
      await verifyContext(await signed(encode({ ...member, exp: NOW + 1000 })), KEY, NOW),
    ).not.toBeNull();
  });
});
