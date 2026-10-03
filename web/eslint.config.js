// Lint rules for the web application. Besides the TypeScript checks, these rules keep promises the
// design makes (docs/phase3/00-proposal.md, docs/phase3/01-web-application.md):
//   1. only src/api/client.ts may talk to the network (screens go through the client and the hooks);
//   2. nothing is kept in browser storage;
//   3. no inline styles and no raw HTML injection (the content-security policy forbids the first,
//      and the second is how cross-site scripting gets in);
//   4. the layers point one way:  generated -> api -> session -> navigation -> features -> screens/App,
//      with ui/ beside them (presentational, no data). A feature never imports another feature, the
//      application frame, the cache library, or the API client itself.
// scripts/lint-selftest.mjs proves each of these really fires.
import tseslint from 'typescript-eslint';

const everywhere = [
  { selector: "MemberExpression[object.name=/^(localStorage|sessionStorage|indexedDB)$/]", message: 'Nothing is kept in browser storage.' },
  { selector: "Identifier[name=/^(localStorage|sessionStorage|indexedDB)$/]", message: 'Nothing is kept in browser storage.' },
  { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: 'Never inject HTML; render text.' },
  { selector: "JSXAttribute[name.name='style']", message: 'No inline styles: the content-security policy blocks them. Use a class.' },
  { selector: "MemberExpression[property.name=/^(innerHTML|outerHTML)$/]", message: 'Never inject HTML; render text.' },
  { selector: "CallExpression[callee.name='eval']", message: 'No eval.' },
  // The layer rules read static imports; a dynamic import() would slip past them, and nothing here needs one.
  { selector: 'ImportExpression', message: 'No dynamic import(): the layer rules only see static imports.' },
];
const noNetwork = [
  { selector: "CallExpression[callee.name='fetch']", message: 'Only src/api/client.ts talks to the network. Use the API client.' },
  { selector: "MemberExpression[property.name='fetch']", message: 'Only src/api/client.ts talks to the network. Use the API client.' },
  { selector: "NewExpression[callee.name=/^(XMLHttpRequest|WebSocket|EventSource)$/]", message: 'Only src/api/client.ts talks to the network.' },
  { selector: "MemberExpression[property.name='sendBeacon']", message: 'Only src/api/client.ts talks to the network.' },
];

// Import paths are matched as written, so these work for any folder name - also ones added later.
const dirs = (...names) => ({ regex: `(^|/)(${names.join('|')})/`, message: `This layer may not import from: ${names.join(', ')}.` });
const FRAME = { regex: '(^|/)(App|screens|main)(\\.tsx?)?$', message: 'Nothing below the application frame may import App, screens or main (it would close a circle).' };
const layer = (files, ...patterns) => ({
  files, ignores: ['**/*.test.{ts,tsx}'],
  rules: { 'no-restricted-imports': ['error', { patterns }] },
});

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'src/api/generated.ts', 'playwright-report/**', 'test-results/**'] },
  ...tseslint.configs.strict,
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': ['error', ...everywhere, ...noNetwork], 'no-console': 'error' },
  },
  // The one place that may call fetch; the composition root hands it the browser's fetch.
  { files: ['src/api/client.ts', 'src/main.tsx'], rules: { 'no-restricted-syntax': ['error', ...everywhere] } },

  layer(['src/api/**/*.{ts,tsx}'], dirs('session', 'navigation', 'ui', 'features', 'styles'), FRAME),
  layer(['src/session/**/*.{ts,tsx}'], dirs('navigation', 'ui', 'features'), FRAME),
  layer(['src/navigation/**/*.{ts,tsx}'], dirs('ui', 'features'), FRAME),
  layer(['src/ui/**/*.{ts,tsx}'], { ...dirs('api', 'session', 'navigation', 'features'), message: 'ui/ is presentational: no data access.' }, FRAME),
  // Features share only api/, session/, navigation/ and ui/. A feature folder is one level deep, so
  // "../something" from inside it is always a sibling feature.
  layer(['src/features/*/**/*.{ts,tsx}'],
    { regex: '^\\.\\./(?!\\.\\./)', message: 'A feature may not import from another feature.' },
    { ...dirs('features'), message: 'A feature may not import from another feature.' },
    FRAME,
    { group: ['@tanstack/*'], message: 'Features read and change data through useApiQuery, useApiList, useApiMutation and useRefresh (src/api/context.tsx).' },
    { regex: '(^|/)api/context(\\.tsx)?$', importNames: ['useApi', 'ApiProvider'], message: 'Features do not use the API client directly; use the hooks of src/api/context.tsx.' },
  ),
  // The rule above reads "../x" as "another feature", which is only true while a feature has no sub-folders.
  {
    files: ['src/features/*/*/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': ['error', { selector: 'Program', message: 'A feature folder is one level deep: no sub-folders (the feature-isolation rule depends on it).' }] },
  },
);
