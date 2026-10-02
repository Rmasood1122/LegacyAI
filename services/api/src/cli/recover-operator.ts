// BREAK-GLASS: recovers a LegacyAI operator card that can no longer sign in (locked, lost
// device, expired). There is no way to do this through the API - operators cannot recover
// each other - so it runs here, with the same database access and keys the API has.
//
//   npm run platform:recover-operator -- --card-number LGY-1234-5678-9012-3456
//
// Every existing strong factor and session of that card is revoked and its SC is replaced.
// Prints the new SC and a one-time enrollment token ONCE. Enrol a new passkey straight away.
// The action is written to the platform audit chain (card:owner_recovery, actor "system").
import { fileURLToPath } from 'node:url';
import { createApp } from '../app.ts';
import { recoverOperator } from '../modules/identity-access/index.ts';
import { loadConfig } from '../modules/platform/index.ts';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--card-number');
  const cardNumber = at === -1 ? undefined : process.argv[at + 1];
  if (cardNumber === undefined) {
    console.error('usage: npm run platform:recover-operator -- --card-number LGY-xxxx-xxxx-xxxx-xxxx');
    process.exitCode = 2;
  } else {
    const app = await createApp(loadConfig(process.env));
    try {
      const result = await recoverOperator(app.db, app.identity.cards, cardNumber, { requestId: 'cli-recover-operator', ip: '', userAgent: 'cli', now: new Date() });
      // Written to stdout on purpose and only here; nothing below goes through the logger.
      process.stdout.write([
        '',
        'Operator card recovered. THIS IS SHOWN ONCE - write it down now.',
        `  Card number:       ${result.card_number}`,
        `  New secret code:   ${result.sc}`,
        `  Enrollment token:  ${result.enrollment_token}`,
        `  Token expires:     ${result.enrollment_token_expires_at}`,
        '',
        'All earlier passkeys, authenticator apps and sessions of this card are revoked.',
        'Next: enrol a new passkey or authenticator app with these three values.',
        '',
      ].join('\n'));
    } catch (err) {
      console.error(err instanceof Error ? err.message : 'recovery failed');
      process.exitCode = 1;
    } finally {
      await app.close();
    }
  }
}
