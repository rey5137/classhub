import { describe, expect, it } from 'vitest';
import { ACTIONS, can, type Action } from '../../src/lib/server/auth/permissions';

const member = { id: 'm1', role: 'member' as const, displayName: 'Member' };
const admin = { id: 'a1', role: 'admin' as const, displayName: 'Admin' };
const others = { ownerId: 'someone-else' };

// §3.3, one line per row: what a member and an admin may do with someone else's resource.
const MATRIX: [Action, unknown, boolean, boolean][] = [
  ['content.read', undefined, true, true],
  ['profile.edit', undefined, true, true],
  ['content.create', undefined, true, true],
  ['content.edit', others, false, true],
  ['content.delete', others, false, true],
  ['thread.moderate', undefined, false, true],
  ['album.create', undefined, true, true],
  ['album.edit', others, false, true],
  ['members.manage', undefined, false, true],
  ['settings.edit', undefined, false, true],
  ['usage.view', undefined, false, true],
  ['data.exportOwn', undefined, true, true],
  ['data.exportAll', undefined, false, false],
];

type Loose = (m: typeof member | typeof admin, action: Action, resource?: unknown) => boolean;
const check = can as unknown as Loose;

describe('permissions (R-NAV-05)', () => {
  it('AC-NAV-02 answers every §3.3 row per role', () => {
    for (const [action, resource, forMember, forAdmin] of MATRIX) {
      expect(check(member, action, resource), `member ${action}`).toBe(forMember);
      expect(check(admin, action, resource), `admin ${action}`).toBe(forAdmin);
    }
  });

  it('AC-NAV-02 covers every action it defines', () => {
    const tested = new Set([...MATRIX.map(([action]) => action), 'contact.view']);
    expect(ACTIONS.filter((action) => !tested.has(action))).toEqual([]);
  });

  it('lets an owner edit and delete their own content and albums', () => {
    const own = { ownerId: member.id };
    expect(can(member, 'content.edit', own)).toBe(true);
    expect(can(member, 'content.delete', own)).toBe(true);
    expect(can(member, 'album.edit', own)).toBe(true);
  });

  it('AC-NAV-02 shows a contact field to its chosen audience only (§4)', () => {
    const field = (visibility: 'private' | 'admins' | 'members') => ({ ownerId: 'x', visibility });
    expect(can(member, 'contact.view', field('members'))).toBe(true);
    expect(can(member, 'contact.view', field('admins'))).toBe(false);
    expect(can(member, 'contact.view', field('private'))).toBe(false);
    expect(can(admin, 'contact.view', field('admins'))).toBe(true);
    expect(can(admin, 'contact.view', field('private'))).toBe(false);
    expect(can(member, 'contact.view', { ownerId: member.id, visibility: 'private' })).toBe(true);
  });
});
