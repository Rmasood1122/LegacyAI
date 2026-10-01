// Module boundary rules. CI fails if any of these is violated.
// The three modules must be separable into their own services later, so:
//   - a module is imported only through its index.ts
//   - platform is the base layer and imports no other module
//   - only app.ts / main.ts / cli wire modules together
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-cross-module-internals',
      comment: "A module's internal/ folder is private. Import the module's index.ts instead.",
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: { path: '^src/modules/([^/]+)/internal/', pathNot: '^src/modules/$1/' },
    },
    {
      name: 'no-internals-from-outside-modules',
      comment: 'app.ts, main.ts and shared code must use module index files, never internals.',
      severity: 'error',
      from: { path: '^src/(app|main)\\.ts$|^src/shared/' },
      to: { path: '^src/modules/[^/]+/internal/' },
    },
    {
      name: 'platform-is-the-base-layer',
      comment: 'platform must not depend on identity-access or billing (it defines ports instead).',
      severity: 'error',
      from: { path: '^src/modules/platform/' },
      to: { path: '^src/modules/(identity-access|billing)/' },
    },
    {
      name: 'billing-does-not-depend-on-identity',
      severity: 'error',
      from: { path: '^src/modules/billing/' },
      to: { path: '^src/modules/identity-access/' },
    },
    {
      name: 'shared-depends-on-nothing',
      comment: 'shared/ holds dependency-free helpers and types only.',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { path: '^src/(modules|cli|app\\.ts|main\\.ts)' },
    },
    {
      name: 'modules-do-not-import-the-app',
      severity: 'error',
      from: { path: '^src/modules/' },
      to: { path: '^src/(app|main)\\.ts$|^src/cli/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { extensions: ['.ts', '.js'] },
  },
};
