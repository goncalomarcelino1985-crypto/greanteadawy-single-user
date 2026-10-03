// Lint config for the whole monorepo: `npm run lint`.
import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', 'data/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,jsx}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart']
    }
  },
  {
    files: ['client/**/*.{js,jsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'off',
      'react/jsx-key': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },
  {
    // plugin code: plain scripts run inside the plugin harness (no imports, no Node/DOM — only the `gtd` API)
    files: ['plugins/**/*.js', 'skills/*/templates/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { gtd: 'readonly', Math: 'readonly', Float32Array: 'readonly', console: 'readonly' }
    }
  },
  {
    files: ['e2e/**/*.js', 'playwright.config.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } }
  }
];
