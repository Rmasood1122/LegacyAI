# Phase 4, Batch C — prepared, not complete

Status on 2026-10-21. Batch C features cannot be finished at $0: they need money, hardware, new AI models or legal
advice (`00-plan.md`). The plan allows them to be **prepared**, meaning taken up to an interface with a stand-in
behind it, so that the missing piece is one adapter. **None of them is complete, and none may be described as
available to customers.** For two of them, preparing code would go further than they are allowed to go; those have a
written design only, and the reason is given.

| # | Feature | What is prepared | What is missing before it is real |
|---|---|---|---|
| 4 | NFC cards | The card screen writes the card's sign-in address to an NFC tag (Web NFC); a stand-in in tests | Real tags and phones; Web NFC exists only in Chrome on Android |
| 7, 25 | Voice; scanned documents (OCR) | **Wired through (2026-10-27)**: uploads of recordings and photos of a page reach the reader and go on like any document; the default reader refuses them | A speech / OCR model (cost, Gate 2) and its own measured evaluation |
| 6 | Passive capture (chats, tickets, e-mail) | **Design only** | Legal review first (the feature list says so); consent design; real accounts |
| 9 | Shadow / offline mode | **Built (2026-10-27, D42)**: the server side and the installable web app | The founder chose an installable web app, 7-day packs, verified level 0-1 only |
| 21 | Regional hosting | **Built for a separate copy per region (2026-10-28, D43)**: Terraform places a copy in one region; the API serves only its region's companies (the key part of 21: `08-bring-your-own-key.md`) | The founder applying a European copy (a second project and Neon database) |

## 4 — NFC cards (prepared)

- An NFC tag holds **exactly what the QR code holds**: the sign-in address with the card number in the fragment
  (`#card=LGY-…`). It never holds the 3-digit code, a token or a session. A phone that taps the tag opens that
  address by itself (an NDEF URL record), so nothing is needed to *read* a tag.
- On a card's screen, "Write to an NFC tag" appears where the browser has Web NFC (Chrome on Android). Elsewhere the
  screen says where it can be done. Code: `web/src/navigation/nfc.ts`, `CardScreen.tsx`.
- **Tested:** 3 screen tests with a stand-in writer (the message holds the card number only; without Web NFC there is
  no button; no message for something that is not a card number).
- **Not tested:** real tags (NTAG213/215 or similar), real phones, iPhones (no Web NFC: a tag can be read there but
  not written from the browser), tag locking (a written tag can be rewritten unless it is locked; locking is not
  offered).
- A tag is as public as a printed QR code. That is fine **because** a card number alone signs nobody in.

## 7, 25 — Voice and scanned documents (prepared)

- `services/ai/app/capture/media.py`:
  - `MediaReader` (speech → timed segments; an image → text);
  - `NoMediaReader`, the default, which refuses with `voice_not_available` / `ocr_not_available`;
  - `FakeMediaReader`, for tests only. It understands no speech and no image: it reads text that a test put after a
    marker;
  - `sniff_media`: the first bytes must match the declared type (WAV, MP3, OGG, WebM, MP4 audio; PNG, JPEG);
  - `extract_media`: the reader's text, normalised and limited exactly like a PDF's.
- **Tested:** unit tests (refusal without a reader, segments and pages, type mismatches, empty and unreadable
  results, the stand-in allowed only where tests run).
- **To switch it on (in this order):**
  1. a reader adapter (a speech or OCR model);
  2. its evaluation (word error rate on the company's own recordings and scans, written to `docs/` like
     `phase2/EVALUATION.md`);
  3. a migration widening `sources.mime`;
  4. the types in the upload operation of `openapi.yaml`;
  5. one dispatch in `ingest.process_upload` (`sniff_media` / `extract_media` for those types).

  Redaction, chunking, consent and labels then apply as to any document.

  **Steps 3 to 5 are done (2026-10-27):** migration `20261027000200_media_sources.sql` (sources.mime), the upload
  operation's types in `openapi.yaml` (and the API's body parser), the dispatch in `ingest.process_upload`, the AI
  service's setting `MEDIA_READER` (`none` by default; `fake` only when `ENVIRONMENT=test`), and the documents screen
  (accepts .wav .mp3 .ogg .webm .m4a .png .jpg; says plainly when a recording or picture cannot be read; counts a
  recording in minutes). With `MEDIA_READER=none` - the setting everywhere today - every recording and picture ends as
  failed with `voice_not_available` or `ocr_not_available`, and nothing is kept. Steps 1 and 2 (a real reader and its
  evaluation) wait for the founder's choice of a model (Gate 2). Limits that stay: at most 10 MB per file (the company
  setting is 5 MB by default, about 5 minutes of MP3). Knowledge items quoting a recording say "minute" (step 38 of
  the report).
- **Scanned PDFs** (a PDF with no text layer is refused today as `looks_like_scan`) also need the pages rendered to
  images first. That is a further library (to be checked under D2) and is not prepared.
- **Voice interviewer** (the interviewer speaking and listening) is more than transcription. It needs speech output
  and turn-taking, and nothing of that is prepared.

## 6 — Passive capture: design only, and why

Reading people's chats, tickets and e-mail is capture of communications. The feature list itself says it needs consent
design and **legal review first**. Writing the connectors before that review would build exactly what the review may
forbid. What the design asks the review to decide:

1. Whose consent: the sender's only, or every participant's (a chat has several)? Consent per channel, or per message?
2. Works councils / employee representatives (Germany and others): co-determination before any monitoring tool.
3. What is never read (private channels, HR, health, union matters), and who decides that list.
4. Retention of the raw messages: the design proposes **none**. Only redacted, chunked excerpts are kept, with the
   same consent gate as documents, and withdrawal removes them.
5. Notice to people who did not consent but appear in a thread (quoted, mentioned).

When the review allows it, the shape is: a `MessageSource` connector (pull new messages since a cursor), messages
passed through the existing consent gate, redaction and chunking as a source of kind `conversation`, and nothing kept
unredacted.

## 9 — Shadow / offline mode

**Update 2026-10-27 (decision D42):** the founder chose an installable web app (no store apps), packs that open offline
for 7 days, and only verified level-0/1 knowledge. Part 1, the server side, is built: `GET /v1/offline-pack?job_role=`
(`services/api/src/modules/knowledge-gateway/internal/routes-offline.ts`, `services/ai/app/knowledge/offline.py`).
Not signed: in a web app the pack and the code that would check a signature come from the same server over the same
connection, so a signature adds nothing a device-side attacker could not also remove; the pack is sealed on the device
instead (part 2).

**Part 2, the web app (2026-10-27):** `web/src/offline/` (the store, its IndexedDB storage, offline search),
`web/src/features/offline/` (the screen "Offline", the reader, what is shown without a connection), `web/sw/` (the
service worker), `web/public/manifest.webmanifest`.
- **Installing:** a manifest and icons; a service worker that keeps the application's own files (listed by the build)
  and never answers or keeps anything under `/v1`. The build check fails if it would.
- **On the device:** the copy is encrypted (AES-GCM, 256-bit) with a key made on the device for that copy; the browser
  keeps the key and refuses to give its bytes to any script. The card, the "as of" date and the expiry are stored
  beside it and bound to it: changing any of them makes the copy fail to open, and it is removed.
- **Opening:** only while the API cannot be reached, or for the card that took it; refused and removed from its expiry
  on; refused (kept) while the device's clock is behind its last opening. Every offline view says "as of".
- **Tested in three browser engines (2026-10-27):** everything above in Chromium, with the network switched off. In
  Firefox and WebKit (Safari's engine as Playwright builds it for Linux), in CI, the device side only - a copy on the
  device, the API unreachable, search, "as of", the clock guard, the expiry. WebKit there cannot sign in to the
  plain-http test server; Firefox's sign-in tests passed locally but Playwright's Firefox sometimes lost the first page
  load or click of a new window, so they were taken out of CI (founder's choice, 2026-10-27). Not tested: Safari itself
  on iPhone, iPad or Mac.
- **What this does not protect against**, said plainly: a person who may read the copy can copy what is shown;
  someone in control of the unlocked device and browser profile can use the browser's key the way the application
  does; a clock set back before the next opening (not behind the last one) gains that much time; a revoked card or a
  switched-off company key is not noticed on a device that stays offline, for up to 7 days; a switched-off company key
  is not noticed by a copy already on a device even when it is connected (a new copy is refused).

The design as first written:

An offline app for phones or tablets is a product of its own: its own platform builds, store accounts, device
management and updates. What the server side would need, and the questions it raises:

- an **offline pack**: verified knowledge for one job role, filtered by the card's own read rights and labels (never
  above level 1 by default), signed by the API, expiring, and sealed on the device;
- revocation: a revoked or departed card's pack must stop opening. Offline means the device cannot ask, so the pack's
  expiry is the only bound. That is a trade-off for the founder (proposed: 7 days);
- what is shown offline is not refreshed: every page must say "as of <date>";
- questions asked offline cannot use the AI service. Offline is reading and searching only.

## 21 — Regional hosting: built as a separate copy per region (2026-10-28, D43)

The founder chose one complete copy per region, and EU (Belgium) as the second region. Terraform's `home_region`
("us" or "eu") places everything a copy creates in that one region, secrets included; the guardrail check fails if
anything is placed elsewhere. The API rule is made: a copy writes its region on every company it creates, refuses to
start on a database holding another region's company, and refuses every request and sign-in for one
(`DENY_TENANT_OTHER_REGION`). Not built: moving a company between copies. Not applied: no European project or database
exists; the founder sets it up by hand (`infra/README.md`, Part F).

## What this step did not do

No paid call, no cloud resource, no real device, no legal advice. "Prepared" means what the table says, nothing more.
