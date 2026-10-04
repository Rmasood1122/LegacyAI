// Company settings, AI budget, redaction allow-list, audit log, export and consent administration:
// reading and changing them, without any markup.
import { useApiList, useApiMutation, useApiQuery } from '../../api/context.tsx';

export const useTenant = () => useApiQuery('getCurrentTenant');
export const useTenantSettings = () => useApiQuery('getTenantSettings');
export const useUpdateTenantSettings = () => useApiMutation('updateTenantSettings', ['getTenantSettings', 'listRoles']);
export const useTenantUsage = ({ enabled }: { enabled: boolean }) => useApiQuery('getTenantUsage', undefined, { enabled });
export const useKnowledgeSettings = ({ enabled }: { enabled: boolean }) => useApiQuery('getKnowledgeSettings', undefined, { enabled });
export const useUpdateKnowledgeSettings = () => useApiMutation('updateKnowledgeSettings', ['getKnowledgeSettings']);
export const useAnomalySettings = () => useApiQuery('getAnomalySettings');
export const useUpdateAnomalySettings = () => useApiMutation('updateAnomalySettings', ['getAnomalySettings']);
export const useAiBudget = ({ enabled }: { enabled: boolean }) => useApiQuery('getAiBudget', undefined, { enabled });

/** The allow-list. The API gives one page and no way to ask for the next, so the screen says when it is cut short. */
export const useAllowlist = ({ enabled }: { enabled: boolean }) => useApiQuery('listRedactionAllowlist', undefined, { enabled });
export const useAddAllowTerm = () => useApiMutation('addRedactionAllowlistTerm', ['listRedactionAllowlist']);
export const useDeleteAllowTerm = () => useApiMutation('deleteRedactionAllowlistTerm', ['listRedactionAllowlist']);

export type AuditDecision = 'allow' | 'deny' | 'event';
export const useAuditEvents = (decision: AuditDecision | '') => useApiList('listAuditEvents', { query: { limit: 50, ...(decision === '' ? {} : { decision }) } });
export const useVerifyAuditChain = () => useApiMutation('verifyAuditChain');
export const useCreateExport = () => useApiMutation('createExport');
export const useExport = (exportId: string | null) => useApiQuery('getExport', { path: { export_id: exportId ?? '' } }, { enabled: exportId !== null });

const CONSENTS_CHANGED = ['listConsents'] as const;
export const useConsentsOf = (personId: string) => useApiList('listConsents', { query: { limit: 50, ...(personId === '' ? {} : { person_id: personId }) } });
export const useHoldConsent = () => useApiMutation('holdConsent', CONSENTS_CHANGED);
export const useReleaseHold = () => useApiMutation('releaseConsentHold', CONSENTS_CHANGED);
export const useRecordWithdrawal = () => useApiMutation('recordWithdrawalForPerson', CONSENTS_CHANGED);
export const useConsentPeople = ({ enabled }: { enabled: boolean }) => useApiList('listPeople', { query: { limit: 100 } }, { enabled });

/** Millionths of a US dollar as dollars and cents. */
export const usd = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`;

/** The settings as read, when every one of their fields is also accepted by the request `R`; otherwise a compile error. */
type OnlyFieldsOf<S, R> = { [K in keyof S]: K extends keyof R ? S[K] : never };

/**
 * Only the entries of `next` that differ from `before`: the body of a PATCH, typed as the request `R`.
 * Name the request type: `changedOnly<UpdateTenantSettingsRequest, TenantSettings>(before, next)`.
 */
export function changedOnly<R extends object, S extends OnlyFieldsOf<S, R>>(before: S, next: S): Partial<R> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(next) as Array<keyof S & string>) {
    if (JSON.stringify(before[key]) !== JSON.stringify(next[key])) out[key] = next[key];
  }
  return out as Partial<R>;
}
