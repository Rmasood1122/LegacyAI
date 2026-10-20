# Example webhook receiver

The "one example connector" of feature 28 (`docs/phase4/06-open-api-webhooks-email.md`): a small Node.js program,
with no package to install, that receives LegacyAI webhooks and checks them properly.

## What LegacyAI sends

A `POST` with a JSON body, signed in the open [Standard Webhooks](https://www.standardwebhooks.com) format:

| Header | Meaning |
|---|---|
| `webhook-id` | The event's id. The same on every retry: ignore an id you have already handled. |
| `webhook-timestamp` | Seconds since 1970 when this attempt was signed. Refuse a message more than 5 minutes off. |
| `webhook-signature` | `v1,` + base64 of HMAC-SHA256 over `<id>.<timestamp>.<raw body>`, keyed with the bytes after `whsec_` in your secret. |

The body:

```json
{ "id": "…", "type": "knowledge.item_released", "created_at": "…", "company_id": "…",
  "data": { "item_id": "…", "status": "verified", "department_id": null, "sensitivity": 1, "previous_sensitivity": 1 } }
```

Types: `knowledge.item_released`, `knowledge.item_changed`, `knowledge.item_withdrawn`, and `webhook.test` (the
"send a test message" button). A message never contains a title or a text: read the item with an API key if you
need it.

Answer with any 2xx within 5 seconds. Anything else (a redirect too) counts as a failure and is retried after
1 minute, 5 minutes, 30 minutes, 2, 6, 12 and 24 hours (8 attempts). An endpoint that keeps failing for more than a
day is paused and the company's Owners are told.

## Run it

```bash
LEGACYAI_WEBHOOK_SECRET=whsec_… node receiver.mjs
```

It listens on `http://127.0.0.1:8787`. LegacyAI sends only to `https` addresses on the public internet, so put it
behind a web server or tunnel that terminates TLS. The API's tests check that this receiver accepts what LegacyAI
sends and refuses a changed, re-signed or old message (`services/api/test/unit/webhooks.test.ts`).
