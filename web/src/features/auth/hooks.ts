// Sign-in and first-time set-up: the calls, without any markup.
import { useApiMutation } from '../../api/context.tsx';

export const useLoginBegin = () => useApiMutation('loginBegin');
export const useLoginVerify = () => useApiMutation('loginVerify');
export const useEnrollmentBegin = () => useApiMutation('enrollmentBegin');
export const useEnrollmentComplete = () => useApiMutation('enrollmentComplete');
export const useSsoStart = () => useApiMutation('ssoStart');
export const useSsoFinish = () => useApiMutation('ssoFinish');

/** Leaving for the company's identity provider. A prop of the screens, so that tests can see where they would go. */
export type GoTo = (url: string) => void;
export const goToProvider: GoTo = (url) => window.location.assign(url);

/** Keeps digits only, at most `length` of them (codes are typed, pasted, or read aloud with spaces). */
export const keepDigits = (value: string, length: number): string => value.replace(/\D+/g, '').slice(0, length);
