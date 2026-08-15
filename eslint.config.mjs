import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

const browserGlobals = {
  AbortController: 'readonly',
  Blob: 'readonly',
  CSS: 'readonly',
  CustomEvent: 'readonly',
  DOMParser: 'readonly',
  Event: 'readonly',
  EventTarget: 'readonly',
  FormData: 'readonly',
  Headers: 'readonly',
  HTMLInputElement: 'readonly',
  HTMLElement: 'readonly',
  HTMLTextAreaElement: 'readonly',
  InputEvent: 'readonly',
  MutationObserver: 'readonly',
  Node: 'readonly',
  ResizeObserver: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  TextEncoder: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  atob: 'readonly',
  btoa: 'readonly',
  chrome: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  crypto: 'readonly',
  document: 'readonly',
  fetch: 'readonly',
  importScripts: 'readonly',
  location: 'readonly',
  navigator: 'readonly',
  requestAnimationFrame: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  structuredClone: 'readonly',
  window: 'readonly'
};

const nodeGlobals = {
  Buffer: 'readonly',
  ReadableStream: 'readonly',
  Response: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  clearImmediate: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  exports: 'writable',
  fetch: 'readonly',
  global: 'writable',
  module: 'writable',
  process: 'readonly',
  require: 'readonly',
  setImmediate: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  structuredClone: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly'
};

const productionRules = {
  ...eslint.configs.recommended.rules,
  curly: ['error', 'multi-line'],
  eqeqeq: ['error', 'always'],
  'no-alert': 'error',
  'no-debugger': 'error',
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  'no-throw-literal': 'error',
  'no-undef': 'error',
  'no-unreachable': 'error',
  'no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      caughtErrors: 'none',
      varsIgnorePattern: '^_'
    }
  ],
  'no-with': 'error',
  'prefer-const': 'error'
};

const typeScriptRules = Object.assign(
  {},
  ...tseslint.configs.recommendedTypeChecked.map((config) => config.rules || {})
);

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.wrangler/**',
      'artifacts/**',
      'website/**'
    ]
  },
  {
    files: ['extension/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: browserGlobals,
      sourceType: 'script'
    },
    rules: productionRules
  },
  {
    files: ['backend/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: nodeGlobals,
      sourceType: 'commonjs'
    },
    rules: productionRules
  },
  {
    files: ['backend/src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      },
      globals: nodeGlobals
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin
    },
    rules: {
      ...productionRules,
      ...typeScriptRules,
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/require-await': 'off'
    }
  },
  {
    files: ['backend/test-api.js', 'backend/test-environment.js', 'backend/test-extension.js'],
    rules: {
      'no-eval': 'off',
      'no-undef': 'off',
      'no-unused-vars': 'off'
    }
  },
  {
    files: ['scripts/**/*.mjs', 'quality-tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: nodeGlobals,
      sourceType: 'module'
    },
    rules: productionRules
  }
];
