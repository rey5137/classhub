// R-PROF-08: the one normalizer for every `*_norm` column and every directory search,
// shared by the app, the demo seed and `scripts/lib/invite.mjs` (which Node loads
// with type stripping, so this file stays plain, erasable TypeScript).

/**
 * Case- and accent-insensitive form of a name: "Nguyễn Đức" and "nguyen duc" match.
 * `đ` has no decomposition, so it is folded by hand.
 */
export function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
