/**
 * JSONC (comments, trailing commas) as `JSON.parse` reads it, by the same rules as
 * cf.mjs, which keeps its own copy so its tests can run it alone.
 * @param {string} source @returns {any}
 */
export function parseJsonc(source) {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      output += char;
    } else if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      output += '\n';
    } else if (char === '/' && source[index + 1] === '*') {
      index = source.indexOf('*/', index + 2);
      if (index === -1) throw new SyntaxError('unterminated comment');
      index += 1;
    } else if (char === ',' && /^\s*[}\]]/.test(source.slice(index + 1))) {
      // a trailing comma: dropped
    } else {
      output += char;
    }
  }
  return JSON.parse(output);
}
