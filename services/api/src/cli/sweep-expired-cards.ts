// The OLD NAME of the housekeeping command (src/cli/housekeeping.ts), kept so that nothing that runs or imports
// "sweep-expired-cards" breaks. It does exactly the same.
import { createApp } from '../app.ts';
import { loadConfig } from '../modules/platform/index.ts';
import { runHousekeeping, startedAs } from './housekeeping.ts';

export * from './housekeeping.ts';

if (startedAs(import.meta.url)) {
  const app = await createApp(loadConfig(process.env));
  try {
    console.log(JSON.stringify(await runHousekeeping(app, new Date())));
  } finally {
    await app.close();
  }
}
