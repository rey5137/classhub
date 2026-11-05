// R-AUTH-19 / R-BUD-06: the Zero Trust Free seat limit, and where the screen starts warning.
// Shared by the app and `scripts/lib/invite.mjs` (Node loads this with type stripping,
// so the file stays plain, erasable TypeScript).

export const SEAT_LIMIT = 50;
export const SEAT_WARNING = 45;
