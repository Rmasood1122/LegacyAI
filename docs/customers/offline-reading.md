# Reading without a connection

*For customers. Written on 2026-10-27 (decision D42). Every statement describes what the product does today; where
something was not tested, it says so.*

## In short

A person can keep a copy of the verified knowledge of one job role on their phone, tablet or computer, and read and
search it without a connection for **7 days**. After 7 days the copy no longer opens; they take a new one while
connected.

## What a copy holds

- only knowledge that has been **verified** (or corrected after verification) and is not past its review date;
- only the two lowest levels: "Public inside the company" and "Internal". Restricted and confidential knowledge never
  goes into a copy, whoever takes it;
- only what that person's card may read, for the topics of the job role they chose;
- at most 500 items. The copy says when there were more.

Every page of the copy says **"As of"** the moment it was taken: corrections made since are not in it.

## What it cannot do

Offline is reading and searching only. Asking the assistant, writing, verifying and every other action need a
connection.

## How it is kept

- The copy is locked with a key made on the device for that copy. The browser keeps the key and does not give it to
  any program on the page. The copy cannot be read from the browser's storage without that key.
- Signing out removes it. When the device is connected and the card is no longer signed in, or another card signs in,
  it is removed.
- The browser may also remove it when the device runs short of space.
- Every copy taken is written in your company's audit log, with the number of items (never the content).

## Limits, said plainly

- A person who may read the copy can still copy what is on the screen.
- Someone who controls the unlocked device and its browser can open the copy as the application does.
- A device that stays offline does not learn that a card was revoked; its copy opens until its 7 days are over.
- Switching your company's own key off does not remove copies already on devices (no new copy can be taken).
- Setting the device's clock back behind the last time the copy was opened makes it refuse to open; a clock set back
  less than that cannot be told from a correct one.

## What was tested

Automated tests with stand-in data, in the engines of Chrome, Firefox and Safari:
- in Chrome's engine: taking a copy, reading and searching it with the network switched off, "as of" on every view,
  the copy refused and removed after 7 days, refused while the clock is set back, removed on signing out, and nothing
  readable in what the browser keeps;
- in Firefox's and Safari's engines (Safari's as built for testing on Linux): a copy on the device opens while
  LegacyAI cannot be reached, with "as of", is searchable, keeps nothing readable, is refused while the clock is set back
  and removed after 7 days. Signing in, taking a copy and opening the installed application with the network switched
  off are not tested there on every build (limits of the test tools).

**Not tested:** Safari itself on an iPhone, iPad or Mac, and a device removing the copy for lack of space.
