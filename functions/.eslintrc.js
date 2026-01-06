module.exports = {
  root: true,
  env: {
    es6: true,
    node: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:import/errors',
    'plugin:import/warnings',
    'plugin:import/typescript',
    'google',
    'plugin:@typescript-eslint/recommended',
  ],

  overrides: [
    {
      env: {
        node: true,
      },
      files: ['.eslintrc.{js,cjs}'],
      parserOptions: {
        sourceType: 'script',
      },
    },
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    // project: ['tsconfig.json', 'tsconfig.dev.json'],
    sourceType: 'module',
  },
  ignorePatterns: [
    '/lib/**/*', // Ignore built files.
  ],
  plugins: ['@typescript-eslint', 'import'],
  /* note that formatting is handled by prettier */
  rules: {
    quotes: 0,
    'import/no-unresolved': 0,
    '@typescript-eslint/no-explicit-any': 0,
    'comma-dangle': 0,
    indent: 0,
    semi: 0,
    '@typescript-eslint/no-extra-semi': 0,
    'require-jsdoc': 0,
    'operator-linebreak': 0,
    'max-len': 0,
    'object-curly-spacing': 0,
    '@typescript-eslint/no-var-requires': 'warn',
    'guard-for-in': 'warn',
    'space-before-function-paren': 0,
    'quote-props': 0,
    'spaced-comment': ['warn', 'always', { markers: ['#'] }],
    'valid-jsdoc': 0,
  },
}
