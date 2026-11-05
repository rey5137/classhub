import stylelint from 'stylelint';

const ruleName = 'classhub/no-raw-tokens';

const messages = stylelint.utils.ruleMessages(ruleName, {
  colour: (value) => `Use a theme colour token instead of the raw value "${value}" (R-UI-05)`,
  font: (value) => `Use var(--font-body) or var(--font-heading) instead of "${value}" (R-UI-05)`,
});

// R-UI-05: a font declaration may hold only theme tokens, CSS-wide keywords, sizes and weights.
// `var(--x, fallback)` is refused too, since the fallback is a raw stack.
const allowedFontPart = /^(?:inherit|initial|unset|revert|[\d.]+(?:px|rem|em|%)?)$/i;

function hasRawFont(value) {
  const rest = value.replace(/var\(\s*--[a-z0-9-]+\s*\)/gi, ' ');
  return rest
    .split(/[\s,/]+/)
    .filter(Boolean)
    .some((part) => !allowedFontPart.test(part));
}

const systemColours =
  /\b(?:canvas|canvastext|linktext|visitedtext|activetext|buttonface|buttontext|buttonborder|field|fieldtext|highlight|highlighttext|selecteditem|selecteditemtext|mark|marktext|graytext|accentcolor|accentcolortext)\b/i;

const rawColour =
  /#(?:[0-9a-f]{3,8})\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|\b(?:aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkgrey|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgreen|lightgrey|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen)\b/i;

function hasRawColour(value) {
  const rest = value.replace(/var\([^)]*\)/gi, ' ');
  return rawColour.test(rest) || systemColours.test(rest);
}

// Markup outside <style>: presentation attributes bypass the declaration walk (style="" is walked as declarations).
const colourAttribute =
  /\b(?:fill|stroke|stop-color|flood-color|lighting-color|color|bgcolor)\s*=\s*(["'])(.*?)\1/gis;
const seen = new WeakSet();

function markupViolations(source) {
  const markup = source.replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, (block) =>
    block.replace(/[^\n]/g, ' '),
  );
  const found = [];
  const lineOf = (index) => markup.slice(0, index).split('\n').length;
  for (const match of markup.matchAll(colourAttribute)) {
    if (hasRawColour(match[2])) found.push({ line: lineOf(match.index), value: match[0] });
  }
  return found;
}

/** @type {import('stylelint').Rule} */
const rule = (primary) => (root, result) => {
  const validOptions = stylelint.utils.validateOptions(result, ruleName, { actual: primary });
  if (!validOptions) return;

  const source = result.root?.source?.input.css ?? root.source?.input.css;
  if (source && !seen.has(result)) {
    seen.add(result);
    for (const { line, value } of markupViolations(source)) {
      stylelint.utils.report({
        message: messages.colour(value),
        result,
        ruleName,
        node: root,
        start: { line, column: 1 },
        end: { line, column: 1 },
      });
    }
  }

  root.walkDecls((decl) => {
    if (decl.prop === 'font' || decl.prop === 'font-family') {
      if (hasRawFont(decl.value)) {
        stylelint.utils.report({
          message: messages.font(decl.value),
          node: decl,
          result,
          ruleName,
        });
      }
      return;
    }
    if (hasRawColour(decl.value)) {
      stylelint.utils.report({
        message: messages.colour(decl.value),
        node: decl,
        result,
        ruleName,
      });
    }
  });
};

export default stylelint.createPlugin(ruleName, rule);
