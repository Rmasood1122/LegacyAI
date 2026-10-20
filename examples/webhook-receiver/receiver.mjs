// An example receiver for LegacyAI webhooks - the "one example connector" of feature 28 (docs/phase4/06).
// Node.js only, no package to install. It shows the four things every receiver must do:
//   1. check the signature over the RAW body, before parsing it;
//   2. refuse a message whose timestamp is more than 5 minutes off (a recorded message cannot be replayed later);
//   3. ignore an id it has already handled (the same message can arrive twice - LegacyAI sends at least once);
//   4. answer 2xx quickly and do the real work afterwards (LegacyAI waits 5 seconds at most).
// What it then does with an event is up to you: this example only prints it. A typical next step is to read the
// item with an API key (GET /v1/knowledge/items/{item_id}) and update a search index.
//
// It listens on plain http on 127.0.0.1. LegacyAI only sends to https addresses on the public internet, so in real
// use it sits behind a web server or tunnel that terminates TLS.
//
//   LEGACYAI_WEBHOOK_SECRET=whsec_... node receiver.mjs      (port 8787, or PORT=...)
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const TOLERANCE_SECONDS = 5 * 60;

/** True when the message is signed with this secret and recent. `headers` have lower-case names. */
export function verifyWebhook(secret, headers, rawBody, now = new Date()) {
  if (typeof secret !== 'string' || !secret.startsWith('whsec_')) return false;
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatures = headers['webhook-signature'];
  if (typeof id !== 'string' || typeof timestamp !== 'string' || typeof signatures !== 'string' || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64'));
  return signatures.split(' ').some((part) => {
    const [version, value] = part.split(',', 2);
    if (version !== 'v1' || value === undefined) return false;
    const given = Buffer.from(value);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** A receiver as a request handler. `seen` remembers handled ids (use a database in real use). */
export function createReceiver(secret, onEvent, seen = new Set()) {
  return (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) req.destroy();
      else chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!verifyWebhook(secret, req.headers, raw)) {
        res.writeHead(401).end();
        return;
      }
      const id = req.headers['webhook-id'];
      res.writeHead(204).end();          // answer first...
      if (seen.has(id)) return;          // ...and ignore a message handled before
      seen.add(id);
      onEvent(JSON.parse(raw));          // ...then do the work
    });
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const secret = process.env.LEGACYAI_WEBHOOK_SECRET;
  if (!secret) {
    console.error('Set LEGACYAI_WEBHOOK_SECRET to the signing secret shown when the endpoint was made.');
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 8787);
  createServer(createReceiver(secret, (event) => console.log(JSON.stringify({ type: event.type, id: event.id, data: event.data }))))
    .listen(port, '127.0.0.1', () => console.log(`listening on http://127.0.0.1:${port}`));
}
