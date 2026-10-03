// People, departments and cards: reading and changing them, without any markup.
import { useActivePeople, useApiList, useApiMutation, useApiQuery } from '../../api/context.tsx';
import type { Card, OperationTypes, Restriction } from '../../api/generated.ts';
import type { BadgeTone } from '../../ui/index.tsx';

const PEOPLE_CHANGED = ['listPeople', 'getPerson'] as const;
const CARD_CHANGED = ['listCards', 'getCard', 'listCardEvents', 'listCardRoles', 'getCardRestrictions'] as const;

export type PersonStatus = 'active' | 'departed';
export const usePeopleList = (status: PersonStatus) => useApiList('listPeople', { query: { status, limit: 50 } });
export const useCreatePerson = () => useApiMutation('createPerson', PEOPLE_CHANGED);
export const useUpdatePerson = () => useApiMutation('updatePerson', PEOPLE_CHANGED);
export const useDepartments = ({ enabled = true }: { enabled?: boolean } = {}) => useApiQuery('listDepartments', undefined, { enabled });
export const useCreateDepartment = () => useApiMutation('createDepartment', ['listDepartments']);

export type CardState = NonNullable<NonNullable<OperationTypes['listCards']['query']>['state']>;
export const CARD_STATES: readonly CardState[] = ['issued', 'active', 'suspended', 'revoked', 'expired', 'replaced'];
export const useCardList = (state: CardState | '') => useApiList('listCards', { query: { limit: 50, ...(state === '' ? {} : { state }) } });
export const useCard = (cardId: string) => useApiQuery('getCard', { path: { card_id: cardId } });
export const useRoles = ({ enabled = true }: { enabled?: boolean } = {}) => useApiQuery('listRoles', undefined, { enabled });
export const useIssueCard = () => useApiMutation('issueCard', CARD_CHANGED);
export const useSuspendCard = () => useApiMutation('suspendCard', CARD_CHANGED);
export const useReinstateCard = () => useApiMutation('reinstateCard', CARD_CHANGED);
export const useRevokeCard = () => useApiMutation('revokeCard', CARD_CHANGED);
export const useReplaceCard = () => useApiMutation('replaceCard', CARD_CHANGED);
export const useRenewCard = () => useApiMutation('renewCard', CARD_CHANGED);
export const useUnlockCard = () => useApiMutation('unlockCard', CARD_CHANGED);
export const useNewEnrollmentToken = () => useApiMutation('issueEnrollmentToken', CARD_CHANGED);
export const useAssignRole = () => useApiMutation('assignCardRole', CARD_CHANGED);
export const useRemoveRole = () => useApiMutation('removeCardRole', CARD_CHANGED);
export const useCardRestrictions = (cardId: string, { enabled }: { enabled: boolean }) => useApiQuery('getCardRestrictions', { path: { card_id: cardId } }, { enabled });
export const useSaveRestrictions = () => useApiMutation('putCardRestrictions', CARD_CHANGED);
export const useCardEvents = (cardId: string, { enabled }: { enabled: boolean }) => useApiList('listCardEvents', { path: { card_id: cardId }, query: { limit: 25 } }, { enabled });
/** People a card can be issued to. */
export const useCardHolders = useActivePeople;

export const CARD_STATE_TEXT: Readonly<Record<Card['state'], string>> = {
  issued: 'Issued — not set up yet',
  active: 'Active',
  suspended: 'Suspended',
  revoked: 'Revoked',
  expired: 'Expired',
  replaced: 'Replaced by a new card',
};
export const cardTone = (state: Card['state']): BadgeTone =>
  state === 'active' ? 'success' : state === 'issued' ? 'info' : state === 'suspended' || state === 'expired' ? 'warning' : 'neutral';

/** One restriction in plain words. */
export function describeRestriction(r: Restriction): string {
  const off = r.enabled ? '' : ' (switched off)';
  switch (r.type) {
    case 'read_only': return `Read-only: this card cannot change anything${off}`;
    case 'usage_cap': return `At most ${r.config.max_count} ${r.config.limit_key} per ${Math.round(r.config.window_seconds / 60)} minutes${off}`;
    case 'time_window': return `Only between ${r.config.start} and ${r.config.end} (${r.config.timezone}), on days ${r.config.days.join(', ')}${off}`;
    case 'network_allowlist': return `Only from these networks: ${r.config.cidrs.join(', ')}${off}`;
  }
}

/** The same restrictions with the read-only one switched on or off (added if it was missing). */
export function withReadOnly(restrictions: readonly Restriction[], on: boolean): Restriction[] {
  const rest = restrictions.filter((r) => r.type !== 'read_only');
  return on ? [...rest, { type: 'read_only', enabled: true, config: {} }] : rest;
}
