// R-DB-07: a keyset position as an opaque, URL-safe token. A token the server did not
// write decodes to `null`, which callers report as a `validation` error.

export function encodeCursor(position: readonly (string | number)[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(position));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export function decodeCursor(cursor: string): unknown[] | null {
  try {
    const binary = atob(cursor.replaceAll('-', '+').replaceAll('_', '/'));
    const text = new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
