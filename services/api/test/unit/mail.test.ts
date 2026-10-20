// E-mail of notices (docs/phase4/06, part C): the rules that need no database - what each notice says and to whom,
// that no text can carry a secret or a link, which addresses can be handed to a sender, retries, configuration.
// Queuing, recipients from real records and sending are in test/integration/mail.test.ts.
import { describe, expect, it } from 'vitest';
import {
  FakeMailSender, isSendableAddress, MAIL_LIMITS, nextMailAttemptAt, recipientsOf, render, TEMPLATES, type NoticeType, type RecipientDirectory,
} from '../../src/modules/mail/index.ts';
import { ConfigError, loadConfig, type Tx } from '../../src/modules/platform/index.ts';
import { testEnv } from '../helpers/env.ts';

describe('what a notice says', () => {
  const types = Object.keys(TEMPLATES) as NoticeType[];

  it('every notice type has a text (the compiler also refuses a type without one)', () => {
    expect(types.length).toBeGreaterThanOrEqual(24);
    for (const type of types) {
      const { subject, text } = render(type);
      expect(subject.length, type).toBeGreaterThan(10);
      expect(subject.length, type).toBeLessThanOrEqual(100);
      expect(text.length, type).toBeGreaterThan(30);
    }
  });

  it('no text can carry a secret, a number, a link or a placeholder: the wording is fixed', () => {
    for (const type of types) {
      const { subject, text } = render(type);
      for (const part of [subject, text]) {
        expect(part, type).not.toMatch(/\d/);                 // no card number, code, amount or date
        expect(part, type).not.toMatch(/https?:|www\.|@/);   // no link, no address
        expect(part, type).not.toMatch(/[{}<>$%]/);          // no placeholder that could be filled with data
        expect(part, type).not.toMatch(/[\r]/);
      }
      expect(subject, type).not.toMatch(/\n/);               // a subject is one line
    }
  });
});

describe('who receives a notice', () => {
  const directory: RecipientDirectory = {
    holderOf: async (_tx, _tenant, cardId) => ({ 'card-a': 'person-a', 'card-b': 'person-b' } as Record<string, string>)[cardId] ?? null,
    owners: async () => ['owner-1', 'owner-2'],
    addressOf: async () => null,
  };
  const tx = {} as Tx;
  const notice = (type: string, over: Record<string, string | null> = {}): { id: string; type: string; card_id: string | null; recipient_card_id: string | null; audience: string | null } =>
    ({ id: 'n', type, card_id: null, recipient_card_id: null, audience: null, ...over });

  it('a notice about a card goes to its holder', async () => {
    expect(await recipientsOf(tx, 't', notice('card_revoked', { card_id: 'card-a' }), directory)).toEqual(['person-a']);
  });
  it('... to another card\'s holder when the notice names one', async () => {
    expect(await recipientsOf(tx, 't', notice('owner_recovered', { card_id: 'card-a', recipient_card_id: 'card-b' }), directory)).toEqual(['person-b']);
  });
  it('a company notice goes to the Owners', async () => {
    expect(await recipientsOf(tx, 't', notice('renewal_reminder'), directory)).toEqual(['owner-1', 'owner-2']);
    expect(await recipientsOf(tx, 't', notice('retirement_nudge'), directory)).toEqual(['owner-1', 'owner-2']);
  });
  it('a lock goes to the holder AND the Owners, each once', async () => {
    const both: RecipientDirectory = { ...directory, owners: async () => ['owner-1', 'person-a'] };
    expect(await recipientsOf(tx, 't', notice('card_locked', { card_id: 'card-a' }), both)).toEqual(['owner-1', 'person-a']);
  });
  it('a notice addressed to the Owners goes to the Owners, whatever its type', async () => {
    expect(await recipientsOf(tx, 't', notice('api_key_stopped', { card_id: 'card-a', audience: 'owners' }), directory)).toEqual(['owner-1', 'owner-2']);
  });
  it('a card that does not exist (a request that was rolled back) and an unknown type: nobody', async () => {
    expect(await recipientsOf(tx, 't', notice('card_issued', { card_id: 'no-such-card' }), directory)).toEqual([]);
    expect(await recipientsOf(tx, 't', notice('not_a_notice', { card_id: 'card-a' }), directory)).toEqual([]);
  });
});

describe('sending', () => {
  it.each([
    ['ann.lee@example.com', true], ['a+tag@sub.example.co.uk', true],
    ['no-at-sign.example.com', false], ['two@@example.com', false], ['spaces in@example.com', false], ['name@localhost', false],
    ['x@example.com\r\nBcc: victim@example.com', false], ['<x@example.com>', false], [`${'a'.repeat(250)}@example.com`, false],
  ])('%s can be handed to a sender: %s', (address, expected) => {
    expect(isSendableAddress(address)).toBe(expected);
  });

  it('the stand-in sends nothing: it keeps what it was given, and fails when told to', async () => {
    const fake = new FakeMailSender();
    fake.failNext('unavailable');
    const message = { id: 'n.p', from: 'LegacyAI <no-reply@example.test>', to: 'a@example.test', subject: 's', text: 't' };
    expect(await fake.send(message)).toEqual({ ok: false, error: 'unavailable' });
    expect(await fake.send(message)).toEqual({ ok: true });
    expect(fake.sent).toEqual([message]);
  });

  it('a message that could not be sent is tried after 5 min, 30 min, 2 h and 12 h, then given up', () => {
    const now = new Date('2026-10-06T00:00:00Z');
    const waits = [1, 2, 3, 4].map((n) => ((nextMailAttemptAt(n, now) as Date).getTime() - now.getTime()) / 60_000);
    expect(waits).toEqual([5, 30, 120, 720]);
    expect(nextMailAttemptAt(MAIL_LIMITS.maxAttempts, now)).toBeNull();
  });
});

describe('configuration', () => {
  it('no e-mail by default; the stand-in only where tests run; the sender line is one line', () => {
    expect(loadConfig(testEnv()).mail.sender).toBe('none');
    expect(loadConfig(testEnv({ MAIL_SENDER: 'fake' })).mail.sender).toBe('fake');
    expect(() => loadConfig(testEnv({ MAIL_SENDER: 'fake', NODE_ENV: 'development' }))).toThrow(/MAIL_SENDER=fake/);
    expect(() => loadConfig(testEnv({ MAIL_SENDER: 'smtp' }))).toThrow(ConfigError);
    expect(() => loadConfig(testEnv({ MAIL_FROM: 'LegacyAI <a@example.test>\r\nBcc: x@example.test' }))).toThrow(/MAIL_FROM/);
  });
});
