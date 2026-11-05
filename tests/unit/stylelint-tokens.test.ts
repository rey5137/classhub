import path from 'node:path';
import stylelint from 'stylelint';
import { describe, expect, it } from 'vitest';

async function warnings(declaration: string) {
  const result = await stylelint.lint({
    code: `<style>.example { ${declaration} }</style>`,
    codeFilename: path.resolve('src/lib/components/TokenRuleFixture.svelte'),
    configFile: path.resolve('stylelint.config.mjs'),
  });
  return result.results.flatMap((entry) => entry.warnings);
}

describe('AC-UI-05 components use theme tokens', () => {
  it.each([
    'color: #ff0000',
    'background: rgb(255 0 0)',
    'border: 1px solid red',
    '--local-colour: #ff0000',
    'font-family: Arial, sans-serif',
    'font-family: var(--font-body), Arial, sans-serif',
    'font-family: Arial',
    'font: 16px Georgia',
    'font-family: var(--font-body, Arial)',
    'color: Highlight',
    'background: Canvas',
  ])('refuses %s', async (declaration) => {
    expect(await warnings(declaration)).toHaveLength(1);
  });

  it.each([
    '<svg><path fill="#d9302f" /></svg>',
    '<p style="color:#f00">x</p>',
    '<p style="font-family: Arial">x</p>',
    '<svg><path stroke="red" /></svg>',
  ])('refuses markup %s', async (markup) => {
    const result = await stylelint.lint({
      code: `${markup}\n<style>.a { color: var(--color-text); } </style>\n<style>.b { color: var(--color-text); }</style>`,
      codeFilename: path.resolve('src/lib/components/TokenRuleFixture.svelte'),
      configFile: path.resolve('stylelint.config.mjs'),
    });
    expect(result.results.flatMap((entry) => entry.warnings)).toHaveLength(1);
  });

  it('accepts token markup and the mark colour token', async () => {
    const result = await stylelint.lint({
      code: '<svg><path fill="currentColor" stroke="var(--color-mark)" /></svg><p style="color: var(--color-mark)">x</p>',
      codeFilename: path.resolve('src/lib/components/TokenRuleFixture.svelte'),
      configFile: path.resolve('stylelint.config.mjs'),
    });
    expect(result.results.flatMap((entry) => entry.warnings)).toHaveLength(0);
  });

  it('accepts colour and font tokens with transparent surfaces', async () => {
    expect(
      await warnings(
        'color: var(--color-text); background: transparent; font: var(--text-body); font-family: var(--font-body)',
      ),
    ).toHaveLength(0);
  });
});
