// Lint rules. Besides general hygiene, three rules here are SECURITY rules:
//  1. no SQL built by string concatenation or template interpolation (parameterised SQL only);
//  2. no Math.random (card numbers, codes and tokens must come from the OS CSPRNG);
//  3. routes may only be registered through defineRoutes() (never app.get/post/... directly).
import tseslint from 'typescript-eslint';

const sqlRules = [
  {
    // Interpolating an UPPER_CASE constant (a fixed column list defined in code, e.g. ${CARD_COLUMNS}) is
    // allowed. Anything else inside a query template - a variable, a property, a call - is an error.
    selector: "CallExpression[callee.property.name=/^(query|global)$/] > TemplateLiteral:first-child:has(> .expressions:not(Identifier[name=/^[A-Z][A-Z0-9_]*$/]))",
    message: 'SQL must be parameterised: do not interpolate values into a query. Use $1, $2 ... and pass values separately.',
  },
  {
    selector: "CallExpression[callee.property.name=/^(query|global)$/] > BinaryExpression:first-child[operator='+']",
    message: 'SQL must be parameterised: do not build a query by concatenation.',
  },
  {
    selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
    message: 'Math.random is not cryptographically secure. Use node:crypto (randomInt, randomBytes).',
  },
];

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.test-exports/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...sqlRules,
        {
          selector: "CallExpression[callee.object.name='app'][callee.property.name=/^(get|post|put|patch|delete|all)$/]",
          message: 'Register routes with defineRoutes() so every route has a policy check.',
        },
      ],
      'no-console': 'off',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      '@typescript-eslint/no-explicit-any': 'off', // request bodies are validated against openapi.yaml at runtime
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
