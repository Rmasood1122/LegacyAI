// Outgoing webhooks and e-mail: one delivery run for every company, then exit (docs/phase4/06).
// Sends nothing unless WEBHOOK_DELIVERY=https or an e-mail sender is configured. Nothing schedules this command
// yet: in production it has to run every minute or so (a scheduled job - the founder's choice, docs/runbooks).
// The housekeeping command runs the same delivery once as part of its jobs.
//
//   npm run outbound:deliver
import { createApp } from '../app.ts';
import { loadConfig } from '../modules/platform/index.ts';
import { deliverOutbound, startedAs } from './housekeeping.ts';

if (startedAs(import.meta.url)) {
  const app = await createApp(loadConfig(process.env));
  try {
    console.log(JSON.stringify(await deliverOutbound(app)));
  } finally {
    await app.close();
  }
}
