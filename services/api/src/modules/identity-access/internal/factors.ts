// Strong factors: passkeys (WebAuthn) and authenticator-app codes (TOTP).
// The cryptography is done by vetted libraries (@simplewebauthn/server, otplib, node:crypto).
// This file only wires them together and decides what counts as proof.
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { generateKeyPairSync, randomBytes, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { generateSecret, generateURI, verify as totpVerify } from 'otplib';
import type { SealingCipher } from '../../platform/index.ts';

const MINT = Symbol('StrongFactorProof');

/**
 * Proof that a strong factor belonging to `cardId` was verified just now.
 * The ONLY code that can create one is verifyPasskeyAssertion / verifyTotpCode /
 * the enrollment verifiers in this file (the mint key never leaves the file).
 */
export class StrongFactorProof {
  readonly cardId: string;
  readonly credentialId: string;
  readonly factorType: FactorType;
  constructor(key: symbol, cardId: string, credentialId: string, factorType: FactorType) {
    if (key !== MINT) throw new Error('StrongFactorProof can only be created by verifying a passkey or TOTP code');
    this.cardId = cardId;
    this.credentialId = credentialId;
    this.factorType = factorType;
    Object.freeze(this);
  }
}

/** passkey and authenticator app since Phase 1; 'sso' = a sign-in at the company's identity provider (D33). */
export type FactorType = 'passkey' | 'totp' | 'sso';

export interface StoredCredential {
  id: string;
  card_id: string;
  type: FactorType;
  webauthn_credential_id: string | null;
  webauthn_public_key: Buffer | null;
  webauthn_sign_count: string | null;
  webauthn_transports: string[] | null;
  totp_secret_enc: Buffer | null;
  totp_key_id: string | null;
  sso_connection_id: string | null;
  sso_subject: string | null;
}

/** An identity the company's provider vouched for during THIS sign-in (oidc.ts verified its ID token). */
export interface SsoIdentity {
  tenantId: string;
  connectionId: string;
  subject: string;
}

/**
 * The SSO factor: the provider signed this person in during this very sign-in, and that identity is linked to THIS
 * card through the company's current connection. A sign-in at another company's provider, through a removed
 * connection, or as another identity, proves nothing. Constant work does not matter here: nothing secret is compared.
 */
export function verifySsoFactor(p: { tenantId: string; cardId: string | null; credentials: readonly StoredCredential[]; identity: SsoIdentity | null }): StrongFactorProof | null {
  if (p.cardId === null || p.identity === null || p.identity.tenantId !== p.tenantId) return null;
  const { connectionId, subject } = p.identity;
  const match = p.credentials.find((c) => c.type === 'sso' && c.card_id === p.cardId && c.sso_connection_id === connectionId && c.sso_subject === subject);
  return match === undefined ? null : new StrongFactorProof(MINT, p.cardId, match.id, 'sso');
}

export interface WebAuthnSettings {
  rpId: string;
  rpName: string;
  origins: string[];
}

// ------------------------------------------------------------- TOTP seed at rest

/** AES-256-GCM with the credential keyring. The class lives in the platform module (webhook secrets use it too). */
export { SealingCipher as SeedCipher } from '../../platform/index.ts';
type SeedCipher = SealingCipher;

// ------------------------------------------------------------------------ passkeys

export async function passkeyLoginOptions(webauthn: WebAuthnSettings): Promise<{ options: Record<string, unknown>; challenge: string }> {
  // Empty allowCredentials on purpose: the response must not reveal whether the card
  // exists or which factors it has. Passkeys are "discoverable", so none is needed.
  const options = await generateAuthenticationOptions({ rpID: webauthn.rpId, allowCredentials: [], userVerification: 'required' });
  return { options: options as unknown as Record<string, unknown>, challenge: options.challenge };
}

let dummyKey: KeyObject | null = null;
/** Burns roughly the cost of one signature check, for paths where there is nothing real to verify. */
function dummySignatureCheck(): void {
  dummyKey ??= generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey;
  try {
    cryptoVerify('sha256', randomBytes(64), dummyKey, randomBytes(70));
  } catch {
    // result is irrelevant
  }
}

export async function verifyPasskeyAssertion(p: {
  webauthn: WebAuthnSettings;
  cardId: string | null;
  credentials: readonly StoredCredential[];
  assertion: unknown;
  expectedChallenge: string;
}): Promise<{ proof: StrongFactorProof; newSignCount: number } | null> {
  const response = p.assertion as { id?: unknown } | null;
  const credential =
    p.cardId !== null && response !== null && typeof response === 'object' && typeof response.id === 'string'
      ? p.credentials.find((c) => c.type === 'passkey' && c.webauthn_credential_id === response.id && c.card_id === p.cardId)
      : undefined;
  if (!credential || !credential.webauthn_public_key || !credential.webauthn_credential_id || p.cardId === null) {
    dummySignatureCheck();
    return null;
  }
  try {
    const result = await verifyAuthenticationResponse({
      response: p.assertion as Parameters<typeof verifyAuthenticationResponse>[0]['response'],
      expectedChallenge: p.expectedChallenge,
      expectedOrigin: p.webauthn.origins,
      expectedRPID: p.webauthn.rpId,
      requireUserVerification: true,
      credential: {
        id: credential.webauthn_credential_id,
        publicKey: new Uint8Array(credential.webauthn_public_key),
        counter: Number(credential.webauthn_sign_count ?? 0),
        transports: (credential.webauthn_transports ?? undefined) as never,
      },
    });
    if (result.verified !== true) return null;
    return {
      proof: new StrongFactorProof(MINT, p.cardId, credential.id, 'passkey'),
      newSignCount: result.authenticationInfo.newCounter,
    };
  } catch {
    return null; // malformed assertion, wrong origin, bad signature, counter rollback, ...
  }
}

export async function passkeyRegistrationOptions(p: {
  webauthn: WebAuthnSettings; cardId: string; maskedCardNumber: string; existingCredentialIds: string[];
}): Promise<{ options: Record<string, unknown>; challenge: string }> {
  const options = await generateRegistrationOptions({
    rpName: p.webauthn.rpName,
    rpID: p.webauthn.rpId,
    userID: new TextEncoder().encode(p.cardId),
    userName: p.maskedCardNumber, // no personal data goes into the authenticator
    userDisplayName: p.maskedCardNumber,
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: p.existingCredentialIds.map((id) => ({ id })),
  });
  return { options: options as unknown as Record<string, unknown>, challenge: options.challenge };
}

export interface NewPasskey {
  credentialId: string;
  publicKey: Buffer;
  signCount: number;
  transports: string[];
}

export async function verifyPasskeyRegistration(p: {
  webauthn: WebAuthnSettings; attestation: unknown; expectedChallenge: string;
}): Promise<NewPasskey | null> {
  try {
    const result = await verifyRegistrationResponse({
      response: p.attestation as Parameters<typeof verifyRegistrationResponse>[0]['response'],
      expectedChallenge: p.expectedChallenge,
      expectedOrigin: p.webauthn.origins,
      expectedRPID: p.webauthn.rpId,
      requireUserVerification: true,
    });
    if (result.verified !== true || !result.registrationInfo) return null;
    const { credential } = result.registrationInfo;
    return {
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey),
      signCount: credential.counter,
      transports: (credential.transports ?? []) as string[],
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------- TOTP

const TOTP_PERIOD = 30;

export function newTotpSecret(issuer: string, label: string): { secret: string; uri: string } {
  const secret = generateSecret();
  return { secret, uri: generateURI({ issuer, label, secret }) };
}

/** Checks a code against one secret. One period of tolerance each way; codes cannot be replayed. */
async function checkTotp(secret: string, code: string, now: Date, afterTimeStep: number | null): Promise<number | null> {
  try {
    const result = await totpVerify({
      secret, token: code, epoch: Math.floor(now.getTime() / 1000), epochTolerance: TOTP_PERIOD,
      ...(afterTimeStep === null ? {} : { afterTimeStep }),
    });
    if (result.valid !== true) return null;
    const step = (result as { timeStep?: unknown }).timeStep;
    return typeof step === 'number' ? step : Math.floor(now.getTime() / 1000 / TOTP_PERIOD);
  } catch {
    return null;
  }
}

const DUMMY_TOTP_SECRET = generateSecret();

export async function verifyTotpCode(p: {
  cipher: SeedCipher;
  aad: string;
  cardId: string | null;
  credentials: readonly StoredCredential[];
  code: string;
  now: Date;
  lastStep: number | null;
}): Promise<{ proof: StrongFactorProof; step: number } | null> {
  const candidates = p.cardId === null ? [] : p.credentials.filter((c) => c.type === 'totp' && c.card_id === p.cardId);
  if (p.cardId === null || candidates.length === 0) {
    await checkTotp(DUMMY_TOTP_SECRET, p.code, p.now, null);
    return null;
  }
  for (const c of candidates) {
    if (!c.totp_secret_enc || !c.totp_key_id) continue;
    const secret = p.cipher.decrypt(c.totp_secret_enc, c.totp_key_id, p.aad);
    if (secret === null) continue;
    const step = await checkTotp(secret, p.code, p.now, p.lastStep);
    if (step !== null) return { proof: new StrongFactorProof(MINT, p.cardId, c.id, 'totp'), step };
  }
  return null;
}

/** Enrollment: confirms the user's app produces a valid code for the pending secret. */
export async function verifyTotpEnrollment(secret: string, code: string, now: Date): Promise<number | null> {
  return checkTotp(secret, code, now, null);
}
