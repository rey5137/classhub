import { describe, expect, it } from 'vitest';
import {
  PROFILE_FIELDS,
  type ProfileField,
  type PublicProfile,
  type Visibility,
} from '../../src/lib/contracts/profile';
import { projectProfile, type ProfileOwner } from '../../src/lib/server/services/projection';

const OWNER_ID = '01900000-0000-7000-8000-00000000f001';
const viewers = {
  owner: { id: OWNER_ID, role: 'member' as const, displayName: 'Mai' },
  member: { id: '01900000-0000-7000-8000-00000000f002', role: 'member' as const, displayName: 'B' },
  admin: { id: '01900000-0000-7000-8000-00000000f003', role: 'admin' as const, displayName: 'C' },
};

const outputKey: Record<ProfileField, keyof PublicProfile> = {
  preferred_name: 'preferredName',
  contact_email: 'contactEmail',
  phone: 'phone',
  messaging_url: 'messagingUrl',
  city: 'city',
  bio: 'bio',
  avatar_media_id: 'avatarMediaId',
};

function owner(
  visibility: Record<string, unknown>,
  extra: Partial<ProfileOwner> = {},
): ProfileOwner {
  return {
    id: OWNER_ID,
    displayName: 'Nguyễn Thị Mai',
    status: 'active',
    preferredName: 'Mai',
    avatarMediaId: '01900000-0000-7000-8000-00000000a001',
    deletionRequestedAt: null,
    contacts: {
      contactEmail: 'mai.contact@example.test',
      phone: '+84912345678',
      messagingUrl: 'https://zalo.me/0912345678',
      city: 'Huế',
      bio: 'Hello',
      visibilityJson: JSON.stringify(visibility),
    },
    ...extra,
  };
}

const allPrivate = Object.fromEntries(PROFILE_FIELDS.map((field) => [field, 'private']));
const allMembers = Object.fromEntries(PROFILE_FIELDS.map((field) => [field, 'members']));
const allowed: Record<keyof typeof viewers, (visibility: Visibility) => boolean> = {
  owner: () => true,
  member: (visibility) => visibility === 'members',
  admin: (visibility) => visibility !== 'private',
};

describe('projectProfile (R-PROF-03, 04)', () => {
  const cases = PROFILE_FIELDS.flatMap((field) =>
    (['private', 'admins', 'members'] as const).flatMap((visibility) =>
      (Object.keys(viewers) as (keyof typeof viewers)[]).map(
        (viewer) => [field, visibility, viewer] as const,
      ),
    ),
  );

  it.each(cases)('AC-PROF-01 %s at %s seen by the %s', (field, visibility, viewer) => {
    const projected = projectProfile(
      viewers[viewer],
      owner({ ...allPrivate, [field]: visibility }),
    );
    const others = PROFILE_FIELDS.filter((other) => other !== field).map((f) => outputKey[f]);
    expect(outputKey[field] in projected).toBe(allowed[viewer](visibility));
    // Every other field is private here, so only the owner sees it.
    for (const key of others) expect(key in projected).toBe(viewer === 'owner');
    expect(projected.id).toBe(OWNER_ID);
    expect(projected.displayName).toBe('Nguyễn Thị Mai');
  });

  it('AC-PROF-01 builds links from the stored values and never carries a login email', () => {
    const projected = projectProfile(viewers.member, owner(allMembers));
    expect(projected.phone).toEqual({ text: '+84912345678', href: 'tel:+84912345678' });
    expect(projected.contactEmail).toEqual({
      text: 'mai.contact@example.test',
      href: 'mailto:mai.contact@example.test',
    });
    expect(Object.keys(projected)).not.toContain('authEmail');
  });

  it('R-PROF-03 an unknown, invalid or unreadable visibility reads as private', () => {
    for (const json of ['{"phone":"everyone"}', 'not json', '[]', 'null']) {
      const base = owner({});
      const projected = projectProfile(viewers.admin, {
        ...base,
        contacts: { ...base.contacts!, visibilityJson: json },
      });
      expect(projected).toEqual({ id: OWNER_ID, displayName: 'Nguyễn Thị Mai' });
    }
  });

  it('AC-PROF-03 without a saved profile the R-PROF-02 defaults apply', () => {
    const projected = projectProfile(viewers.member, owner({}, { contacts: null }));
    expect(projected).toEqual({
      id: OWNER_ID,
      displayName: 'Nguyễn Thị Mai',
      preferredName: 'Mai',
      avatarMediaId: '01900000-0000-7000-8000-00000000a001',
    });
  });

  it('R-PROF-06 a stored link off the allow-list is never emitted, even to its owner', () => {
    const base = owner(allMembers);
    for (const messagingUrl of ['javascript:alert(1)', 'https://evil.example/x']) {
      const projected = projectProfile(viewers.owner, {
        ...base,
        contacts: { ...base.contacts!, messagingUrl },
      });
      expect('messagingUrl' in projected).toBe(false);
    }
  });
});

describe('projectProfile for non-active owners (R-PROF-13)', () => {
  it.each(['suspended', 'invited'] as const)(
    'AC-PROF-08 a %s owner shows only the display name to members and admins',
    (status) => {
      for (const viewer of [viewers.member, viewers.admin]) {
        expect(projectProfile(viewer, owner(allMembers, { status }))).toEqual({
          id: OWNER_ID,
          displayName: 'Nguyễn Thị Mai',
        });
      }
    },
  );

  it('AC-PROF-08 a pending deletion request hides the contact fields from all but the owner', () => {
    const pending = owner(allMembers, { deletionRequestedAt: 1 });
    for (const viewer of [viewers.member, viewers.admin]) {
      // Bio, preferred name and avatar still follow their visibility.
      expect(projectProfile(viewer, pending)).toEqual({
        id: OWNER_ID,
        displayName: 'Nguyễn Thị Mai',
        preferredName: 'Mai',
        avatarMediaId: '01900000-0000-7000-8000-00000000a001',
        bio: 'Hello',
      });
    }
    expect(projectProfile(viewers.owner, pending).phone?.text).toBe('+84912345678');
  });
});
