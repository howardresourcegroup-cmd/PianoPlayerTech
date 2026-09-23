// Errors only, not style opinions.
//
// This exists because `node --check` and wrangler's bundler both pass code
// that is grammatically valid but broken. Moving the Stripe code into its own
// module once left REFERRAL_FEE behind as a free variable: every check passed,
// and it would have thrown on the first monthly partner invoice. `no-undef`
// catches exactly that.
//
// Nothing here enforces formatting. A rule that argues about quotes or commas
// trains people to ignore the output, which defeats the point.

const WORKER_GLOBALS = {
  // Cloudflare Workers runtime.
  addEventListener: 'readonly', caches: 'readonly', crypto: 'readonly',
  fetch: 'readonly', Request: 'readonly', Response: 'readonly',
  Headers: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
  TextEncoder: 'readonly', TextDecoder: 'readonly', FormData: 'readonly',
  atob: 'readonly', btoa: 'readonly', console: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', structuredClone: 'readonly',
  AbortController: 'readonly', ReadableStream: 'readonly', Blob: 'readonly'
};

const BROWSER_GLOBALS = {
  ...WORKER_GLOBALS,
  window: 'readonly', document: 'readonly', navigator: 'readonly',
  location: 'readonly', history: 'readonly', alert: 'readonly',
  confirm: 'readonly', prompt: 'readonly', localStorage: 'readonly',
  sessionStorage: 'readonly', matchMedia: 'readonly', Event: 'readonly',
  CustomEvent: 'readonly', HTMLElement: 'readonly', getComputedStyle: 'readonly',
  requestAnimationFrame: 'readonly', Intl: 'readonly',
  innerWidth: 'readonly', innerHeight: 'readonly', scrollTo: 'readonly',
  removeEventListener: 'readonly', Blob: 'readonly', FileReader: 'readonly',
  matchMedia: 'readonly',
  // Injected by the Google Analytics tag in the page, not by us.
  gtag: 'readonly', dataLayer: 'readonly'
};

const NODE_GLOBALS = {
  console: 'readonly', process: 'readonly', __dirname: 'readonly',
  __filename: 'readonly', module: 'writable', require: 'readonly',
  exports: 'writable', Buffer: 'readonly', URL: 'readonly',
  TextEncoder: 'readonly', TextDecoder: 'readonly', fetch: 'readonly',
  Response: 'readonly', setTimeout: 'readonly', globalThis: 'readonly'
};

// The rules that catch real defects. Each one has a reason to be here.
const ERRORS = {
  // The one that would have caught the REFERRAL_FEE break.
  'no-undef': 'error',
  // A second `const EMAIL_RE` once stopped a whole module parsing.
  'no-redeclare': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  // Usually the leftover half of an unfinished refactor.
  'no-unused-vars': ['error', {
    args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_'
  }],
  'no-unreachable': 'error',
  'no-const-assign': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-cond-assign': 'error',
  'valid-typeof': 'error',
  'use-isnan': 'error',
  'no-sparse-arrays': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-obj-calls': 'error',
  'no-compare-neg-zero': 'error',
  'require-atomic-updates': 'error',
  // A floating promise in a Worker is work that silently never happens.
  'no-async-promise-executor': 'error',
  'no-promise-executor-return': 'error',
  // Customer-typed text must never reach the DOM as markup. This is the one
  // rule here that is about security rather than correctness.
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-script-url': 'error'
};

export default [
  {
    ignores: ['node_modules/**', '.harness/**', '.wrangler/**',
              'Images/**', 'js/**', '*.min.js']
  },
  {
    // Cloudflare Pages Functions: the server.
    files: ['functions/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023, sourceType: 'module', globals: WORKER_GLOBALS
    },
    rules: ERRORS
  },
  {
    // The CRM client application, served as a static asset.
    files: ['crm/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023, sourceType: 'module', globals: BROWSER_GLOBALS
    },
    rules: ERRORS
  },
  {
    // Build and migration tooling runs under Node.
    files: ['tools/**/*.js', 'tools/**/*.mjs', '.github/scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023, sourceType: 'commonjs', globals: NODE_GLOBALS
    },
    rules: ERRORS
  },
  {
    files: ['tools/**/*.mjs'],
    languageOptions: { sourceType: 'module' }
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023, sourceType: 'commonjs', globals: NODE_GLOBALS
    },
    rules: ERRORS
  },
  {
    files: ['tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023, sourceType: 'module', globals: NODE_GLOBALS
    },
    // A test that stubs the network necessarily reassigns a global around an
    // await. That is the point of the test, not a race in production code.
    rules: { ...ERRORS, 'require-atomic-updates': 'off' }
  },
  {
    // Root-level site scripts are classic browser scripts, not modules.
    files: ['*.js'],
    ignores: ['eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 2023, sourceType: 'script', globals: BROWSER_GLOBALS
    },
    rules: ERRORS
  }
];
