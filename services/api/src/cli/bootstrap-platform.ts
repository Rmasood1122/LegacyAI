// Creates the FIRST LegacyAI operator card (in the platform tenant). Run once.
//
//   npm run platform:bootstrap
//
// Prints the card number, the 3-digit code and a one-time enrollment token ONCE.
// They are not stored in readable form and cannot be shown again. Enrol a passkey with
// them straight away (the token expires in 72 hours).
import { fileURLToPath } from 'node:url';
import { createApp } from '../app.ts';
import { bootstrapOperator } from '../modules/identity-access/index.ts';
import { loadConfig } from '../modules/platform/index.ts';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await createApp(loadConfig(process.env));
  try {
    const result = await bootstrapOperator(app.db, app.identity.cards, { requestId: 'cli-bootstrap', ip: '', userAgent: 'cli', now: new Date() });
    // Written to stdout on purpose and only here; nothing below goes through the logger.
    process.stdout.write([
      '',
      'LegacyAI operator card created. THIS IS SHOWN ONCE - write it down now.',
      `  Card number:       ${result.card_number}`,
      `  Secret code (SC):  ${result.sc}`,
      `  Enrollment token:  ${result.enrollment_token}`,
      `  Token expires:     ${result.enrollment_token_expires_at}`,
      '',
      'Next: enrol a passkey or authenticator app with these three values.',
      '',
    ].join('\n'));
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'bootstrap failed');
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}
