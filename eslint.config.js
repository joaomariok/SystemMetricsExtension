const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
  {
    files: ['media/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, acquireVsCodeApi: 'readonly', fmt: 'readonly' },
    },
  },
  {
    // Exports for node tests as well as setting window.fmt.
    files: ['media/format.js'],
    languageOptions: { globals: { module: 'readonly' } },
  },
];
