export default {
  plugins: ['./stylelint-plugin.mjs'],
  overrides: [
    {
      files: ['**/*.svelte'],
      customSyntax: 'postcss-html',
    },
  ],
  rules: {
    'classhub/no-raw-tokens': true,
  },
};
