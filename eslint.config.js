import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'out/',
      'dist/',
      'dist-cli/',
      'coverage/',
      'node_modules/',
      'web/',
      'packages/coax-cli/coax.cjs',
      'test-results/',
      'tmp/',
      'playwright-report/',
      'docs/',
    ],
  },

  js.configs.recommended,

  // Plain JS/CJS/MJS (build + packaging scripts): recommended rules only, no type-aware linting.
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'commonjs',
    },
  },
  {
    files: ['**/*.mjs', 'eslint.config.js'],
    languageOptions: { sourceType: 'module' },
  },

  // TypeScript: typed linting against the repo tsconfigs.
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: ['**/*.ts', '**/*.tsx'],
  })),
  ...tseslint.configs.stylisticTypeChecked.map((config) => ({
    ...config,
    files: ['**/*.ts', '**/*.tsx'],
  })),
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: {
          // tests-e2e/** is not in tsconfig.json or tsconfig.node.json; the
          // default project gives it typed linting anyway.
          allowDefaultProject: ['tests-e2e/*.ts', 'tests-e2e/fixtures/*.ts'],
          defaultProject: 'tsconfig.json',
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      // tsconfig sets noUncheckedIndexedAccess, so `arr[0]!` / `queue.shift()!` after an
      // explicit length or guard check is the codebase-wide idiom for indexed access.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Type declarations are optimistic about data crossing IPC, SQLite rows and parsed
      // .http files; the "unnecessary" guards are deliberate runtime defence.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // Interpolating numbers into template literals is intentional throughout the CLI
      // reporters and UI status strings.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Async functions are passed directly as DOM/IPC event listeners across the UI;
      // the listener contract genuinely ignores the returned promise.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
      // `a || b` fallbacks here deliberately treat '' and 0 as absent; rewriting them
      // to `??` would change behavior.
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      // Async wrappers keep a Promise-returning contract even when the body is
      // currently synchronous (runner host lifecycle, test doubles).
      '@typescript-eslint/require-await': 'off',
      // `_`-prefixed bindings mark deliberately unused params kept for signature shape.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // Tests assert on fixture shapes and load fixture modules dynamically.
  {
    files: ['tests/**/*.ts', 'tests-e2e/**/*.ts'],
    rules: {
      // A migration test requires fixture modules at runtime to exercise old code paths.
      '@typescript-eslint/no-require-imports': 'off',
      // Tests parse JSON fixtures and use loosely-typed node stream callbacks; the
      // assertions themselves are the shape check.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
);
