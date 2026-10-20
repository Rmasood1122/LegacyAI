// What each notice says by e-mail, and who receives it. Plain text only, fixed wording, no link: a notice says THAT
// something happened and where to look (the LegacyAI screens), never a code, a key, a card number, a name, an amount
// or anything a company wrote. So an e-mail that is read by the wrong person, or kept forever in a mailbox, gives
// away nothing a stranger could use.
//
// Every notice type must have an entry (the compiler enforces it): a new kind of notice cannot be added without
// deciding what it says and to whom.
import type { NotificationEvent } from '../../platform/index.ts';

export type NoticeType = NotificationEvent['type'];

/**
 * holder  - the person who holds the card the notice is about (`cardId`), or the card named in `recipientCardId`;
 * owners  - the company's Owners (active Owner cards of people who have not left);
 * both    - the holder and the Owners.
 * A notice addressed to the company's Owners (`audience: 'owners'`) goes to the Owners whatever the table says.
 */
export type Audience = 'holder' | 'owners' | 'both';

export interface Template { audience: Audience; subject: string; text: string }

const FOOTER = '\n\nThis message was sent by LegacyAI. It contains no codes or links; sign in to LegacyAI as usual to see details.';

export const TEMPLATES: Readonly<Record<NoticeType, Template>> = {
  card_issued: { audience: 'holder', subject: 'A LegacyAI card was issued to you', text: 'A LegacyAI card was issued to you. Your company will give you what you need to activate it.' },
  card_locked: { audience: 'both', subject: 'A LegacyAI card was locked', text: 'A LegacyAI card was locked to protect it (too many wrong attempts, or unusual activity). An administrator of your company can unlock it.' },
  card_unlocked: { audience: 'holder', subject: 'Your LegacyAI card was unlocked', text: 'Your LegacyAI card was unlocked and can be used again.' },
  card_suspended: { audience: 'holder', subject: 'Your LegacyAI card was suspended', text: 'Your LegacyAI card was suspended by your company. Ask an administrator of your company if you do not know why.' },
  card_revoked: { audience: 'holder', subject: 'Your LegacyAI card was revoked', text: 'Your LegacyAI card was revoked by your company and can no longer be used.' },
  card_renewed: { audience: 'holder', subject: 'Your LegacyAI card was renewed', text: 'Your LegacyAI card was renewed.' },
  card_replaced: { audience: 'holder', subject: 'Your LegacyAI card was replaced', text: 'Your LegacyAI card was replaced by a new card. The old card no longer works.' },
  card_expiring: { audience: 'holder', subject: 'Your LegacyAI card expires soon', text: 'Your LegacyAI card expires soon. Ask an administrator of your company to renew it.' },
  unlock_capacity_low: { audience: 'owners', subject: 'Few people in your company can unlock LegacyAI cards', text: 'Few people in your company are left who can unlock LegacyAI cards. Consider giving the role to another person.' },
  credential_added: { audience: 'holder', subject: 'A sign-in method was added to your LegacyAI card', text: 'A new sign-in method (a passkey or an authenticator app) was added to your LegacyAI card. If this was not you, tell an administrator of your company at once.' },
  enrollment_token_issued: { audience: 'holder', subject: 'Your LegacyAI card is ready to be set up', text: 'Your company prepared your LegacyAI card for setting up a sign-in method. Your company gives you the set-up details separately.' },
  tenant_created: { audience: 'owners', subject: 'Your company was set up in LegacyAI', text: 'Your company was set up in LegacyAI.' },
  company_card_renewed: { audience: 'owners', subject: 'Your company\'s LegacyAI term was renewed', text: 'Your company\'s LegacyAI term was renewed.' },
  owner_recovered: { audience: 'holder', subject: 'An Owner card of your company was recovered', text: 'An Owner card of your company was recovered by the platform operator. If you did not expect this, contact the operator.' },
  card_anomaly: { audience: 'owners', subject: 'Unusual activity on an Owner card', text: 'An Owner card of your company showed unusual activity. It was not locked, because it is the last Owner card that can act. Please check the card\'s recent activity.' },
  retirement_nudge: { audience: 'owners', subject: 'Someone\'s leaving date is coming closer', text: 'A recorded leaving date in your company is coming closer. The retirement radar in LegacyAI shows what knowledge to capture first.' },
  renewal_reminder: { audience: 'owners', subject: 'Your LegacyAI renewal date is coming closer', text: 'Your company\'s LegacyAI renewal date is coming closer. The billing screen shows what is due.' },
  payment_failed: { audience: 'owners', subject: 'A LegacyAI payment did not go through', text: 'A payment for your company\'s LegacyAI subscription did not go through. The billing screen shows what is due.' },
  subscription_renewed: { audience: 'owners', subject: 'Your LegacyAI subscription was renewed', text: 'Your company\'s LegacyAI subscription was renewed.' },
  payment_needs_attention: { audience: 'owners', subject: 'A LegacyAI payment needs attention', text: 'A payment is on record that did not take effect by itself. The platform operator will look at it; the billing screen shows its state.' },
  api_key_created: { audience: 'owners', subject: 'A LegacyAI API key was made', text: 'An API key was made for your company. The API keys screen shows who made it. If nobody in your company expected this, revoke it there.' },
  api_key_stopped: { audience: 'owners', subject: 'LegacyAI API keys were stopped', text: 'One or more API keys of your company were stopped by the system (a change to the card that made them, or unusual activity). Integrations using them stop working until a new key is made.' },
  api_key_wrong_secrets: { audience: 'owners', subject: 'Wrong secrets were tried against a LegacyAI API key', text: 'Many wrong secrets were tried against one of your company\'s API keys. The key keeps working. The API keys screen shows which key.' },
  webhook_paused: { audience: 'owners', subject: 'A LegacyAI webhook endpoint was paused', text: 'Deliveries to one of your company\'s webhook endpoints kept failing for more than a day, so the endpoint was paused. Nothing is sent to it until an Owner switches it on again on the webhooks screen.' },
};

export function render(type: NoticeType): { subject: string; text: string } {
  const t = TEMPLATES[type];
  return { subject: t.subject, text: t.text + FOOTER };
}

export function isNoticeType(value: string): value is NoticeType {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, value);
}
