import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/server/ids';
import type { Database } from '../../src/lib/server/ports/database';

export interface DatabaseHarness {
  database: Database;
  dispose(): Promise<void>;
}

export type DatabaseFactory = () => Promise<DatabaseHarness>;

async function withDatabase(
  create: DatabaseFactory,
  run: (database: Database) => Promise<void>,
): Promise<void> {
  const harness = await create();
  try {
    await run(harness.database);
  } finally {
    await harness.dispose();
  }
}

function userRow(email = `${uuidv7()}@example.com`) {
  return {
    id: uuidv7(),
    authEmail: email,
    displayName: 'Test Member',
    displayNameNorm: 'test member',
  };
}

function mediaRow(ownerId: string) {
  return {
    id: uuidv7(),
    ownerId,
    mediaType: 'photo' as const,
    objectKey: `media/v1/${uuidv7()}/image.webp`,
    thumbKey: `media/v1/${uuidv7()}/thumb.webp`,
    mimeType: 'image/webp',
    width: 100,
    height: 100,
    sizeBytes: 1000,
    thumbSizeBytes: 200,
    sha256: uuidv7(),
    thumbSha256: uuidv7(),
  };
}

function reservationRow(ownerId: string) {
  const id = uuidv7();
  return {
    id,
    ownerId,
    mediaId: uuidv7(),
    purpose: 'photo' as const,
    reservedBytes: 1200,
    imageBytes: 1000,
    thumbBytes: 200,
    sha256: uuidv7(),
    thumbSha256: uuidv7(),
    mimeType: 'image/webp',
    objectKey: `staging/v1/${id}/image.webp`,
    thumbKey: `staging/v1/${id}/thumb.webp`,
    expiresAt: Date.now() + 15 * 60 * 1000,
  };
}

export function databaseContract(label: string, create: DatabaseFactory): void {
  describe(`AC-PLAT-03 Database contract (${label})`, () => {
    it('AC-DB-02 enforces the users.auth_email unique constraint', async () => {
      await withDatabase(create, async (database) => {
        const email = `${uuidv7()}@example.com`;
        await database.db.insert(schema.users).values(userRow(email));
        await expect(
          async () => await database.db.insert(schema.users).values(userRow(email)),
        ).rejects.toThrow();
      });
    });

    it('AC-DB-02 enforces the invites.email unique constraint', async () => {
      await withDatabase(create, async (database) => {
        const admin = userRow();
        await database.db.insert(schema.users).values(admin);
        const email = `${uuidv7()}@example.com`;
        const invite = {
          id: uuidv7(),
          email,
          invitedBy: admin.id,
        };
        await database.db.insert(schema.invites).values(invite);
        await expect(
          async () => await database.db.insert(schema.invites).values({ ...invite, id: uuidv7() }),
        ).rejects.toThrow();
      });
    });

    it('AC-DB-02 enforces the info_pages.slug unique constraint', async () => {
      await withDatabase(create, async (database) => {
        const admin = userRow();
        await database.db.insert(schema.users).values(admin);
        const slug = `page-${uuidv7()}`;
        const page = {
          id: uuidv7(),
          slug,
          title: 'Title',
          bodyMd: 'Body',
          updatedBy: admin.id,
        };
        await database.db.insert(schema.infoPages).values(page);
        await expect(
          async () => await database.db.insert(schema.infoPages).values({ ...page, id: uuidv7() }),
        ).rejects.toThrow();
      });
    });

    it('AC-DB-02 enforces the (sender_id, client_nonce) unique constraint', async () => {
      await withDatabase(create, async (database) => {
        const sender = userRow();
        await database.db.insert(schema.users).values(sender);
        const nonce = uuidv7();
        const message = {
          id: uuidv7(),
          roomId: 'general',
          senderId: sender.id,
          clientNonce: nonce,
          body: 'hello',
        };
        await database.db.insert(schema.chatMessages).values(message);
        await expect(
          async () =>
            await database.db.insert(schema.chatMessages).values({ ...message, id: uuidv7() }),
        ).rejects.toThrow();
      });
    });

    it('AC-DB-02 enforces the chat_archives.file_name unique constraint', async () => {
      await withDatabase(create, async (database) => {
        const fileName = `chat/${uuidv7()}_${uuidv7()}.ndjson.age`;
        const archive = {
          id: uuidv7(),
          fileName,
          fromId: uuidv7(),
          toId: uuidv7(),
          rangeStart: 1,
          rangeEnd: 2,
          recordCount: 2,
          sha256: uuidv7(),
          exportedAt: Date.now(),
        };
        await database.db.insert(schema.chatArchives).values(archive);
        await expect(
          async () =>
            await database.db.insert(schema.chatArchives).values({ ...archive, id: uuidv7() }),
        ).rejects.toThrow();
      });
    });

    it('AC-DB-02 rejects a media row whose media_type is not photo, avatar or site', async () => {
      await withDatabase(create, async (database) => {
        const owner = userRow();
        await database.db.insert(schema.users).values(owner);
        for (const mediaType of ['photo', 'site'] as const) {
          await database.db
            .insert(schema.media)
            .values({ ...mediaRow(owner.id), id: uuidv7(), mediaType });
        }
        await expect(
          async () =>
            await database.db
              .insert(schema.media)
              .values({ ...mediaRow(owner.id), id: uuidv7(), mediaType: 'video' as 'photo' }),
        ).rejects.toThrow();
      });
    });

    it('R-MEM-21 rejects an upload reservation state outside open, completed or released', async () => {
      await withDatabase(create, async (database) => {
        const owner = userRow();
        await database.db.insert(schema.users).values(owner);
        await expect(
          async () =>
            await database.db
              .insert(schema.uploadReservations)
              .values({ ...reservationRow(owner.id), state: 'uploaded' as 'open' }),
        ).rejects.toThrow();
      });
    });

    it('R-MEM-09 does not require a media row when a reservation is created', async () => {
      await withDatabase(create, async (database) => {
        const owner = userRow();
        await database.db.insert(schema.users).values(owner);
        const reservation = reservationRow(owner.id);
        await expect(
          database.db.insert(schema.uploadReservations).values(reservation),
        ).resolves.toBeDefined();
      });
    });

    it('AC-DB-02 rejects a content row whose author does not exist', async () => {
      await withDatabase(create, async (database) => {
        await expect(
          async () =>
            await database.db
              .insert(schema.posts)
              .values({ id: uuidv7(), authorId: uuidv7(), title: 't', bodyMd: 'b' }),
        ).rejects.toThrow();
      });
    });

    it('AC-DB-02 rejects deleting a user a post still references', async () => {
      await withDatabase(create, async (database) => {
        const author = userRow();
        await database.db.insert(schema.users).values(author);
        await database.db
          .insert(schema.posts)
          .values({ id: uuidv7(), authorId: author.id, title: 't', bodyMd: 'b' });
        await expect(
          async () => await database.db.delete(schema.users).where(eq(schema.users.id, author.id)),
        ).rejects.toThrow();
      });
    });

    it('R-DB-04 cascades comments when their post is deleted', async () => {
      await withDatabase(create, async (database) => {
        const author = userRow();
        await database.db.insert(schema.users).values(author);
        const postId = uuidv7();
        await database.db
          .insert(schema.posts)
          .values({ id: postId, authorId: author.id, title: 't', bodyMd: 'b' });
        await database.db
          .insert(schema.comments)
          .values({ id: uuidv7(), postId, authorId: author.id, bodyMd: 'c' });

        await database.db.delete(schema.posts).where(eq(schema.posts.id, postId));

        const remaining = await database.db
          .select({ id: schema.comments.id })
          .from(schema.comments)
          .where(eq(schema.comments.postId, postId));
        expect(remaining).toEqual([]);
      });
    });

    it('R-DB-08 rolls back a batch when one statement fails', async () => {
      await withDatabase(create, async (database) => {
        const email = `${uuidv7()}@example.com`;
        const first = database.db.insert(schema.users).values(userRow(email));
        const failing = database.db.insert(schema.users).values(userRow(email));

        await expect(database.batch([first, failing])).rejects.toThrow();

        const rows = await database.db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.authEmail, email));
        expect(rows).toEqual([]);
      });
    });

    it('R-DB-08 commits a successful batch and reports each change count', async () => {
      await withDatabase(create, async (database) => {
        const email = `${uuidv7()}@example.com`;
        const ids = [uuidv7(), uuidv7()];
        const results = await database.batch([
          database.db.insert(schema.users).values({ ...userRow(email), id: ids[0]! }),
          database.db.insert(schema.users).values({ ...userRow(`${email}.2`), id: ids[1]! }),
        ]);

        expect(results.map((result) => result.changes)).toEqual([1, 1]);
        const rows = await database.db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.authEmail, email));
        expect(rows.map((row) => row.id)).toEqual([ids[0]!]);
      });
    });

    it('R-DB-08 commits two concurrent batches without interleaving', async () => {
      await withDatabase(create, async (database) => {
        const emailA = `${uuidv7()}@example.com`;
        const emailB = `${uuidv7()}@example.com`;

        const [first, second] = await Promise.all([
          database.batch([database.db.insert(schema.users).values(userRow(emailA))]),
          database.batch([database.db.insert(schema.users).values(userRow(emailB))]),
        ]);

        expect(first[0]!.changes).toBe(1);
        expect(second[0]!.changes).toBe(1);

        const rows = await database.db
          .select({ email: schema.users.authEmail })
          .from(schema.users)
          .where(inArray(schema.users.authEmail, [emailA, emailB]));
        expect(rows.map((row) => row.email).sort()).toEqual([emailA, emailB].sort());
      });
    });

    it('R-DB-08 rolls back only the failing concurrent batch', async () => {
      await withDatabase(create, async (database) => {
        const goodEmail = `${uuidv7()}@example.com`;
        const badEmail = `${uuidv7()}@example.com`;

        const [good, bad] = await Promise.allSettled([
          database.batch([database.db.insert(schema.users).values(userRow(goodEmail))]),
          database.batch([
            database.db.insert(schema.users).values(userRow(badEmail)),
            database.db.insert(schema.users).values(userRow(badEmail)),
          ]),
        ]);

        expect(good.status).toBe('fulfilled');
        expect(bad.status).toBe('rejected');

        const rows = await database.db
          .select({ email: schema.users.authEmail })
          .from(schema.users)
          .where(inArray(schema.users.authEmail, [goodEmail, badEmail]));
        expect(rows.map((row) => row.email)).toEqual([goodEmail]);
      });
    });
  });
}
