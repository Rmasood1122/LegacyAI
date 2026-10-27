# Your company's own key: what it locks, and what happens when you switch it off

*For customers. Last checked against the product on 2026-10-27 (decision D41). Every statement here describes what
the product does today; where something was not tested, it says so.*

## In short

You can keep your company's content locked with a key that you hold, in your own Google Cloud KMS. LegacyAI never
receives that key. If you switch it off, nobody here can open your content - not the support team, not the platform
operator - until you switch it on again. If you destroy it, your content cannot be opened by anyone, ever again,
including from backups.

## What your key locks

- your documents: their text, the copies used for search, and their titles;
- your knowledge: every item's title and text (every version), interview questions and answers, the questions people
  ask and the questions sent to experts, comments on answers, readiness questions and answers, scenarios, topic names
  and descriptions;
- the secrets kept for your company: authenticator-app setup, webhook signing secrets, your single sign-on secret.

Companies that do not bring a key have the same content locked too, with a key of their own that is protected by
LegacyAI's platform key.

## What it does not lock

Said plainly, because it matters:

- **What things are, not what they say:** how many documents you have and how large they are, their labels, who
  added or changed what and when, and the audit log. These are needed to run the service and decide who may see what.
- **People and cards:** names, roles and card details are not locked with your key.
- **While a question is being answered,** the service holds the opened content it needs in memory, for at most 5
  minutes. A compromised running service could see it during that time.
- **Offline copies on devices:** a person may keep a copy of verified, low-level knowledge (levels 0 and 1) on their
  device, to read without a connection for up to 7 days. That copy is locked with a key made on the device, not with
  your key. A copy already on a device stays readable until its 7 days are over, even if you switch your key off in
  the meantime (while your key is off, no new copy can be taken). A copy is removed when its card signs out or is no
  longer signed in while the device is connected.
- **The AI model:** when an answer is written with an AI model, the question and the pieces of your content used to
  answer it are sent to the model provider in readable form. (Today no paid AI model is switched on.)

## Switching your key off

- Within **5 minutes**, every screen that needs your content says: *"The company's own encryption key cannot be used
  right now."* Nothing is shown, nothing new can be added, and nothing is locked with another key instead.
- Sign-in with a passkey keeps working. Sign-in with an authenticator app, single sign-on and webhooks stop until the
  key is back.
- Nothing is deleted. When you switch the key on again, everything works again at once.

## Changing your key, or going back to none

New content is locked with the new key straight away. Content locked before is moved to the new key by LegacyAI's
housekeeping, a little at a time. **Keep your old key switched on until LegacyAI confirms nothing is left on it.**
Before you retire it, set up authenticator apps again (or use passkeys), and rotate webhook and single sign-on
secrets: those are not moved for you.

## Destroying your key

- Google keeps a destroyed key version for **30 days** by default; during that time you can restore it and
  everything comes back ([Google's documentation](https://cloud.google.com/kms/docs/destroy-restore), read
  2026-10-27).
- After that, everything locked with it is gone for good, in the live service and in every backup. LegacyAI cannot
  bring it back.
- What is not locked (see above) stays until you ask LegacyAI to delete your company.

## What was tested

Automated tests with stand-in keys (never a real key or account) show that with the key switched off nothing of the
content opens and nothing new is added; that after a change of key the content moves to the new key and still opens
with the old key switched off; and that the screens then say the key cannot be used. **Not tested:** a real Google
Cloud KMS key, and opening restored content from a real backup (designed to work while the key works; not proven
end to end).
