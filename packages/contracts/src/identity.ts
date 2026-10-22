export const IDENTITY_DENIED = 'identity_denied' as const;

export interface PasskeyCredential {
  readonly credentialId: string;
  readonly subjectId: string;
  readonly publicKey: string;
  readonly signCount: number;
  readonly revoked: boolean;
}

export interface VerifiedPasskeyAssertion {
  readonly credentialId: string;
  readonly challenge: string;
  readonly origin: string;
  readonly relyingPartyId: string;
  readonly signCount: number;
  readonly userVerified: boolean;
}

export type PasskeyAssertionVerifier = (
  assertion: unknown,
  credential: PasskeyCredential,
) => Promise<VerifiedPasskeyAssertion | null>;

export interface IdentityStore {
  getCredential(credentialId: string): Promise<PasskeyCredential | null>;
  saveCredential(credential: PasskeyCredential): Promise<void>;
}

export interface IdentityOptions {
  readonly store: IdentityStore;
  readonly verifyAssertion: PasskeyAssertionVerifier;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
  readonly challengeLifetimeMs?: number;
  readonly sessionLifetimeMs?: number;
}

export interface PasskeyChallenge {
  readonly challengeId: string;
  readonly challenge: string;
  readonly expiresAt: number;
}

export interface IdentitySession {
  readonly sessionId: string;
  readonly subjectId: string;
  readonly authenticationLevel: 'mfa';
  readonly authenticatedAt: number;
  readonly expiresAt: number;
}

export type IdentityResult<T> =
  | {readonly accepted: true; readonly value: T}
  | {readonly accepted: false; readonly code: typeof IDENTITY_DENIED};

interface PendingChallenge {
  readonly challenge: string;
  readonly origin: string;
  readonly relyingPartyId: string;
  readonly expiresAt: number;
}

const DEFAULT_CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

function isSecureOrigin(origin: string): boolean {
  try {
    return new URL(origin).protocol === 'https:';
  } catch {
    return false;
  }
}

export class IdentitySessions {
  private readonly options: IdentityOptions;
  private readonly challenges = new Map<string, PendingChallenge>();
  private readonly sessions = new Map<string, IdentitySession>();
  private readonly revokedSubjects = new Set<string>();
  private readonly challengeLifetimeMs: number;
  private readonly sessionLifetimeMs: number;

  constructor(options: IdentityOptions) {
    this.options = options;
    this.challengeLifetimeMs = options.challengeLifetimeMs ?? DEFAULT_CHALLENGE_LIFETIME_MS;
    this.sessionLifetimeMs = options.sessionLifetimeMs ?? DEFAULT_SESSION_LIFETIME_MS;
    if (this.challengeLifetimeMs <= 0 || this.sessionLifetimeMs <= 0) {
      throw new TypeError('identity lifetimes must be positive');
    }
  }

  beginPasskeyAuthentication(origin: string, relyingPartyId: string): IdentityResult<PasskeyChallenge> {
    if (!isSecureOrigin(origin) || relyingPartyId.length === 0) return this.denied();
    const challengeId = this.options.createOpaqueId();
    const challenge = this.options.createOpaqueId();
    if (!challengeId || !challenge || challengeId === challenge) return this.denied();
    const expiresAt = this.options.now() + this.challengeLifetimeMs;
    this.challenges.set(challengeId, {challenge, origin, relyingPartyId, expiresAt});
    return {accepted: true, value: {challengeId, challenge, expiresAt}};
  }

  async completePasskeyAuthentication(
    challengeId: string,
    credentialId: string,
    assertion: unknown,
  ): Promise<IdentityResult<IdentitySession>> {
    const pending = this.challenges.get(challengeId);
    this.challenges.delete(challengeId);
    if (!pending || pending.expiresAt <= this.options.now()) return this.denied();

    const credential = await this.options.store.getCredential(credentialId);
    if (!credential || credential.revoked || this.revokedSubjects.has(credential.subjectId)) {
      return this.denied();
    }
    const verified = await this.options.verifyAssertion(assertion, credential);
    if (
      !verified ||
      !verified.userVerified ||
      verified.credentialId !== credential.credentialId ||
      verified.challenge !== pending.challenge ||
      verified.origin !== pending.origin ||
      verified.relyingPartyId !== pending.relyingPartyId ||
      verified.signCount <= credential.signCount
    ) {
      return this.denied();
    }

    await this.options.store.saveCredential({...credential, signCount: verified.signCount});
    const authenticatedAt = this.options.now();
    const session: IdentitySession = {
      sessionId: this.options.createOpaqueId(),
      subjectId: credential.subjectId,
      authenticationLevel: 'mfa',
      authenticatedAt,
      expiresAt: authenticatedAt + this.sessionLifetimeMs,
    };
    if (!session.sessionId) return this.denied();
    this.sessions.set(session.sessionId, session);
    return {accepted: true, value: session};
  }

  validateSession(sessionId: string): IdentityResult<IdentitySession> {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      session.expiresAt <= this.options.now() ||
      this.revokedSubjects.has(session.subjectId)
    ) {
      this.sessions.delete(sessionId);
      return this.denied();
    }
    return {accepted: true, value: session};
  }

  revokeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  revokeSubject(subjectId: string): void {
    this.revokedSubjects.add(subjectId);
    for (const [sessionId, session] of this.sessions) {
      if (session.subjectId === subjectId) this.sessions.delete(sessionId);
    }
  }

  private denied<T>(): IdentityResult<T> {
    return {accepted: false, code: IDENTITY_DENIED};
  }
}
