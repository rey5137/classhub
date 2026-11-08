// AC-BUD-02: the row-read budget for every GET route in the manifest, with the demo
// seed. The integration test measures each one on real D1; `row-budget-manifest.test.ts`
// fails when a manifest GET route is in neither table.

export interface RowBudget {
  /** The manifest key this entry covers, e.g. `GET /api/v1/members/sample-id`. */
  route: string;
  /** The request path, with demo-record tokens the test fills in. */
  path: string;
  /** Admin routes need the admin's identity; everything else runs as a member. */
  as: 'member' | 'admin';
  /** `meta.rows_read` for the whole request, the pipeline's own reads included. */
  budget: number;
  /** Why the number is what it is (the page size a list budget derives from). */
  basis: string;
}

/** Single-record routes (AC-BUD-02): the pipeline's reads and one record, ≤ 30 rows. */
const SINGLE = 30;
/** Pending join-request queue cap (`siteConfig.join.maxPending`, R-AUTH-29). */
const JOIN_QUEUE = 25;
/** Album list page size (`ALBUM_CHOICES`, R-DB-07, R-MEM-14). */
const ALBUMS_PAGE = 50;
/** Info-page list page size (`INFO_PAGES_LIMIT`, R-DB-07, R-BRD-02). */
const INFO_PAGE = 50;
/** Invite list page size (`INVITES_PAGE`, R-DB-07, R-AUTH-10). */
const INVITES_PAGE = 50;
/** Zero Trust seat cap counted alongside the invite page (`SEAT_LIMIT`, R-AUTH-19). */
const SEAT_LIMIT = 50;
/** Gallery year-chip cap (`YEAR_CHIPS`, R-MEM-14). */
const YEAR_CHIPS = 8;
/** Home's newest photos, pinned threads and active unpinned threads (R-BRD-01). */
const HOME_PHOTOS = 12;
const HOME_PINNED_THREADS = 20;
const HOME_THREADS = 5;

const listBudget = (page: number) => 2 * page + 10;

/** AC-BUD-02: every single-list route is held to `2 × page size + 10`. */
function paged(page: number): Pick<RowBudget, 'budget' | 'basis'> {
  return {
    budget: listBudget(page),
    basis: `2 × ${page}-row page + 10 (AC-BUD-02)`,
  };
}

export const budgets: RowBudget[] = [
  {
    route: 'GET /',
    path: '/',
    as: 'member',
    budget:
      listBudget(INFO_PAGE) +
      listBudget(HOME_PHOTOS) +
      listBudget(HOME_PINNED_THREADS) +
      listBudget(HOME_THREADS) +
      SINGLE,
    basis:
      '(2 × 50 + 10) pinned info + (2 × 12 + 10) newest photos + (2 × 20 + 10) pinned threads + (2 × 5 + 10) active threads + 30 single-record reads (R-BRD-01, AC-BUD-02)',
  },
  {
    route: 'GET /admin',
    path: '/admin',
    as: 'admin',
    budget:
      listBudget(INVITES_PAGE) +
      listBudget(SEAT_LIMIT) +
      listBudget(JOIN_QUEUE) +
      listBudget(INFO_PAGE) +
      SINGLE,
    basis:
      '(2 × 50 + 10) invites page + (2 × 50 + 10) seat count + (2 × 25 + 10) join-request queue + (2 × 50 + 10) info editor page + 30 single-record reads; admin-only full-index retention/photo counts are separate (R-BUD-01, AC-BUD-02)',
  },
  {
    route: 'GET /admin/setup',
    path: '/admin/setup',
    as: 'admin',
    budget: SINGLE,
    basis: 'single record (admin count)',
  },
  {
    route: 'GET /api/v1/admin/invites',
    path: '/api/v1/admin/invites',
    as: 'admin',
    budget: listBudget(INVITES_PAGE) + listBudget(SEAT_LIMIT),
    basis:
      '(2 × 50 + 10) invites page with user join + (2 × 50 + 10) Zero Trust seat count (R-AUTH-10, R-AUTH-19, AC-BUD-02)',
  },
  {
    route: 'GET /api/v1/admin/join-requests',
    path: '/api/v1/admin/join-requests',
    as: 'admin',
    ...paged(JOIN_QUEUE),
  },
  {
    route: 'GET /api/v1/admin/settings',
    path: '/api/v1/admin/settings',
    as: 'admin',
    budget: SINGLE,
    basis: 'single record',
  },
  {
    route: 'GET /api/v1/albums',
    path: '/api/v1/albums',
    as: 'member',
    ...paged(ALBUMS_PAGE),
  },
  {
    route: 'GET /api/v1/chat/messages',
    path: '/api/v1/chat/messages',
    as: 'member',
    ...paged(50),
  },
  {
    route: 'GET /api/v1/info',
    path: '/api/v1/info',
    as: 'member',
    ...paged(INFO_PAGE),
  },
  {
    route: 'GET /api/v1/info/sample-id',
    path: '/api/v1/info/:info',
    as: 'member',
    budget: SINGLE,
    basis: 'single record',
  },
  {
    route: 'GET /api/v1/me',
    path: '/api/v1/me',
    as: 'member',
    budget: SINGLE,
    basis: 'single record',
  },
  {
    route: 'GET /api/v1/media',
    path: '/api/v1/media',
    as: 'member',
    ...paged(30),
  },
  {
    route: 'GET /api/v1/media/sample-id/sample-id',
    path: '/api/v1/media/:media/image',
    as: 'member',
    budget: SINGLE,
    basis: 'single record',
  },
  {
    route: 'GET /api/v1/members',
    path: '/api/v1/members',
    as: 'member',
    ...paged(50),
  },
  {
    route: 'GET /api/v1/members/sample-id',
    path: '/api/v1/members/:member',
    as: 'member',
    budget: SINGLE,
    basis: 'single record',
  },
  {
    route: 'GET /api/v1/notifications',
    path: '/api/v1/notifications',
    as: 'member',
    budget: SINGLE,
    basis: 'single record (own prefs)',
  },
  {
    route: 'GET /api/v1/posts',
    path: '/api/v1/posts',
    as: 'member',
    ...paged(20),
  },
  {
    route: 'GET /api/v1/posts/sample-id',
    path: '/api/v1/posts/:post',
    as: 'member',
    budget: SINGLE,
    basis: 'single record',
  },
  {
    route: 'GET /api/v1/posts/sample-id/comments',
    path: '/api/v1/posts/:post/comments',
    as: 'member',
    ...paged(20),
  },
  { route: 'GET /chat', path: '/chat', as: 'member', budget: SINGLE, basis: 'single record' },
  { route: 'GET /denied', path: '/denied', as: 'member', budget: SINGLE, basis: 'static page' },
  {
    route: 'GET /discussions',
    path: '/discussions',
    as: 'member',
    ...paged(20),
  },
  {
    route: 'GET /discussions/sample-id',
    path: '/discussions/:post',
    as: 'member',
    ...paged(20),
  },
  {
    route: 'GET /health',
    path: '/health',
    as: 'member',
    budget: SINGLE,
    basis: 'public, reads nothing',
  },
  {
    route: 'GET /info/sample-id',
    path: '/info/:info',
    as: 'member',
    budget: SINGLE,
    basis: 'single record',
  },
  { route: 'GET /install', path: '/install', as: 'member', budget: SINGLE, basis: 'static page' },
  { route: 'GET /locked', path: '/locked', as: 'member', budget: SINGLE, basis: 'static page' },
  {
    route: 'GET /manifest.webmanifest',
    path: '/manifest.webmanifest',
    as: 'member',
    budget: SINGLE,
    basis: 'public, reads settings once',
  },
  { route: 'GET /members', path: '/members', as: 'member', ...paged(50) },
  {
    route: 'GET /members/sample-id',
    path: '/members/:member',
    as: 'member',
    budget: SINGLE,
    basis: 'single record',
  },
  {
    route: 'GET /memories',
    path: '/memories',
    as: 'member',
    budget: listBudget(30) + listBudget(ALBUMS_PAGE) + listBudget(YEAR_CHIPS) + SINGLE,
    basis:
      '(2 × 30 + 10) photo page + (2 × 50 + 10) album page + (2 × 8 + 10) year chips + 30 single-record reads (R-MEM-14, AC-BUD-02)',
  },
  {
    route: 'GET /memories/sample-id',
    path: '/memories/:media',
    as: 'member',
    budget: listBudget(ALBUMS_PAGE) + SINGLE,
    basis: '(2 × 50 + 10) album edit picker + 30 single-record reads (R-MEM-14, AC-BUD-02)',
  },
  {
    route: 'GET /notifications',
    path: '/notifications',
    as: 'member',
    budget: SINGLE,
    basis: 'single record (own prefs)',
  },
  { route: 'GET /privacy', path: '/privacy', as: 'member', budget: SINGLE, basis: 'static page' },
  { route: 'GET /profile', path: '/profile', as: 'member', budget: SINGLE, basis: 'single record' },
];

/** GET routes the budget does not measure, each with the reason it cannot. */
export const excluded: Record<string, string> = {
  'GET /api/v1/chat/ws': 'WebSocket upgrade: the room is not a page view (R-CHAT-04).',
  'GET /api/v1/me/export':
    'Own-data export: rows scale with the member’s content, not a page (AC-PROF-05).',
  'GET /join': 'Public join form, off by default and anonymous-only (R-AUTH-27).',
  'GET /api/v1/admin/join-requestssample-id':
    'Manifest artifact of the spec’s `[/:id]` row; the built route exports no GET (POST/DELETE only).',
  'GET /api/v1/admin/usage': 'Spec route not built yet (a later slice).',
};

export const budgetFor = (route: string): RowBudget | undefined =>
  budgets.find((entry) => entry.route === route);
