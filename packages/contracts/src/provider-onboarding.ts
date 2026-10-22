import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {ProviderOrganization} from './provider.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const PROVIDER_ONBOARDING_CONTRACT_VERSION = 1 as const;
export const PROVIDER_ONBOARDING_REJECTED = 'provider_onboarding_rejected' as const;

export interface AttestationDefinition {
  readonly key: string;
  readonly statementVersion: number;
  readonly statement: string;
  readonly validityMs?: number;
}

export interface ProviderAttestation {
  readonly key: string;
  readonly statementVersion: number;
  readonly statement: string;
  readonly affirmedAt: number;
  readonly expiresAt?: number;
}

export interface ProviderOnboardingApplication {
  readonly providerOnboardingId: string;
  readonly organizationId: string;
  readonly providerOrganizationId: string;
  readonly attestations: readonly ProviderAttestation[];
  readonly status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'withdrawn';
  readonly decisionReason?: string;
  readonly reviewedBySubjectId?: string;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly submittedAt?: number;
  readonly reviewedAt?: number;
}

export interface ProviderOnboardingStore {
  getProvider(organizationId: string, providerOrganizationId: string): Promise<ProviderOrganization | null>;
  getApplication(organizationId: string, providerOnboardingId: string): Promise<ProviderOnboardingApplication | null>;
  createApplication(application: ProviderOnboardingApplication): Promise<boolean>;
  replaceApplication(
    current: ProviderOnboardingApplication,
    replacement: ProviderOnboardingApplication,
  ): Promise<boolean>;
  approveApplication(
    currentApplication: ProviderOnboardingApplication,
    approvedApplication: ProviderOnboardingApplication,
    currentProvider: ProviderOrganization,
    activeProvider: ProviderOrganization,
  ): Promise<boolean>;
}

export interface ProviderOnboardingOptions {
  readonly store: ProviderOnboardingStore;
  readonly audit: TenantAuditOptions;
  readonly attestationCatalog: ReadonlyMap<string, AttestationDefinition>;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
}

export interface AttestationAffirmation {
  readonly key: string;
  readonly affirmed: boolean;
}

export type ProviderOnboardingResult<T> =
  | {readonly accepted: true; readonly value: T}
  | {readonly accepted: false; readonly code: typeof PROVIDER_ONBOARDING_REJECTED};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY = /^[a-z][a-z0-9-]{0,62}$/;
const rejected = <T>(): ProviderOnboardingResult<T> => ({
  accepted: false, code: PROVIDER_ONBOARDING_REJECTED,
});

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validText(value: string, maximum: number): boolean {
  return value === value.trim() && value.length > 0 && value.length <= maximum;
}

function isBoundProvider(
  provider: ProviderOrganization | null,
  organizationId: string,
  providerOrganizationId: string,
): provider is ProviderOrganization {
  return provider?.organizationId === organizationId &&
    provider.providerOrganizationId === providerOrganizationId;
}

function isBoundApplication(
  application: ProviderOnboardingApplication | null,
  organizationId: string,
  providerOnboardingId: string,
): application is ProviderOnboardingApplication {
  return application?.organizationId === organizationId &&
    application.providerOnboardingId === providerOnboardingId;
}

async function authorize(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  permission: string,
  action: string,
  options: ProviderOnboardingOptions,
): Promise<{organizationId: string; subjectId: string} | null> {
  const result = await authorizeAndAuditOrganizationAction(request, state, action, options.audit);
  return result.authorized && request.requiredPermission === permission
    ? {organizationId: result.organizationId, subjectId: result.subjectId} : null;
}

function buildAttestations(
  affirmations: readonly AttestationAffirmation[],
  catalog: ReadonlyMap<string, AttestationDefinition>,
  now: number,
): readonly ProviderAttestation[] | null {
  if (catalog.size < 1 || catalog.size > 32 || affirmations.length !== catalog.size ||
    new Set(affirmations.map(value => value.key)).size !== affirmations.length ||
    affirmations.some(value => value.affirmed !== true || !catalog.has(value.key))) return null;
  const definitions = [...catalog.entries()]
    .sort(([left], [right]) => left.localeCompare(right));
  if (definitions.some(([catalogKey, definition]) => catalogKey !== definition.key ||
    !KEY.test(definition.key) ||
    !Number.isSafeInteger(definition.statementVersion) || definition.statementVersion < 1 ||
    !validText(definition.statement, 2_000) ||
    (definition.validityMs !== undefined &&
      (!Number.isSafeInteger(definition.validityMs) || definition.validityMs < 1 ||
        definition.validityMs > 366 * 24 * 60 * 60 * 1_000)))) return null;
  const snapshots = definitions.map(([, definition]) => ({
    key: definition.key,
    statementVersion: definition.statementVersion,
    statement: definition.statement,
    affirmedAt: now,
    ...(definition.validityMs === undefined ? {} : {expiresAt: now + definition.validityMs}),
  }));
  if (snapshots.some(snapshot =>
    snapshot.expiresAt !== undefined && !Number.isSafeInteger(snapshot.expiresAt))) return null;
  return Object.freeze(snapshots.map(snapshot => Object.freeze(snapshot)));
}

function attestationsCurrent(
  attestations: readonly ProviderAttestation[],
  catalog: ReadonlyMap<string, AttestationDefinition>,
  now: number,
): boolean {
  if (attestations.length !== catalog.size ||
    new Set(attestations.map(attestation => attestation.key)).size !== catalog.size) return false;
  return attestations.every(attestation => {
    const definition = catalog.get(attestation.key);
    const expectedExpiry = definition?.validityMs === undefined
      ? undefined : attestation.affirmedAt + definition.validityMs;
    return definition !== undefined && definition.statementVersion === attestation.statementVersion &&
      definition.statement === attestation.statement && validTimestamp(attestation.affirmedAt) &&
      attestation.affirmedAt <= now && attestation.expiresAt === expectedExpiry &&
      (expectedExpiry === undefined || (validTimestamp(expectedExpiry) && expectedExpiry > now));
  });
}

export async function createProviderOnboarding(
  contractVersion: number,
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  providerOrganizationId: string,
  affirmations: readonly AttestationAffirmation[],
  options: ProviderOnboardingOptions,
): Promise<ProviderOnboardingResult<ProviderOnboardingApplication>> {
  const authorization = await authorize(
    request, state, 'provider-onboarding:write', 'provider-onboarding.create', options,
  );
  const providerOnboardingId = options.createOpaqueId();
  const now = options.now();
  const attestations = buildAttestations(affirmations, options.attestationCatalog, now);
  if (!authorization || contractVersion !== PROVIDER_ONBOARDING_CONTRACT_VERSION ||
    !IDENTIFIER.test(providerOrganizationId) || !IDENTIFIER.test(providerOnboardingId) ||
    !validTimestamp(now) || !attestations) return rejected();
  try {
    const provider = await options.store.getProvider(
      authorization.organizationId, providerOrganizationId,
    );
    if (!isBoundProvider(provider, authorization.organizationId, providerOrganizationId) ||
      provider.status !== 'draft') return rejected();
    const application = Object.freeze({
      providerOnboardingId, organizationId: authorization.organizationId,
      providerOrganizationId, attestations, status: 'draft' as const,
      version: 1, createdAt: now, updatedAt: now,
    });
    return await options.store.createApplication(application)
      ? {accepted: true, value: application} : rejected();
  } catch {
    return rejected();
  }
}

export async function getProviderOnboarding(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  providerOnboardingId: string,
  options: ProviderOnboardingOptions,
): Promise<ProviderOnboardingResult<ProviderOnboardingApplication>> {
  const authorization = await authorize(
    request, state, 'provider-onboarding:read', 'provider-onboarding.read', options,
  );
  if (!authorization || !IDENTIFIER.test(providerOnboardingId)) return rejected();
  try {
    const application = await options.store.getApplication(
      authorization.organizationId, providerOnboardingId,
    );
    return isBoundApplication(application, authorization.organizationId, providerOnboardingId)
      ? {accepted: true, value: application} : rejected();
  } catch {
    return rejected();
  }
}

export async function replaceProviderAttestations(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  providerOnboardingId: string,
  expectedVersion: number,
  affirmations: readonly AttestationAffirmation[],
  options: ProviderOnboardingOptions,
): Promise<ProviderOnboardingResult<ProviderOnboardingApplication>> {
  const authorization = await authorize(
    request, state, 'provider-onboarding:write', 'provider-onboarding.attest', options,
  );
  const now = options.now();
  const attestations = buildAttestations(affirmations, options.attestationCatalog, now);
  if (!authorization || !IDENTIFIER.test(providerOnboardingId) ||
    !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
    !validTimestamp(now) || !attestations) return rejected();
  try {
    const current = await options.store.getApplication(
      authorization.organizationId, providerOnboardingId,
    );
    if (!isBoundApplication(current, authorization.organizationId, providerOnboardingId) ||
      current.status !== 'draft' || current.version !== expectedVersion || now < current.updatedAt) {
      return rejected();
    }
    const replacement = Object.freeze({
      ...current, attestations, version: current.version + 1, updatedAt: now,
    });
    return await options.store.replaceApplication(current, replacement)
      ? {accepted: true, value: replacement} : rejected();
  } catch {
    return rejected();
  }
}

export async function submitProviderOnboarding(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  providerOnboardingId: string,
  expectedVersion: number,
  options: ProviderOnboardingOptions,
): Promise<ProviderOnboardingResult<ProviderOnboardingApplication>> {
  const authorization = await authorize(
    request, state, 'provider-onboarding:write', 'provider-onboarding.submit', options,
  );
  const now = options.now();
  if (!authorization || !IDENTIFIER.test(providerOnboardingId) ||
    !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !validTimestamp(now)) {
    return rejected();
  }
  try {
    const current = await options.store.getApplication(
      authorization.organizationId, providerOnboardingId,
    );
    if (!isBoundApplication(current, authorization.organizationId, providerOnboardingId) ||
      current.status !== 'draft' || current.version !== expectedVersion || now < current.updatedAt ||
      !attestationsCurrent(current.attestations, options.attestationCatalog, now)) return rejected();
    const provider = await options.store.getProvider(
      authorization.organizationId, current.providerOrganizationId,
    );
    if (!isBoundProvider(provider, authorization.organizationId, current.providerOrganizationId) ||
      provider.status !== 'draft') return rejected();
    const replacement = Object.freeze({
      ...current, status: 'submitted' as const, submittedAt: now,
      version: current.version + 1, updatedAt: now,
    });
    return await options.store.replaceApplication(current, replacement)
      ? {accepted: true, value: replacement} : rejected();
  } catch {
    return rejected();
  }
}

export async function decideProviderOnboarding(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  providerOnboardingId: string,
  expectedVersion: number,
  decision: 'approved' | 'rejected',
  reason: string,
  options: ProviderOnboardingOptions,
): Promise<ProviderOnboardingResult<ProviderOnboardingApplication>> {
  const authorization = await authorize(
    request, state, 'provider-onboarding:review', 'provider-onboarding.decide', options,
  );
  const now = options.now();
  if (!authorization || !IDENTIFIER.test(providerOnboardingId) ||
    !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
    !['approved', 'rejected'].includes(decision) || !validText(reason, 1_000) ||
    !validTimestamp(now)) return rejected();
  try {
    const current = await options.store.getApplication(
      authorization.organizationId, providerOnboardingId,
    );
    if (!isBoundApplication(current, authorization.organizationId, providerOnboardingId) ||
      current.status !== 'submitted' || current.version !== expectedVersion || now < current.updatedAt ||
      !attestationsCurrent(current.attestations, options.attestationCatalog, now)) return rejected();
    const provider = await options.store.getProvider(
      authorization.organizationId, current.providerOrganizationId,
    );
    if (!isBoundProvider(provider, authorization.organizationId, current.providerOrganizationId) ||
      provider.status !== 'draft' || now < provider.updatedAt) return rejected();
    const replacement = Object.freeze({
      ...current, status: decision, decisionReason: reason,
      reviewedBySubjectId: authorization.subjectId, reviewedAt: now,
      version: current.version + 1, updatedAt: now,
    });
    if (decision === 'rejected') {
      return await options.store.replaceApplication(current, replacement)
        ? {accepted: true, value: replacement} : rejected();
    }
    const activeProvider = Object.freeze({
      ...provider, status: 'active' as const,
      version: provider.version + 1, updatedAt: now,
    });
    return await options.store.approveApplication(current, replacement, provider, activeProvider)
      ? {accepted: true, value: replacement} : rejected();
  } catch {
    return rejected();
  }
}

export async function withdrawProviderOnboarding(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  providerOnboardingId: string,
  expectedVersion: number,
  options: ProviderOnboardingOptions,
): Promise<ProviderOnboardingResult<ProviderOnboardingApplication>> {
  const authorization = await authorize(
    request, state, 'provider-onboarding:write', 'provider-onboarding.withdraw', options,
  );
  const now = options.now();
  if (!authorization || !IDENTIFIER.test(providerOnboardingId) ||
    !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !validTimestamp(now)) {
    return rejected();
  }
  try {
    const current = await options.store.getApplication(
      authorization.organizationId, providerOnboardingId,
    );
    if (!isBoundApplication(current, authorization.organizationId, providerOnboardingId) ||
      current.status !== 'submitted' || current.version !== expectedVersion || now < current.updatedAt) {
      return rejected();
    }
    const replacement = Object.freeze({
      ...current, status: 'withdrawn' as const,
      version: current.version + 1, updatedAt: now,
    });
    return await options.store.replaceApplication(current, replacement)
      ? {accepted: true, value: replacement} : rejected();
  } catch {
    return rejected();
  }
}
