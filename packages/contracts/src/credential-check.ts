import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const CREDENTIAL_CHECK_CONTRACT_VERSION = 1 as const;
export const CREDENTIAL_CHECK_REJECTED = 'credential_check_rejected' as const;

export interface CredentialCheckProvider {
  readonly providerOrganizationId: string;
  readonly organizationId: string;
  readonly status: 'draft' | 'active' | 'suspended' | 'closed';
}

export interface CredentialCheckAttachment {
  readonly attachmentId: string;
  readonly organizationId: string;
  readonly status: 'quarantined' | 'clean' | 'infected';
  readonly sha256: string;
}

export interface CredentialCheckRecord {
  readonly credentialCheckId: string;
  readonly organizationId: string;
  readonly providerOrganizationId: string;
  readonly subjectReference: string;
  readonly credentialType: string;
  readonly attachmentId: string;
  readonly attachmentSha256: string;
  readonly purposeCode: string;
  readonly consentedAt: number;
  readonly requestedBySubjectId: string;
  readonly adapterName: string;
  readonly adapterReference: string;
  readonly outcome: 'verified' | 'review' | 'rejected';
  readonly checkedAt: number;
  readonly validUntil?: number;
  readonly createdAt: number;
}

export interface CredentialCheckInput {
  readonly providerOrganizationId: string;
  readonly subjectReference: string;
  readonly credentialType: string;
  readonly attachmentId: string;
  readonly purposeCode: string;
  readonly consentedAt: number;
}

export interface CredentialCheckAdapterRequest {
  readonly credentialCheckId: string;
  readonly organizationId: string;
  readonly providerOrganizationId: string;
  readonly subjectReference: string;
  readonly credentialType: string;
  readonly attachmentSha256: string;
  readonly purposeCode: string;
  readonly consentedAt: number;
}

export interface CredentialCheckAdapterResult {
  readonly credentialCheckId: string;
  readonly organizationId: string;
  readonly providerOrganizationId: string;
  readonly subjectReference: string;
  readonly attachmentSha256: string;
  readonly adapterName: string;
  readonly adapterReference: string;
  readonly outcome: 'verified' | 'review' | 'rejected';
  readonly checkedAt: number;
  readonly validUntil?: number;
}

export interface CredentialCheckAdapter {
  check(request: CredentialCheckAdapterRequest): Promise<CredentialCheckAdapterResult>;
}

export interface CredentialCheckStore {
  getProvider(organizationId: string, providerOrganizationId: string): Promise<CredentialCheckProvider | null>;
  getAttachment(organizationId: string, attachmentId: string): Promise<CredentialCheckAttachment | null>;
  getCheck(organizationId: string, credentialCheckId: string): Promise<CredentialCheckRecord | null>;
  listChecks(organizationId: string, providerOrganizationId: string): Promise<readonly CredentialCheckRecord[]>;
  createCheck(record: CredentialCheckRecord): Promise<boolean>;
}

export interface CredentialCheckOptions {
  readonly store: CredentialCheckStore;
  readonly adapter: CredentialCheckAdapter;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
  readonly maximumConsentAgeMs?: number;
}

export type CredentialCheckResult<T> =
  | {readonly accepted: true; readonly value: T}
  | {readonly accepted: false; readonly code: typeof CREDENTIAL_CHECK_REJECTED};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODE = /^[a-z][a-z0-9-]{0,62}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DEFAULT_MAXIMUM_CONSENT_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const rejected = <T>(): CredentialCheckResult<T> => ({
  accepted: false, code: CREDENTIAL_CHECK_REJECTED,
});

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validText(value: string, maximum: number): boolean {
  return value === value.trim() && value.length > 0 && value.length <= maximum;
}

function boundProvider(value: CredentialCheckProvider | null, organizationId: string,
  providerOrganizationId: string): value is CredentialCheckProvider {
  return value?.organizationId === organizationId &&
    value.providerOrganizationId === providerOrganizationId &&
    ['active', 'suspended'].includes(value.status);
}

function validAttachment(value: CredentialCheckAttachment | null, organizationId: string,
  attachmentId: string): value is CredentialCheckAttachment {
  return value?.organizationId === organizationId && value.attachmentId === attachmentId &&
    value.status === 'clean' && SHA256.test(value.sha256);
}

function boundRecord(value: CredentialCheckRecord | null, organizationId: string,
  credentialCheckId: string): value is CredentialCheckRecord {
  return Boolean(value?.organizationId === organizationId &&
    value.credentialCheckId === credentialCheckId && IDENTIFIER.test(value.providerOrganizationId) &&
    IDENTIFIER.test(value.subjectReference) && CODE.test(value.credentialType) &&
    IDENTIFIER.test(value.attachmentId) && SHA256.test(value.attachmentSha256) &&
    CODE.test(value.purposeCode) && validTimestamp(value.consentedAt) &&
    IDENTIFIER.test(value.requestedBySubjectId) && validText(value.adapterName, 100) &&
    validText(value.adapterReference, 200) &&
    ['verified', 'review', 'rejected'].includes(value.outcome) &&
    validTimestamp(value.checkedAt) && validTimestamp(value.createdAt) &&
    value.consentedAt <= value.checkedAt && value.checkedAt <= value.createdAt &&
    (value.outcome === 'verified'
      ? value.validUntil === undefined ||
        (validTimestamp(value.validUntil) && value.validUntil > value.checkedAt)
      : value.validUntil === undefined));
}

function projectExpiry(value: CredentialCheckRecord, now: number): CredentialCheckRecord {
  return value.outcome === 'verified' && value.validUntil !== undefined && value.validUntil <= now
    ? Object.freeze({...value, outcome: 'review' as const}) : value;
}

async function authorize(request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState, permission: string, action: string,
  options: CredentialCheckOptions): Promise<{organizationId: string; subjectId: string} | null> {
  const result = await authorizeAndAuditOrganizationAction(request, state, action, options.audit);
  return result.authorized && request.requiredPermission === permission
    ? {organizationId: result.organizationId, subjectId: result.subjectId} : null;
}

export async function runProviderCredentialCheck(
  contractVersion: number,
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  input: CredentialCheckInput,
  options: CredentialCheckOptions,
): Promise<CredentialCheckResult<CredentialCheckRecord>> {
  const authorization = await authorize(request, state, 'credentials:check',
    'credentials.check', options);
  const credentialCheckId = options.createOpaqueId();
  const now = options.now();
  const maximumConsentAgeMs = options.maximumConsentAgeMs ?? DEFAULT_MAXIMUM_CONSENT_AGE_MS;
  if (!authorization || contractVersion !== CREDENTIAL_CHECK_CONTRACT_VERSION ||
    !IDENTIFIER.test(credentialCheckId) || !IDENTIFIER.test(input.providerOrganizationId) ||
    !IDENTIFIER.test(input.subjectReference) || !CODE.test(input.credentialType) ||
    !IDENTIFIER.test(input.attachmentId) || !CODE.test(input.purposeCode) ||
    !validTimestamp(input.consentedAt) || !validTimestamp(now) || input.consentedAt > now ||
    !Number.isSafeInteger(maximumConsentAgeMs) || maximumConsentAgeMs < 1 ||
    now - input.consentedAt > maximumConsentAgeMs) return rejected();
  try {
    const [provider, attachment] = await Promise.all([
      options.store.getProvider(authorization.organizationId, input.providerOrganizationId),
      options.store.getAttachment(authorization.organizationId, input.attachmentId),
    ]);
    if (!boundProvider(provider, authorization.organizationId, input.providerOrganizationId) ||
      provider.status !== 'active' ||
      !validAttachment(attachment, authorization.organizationId, input.attachmentId)) return rejected();
    const adapterRequest = Object.freeze({
      credentialCheckId, organizationId: authorization.organizationId,
      providerOrganizationId: input.providerOrganizationId,
      subjectReference: input.subjectReference, credentialType: input.credentialType,
      attachmentSha256: attachment.sha256, purposeCode: input.purposeCode,
      consentedAt: input.consentedAt,
    });
    const result = await options.adapter.check(adapterRequest);
    if (result.credentialCheckId !== credentialCheckId ||
      result.organizationId !== authorization.organizationId ||
      result.providerOrganizationId !== input.providerOrganizationId ||
      result.subjectReference !== input.subjectReference ||
      result.attachmentSha256 !== attachment.sha256 ||
      !validText(result.adapterName, 100) || !validText(result.adapterReference, 200) ||
      !['verified', 'review', 'rejected'].includes(result.outcome) ||
      !validTimestamp(result.checkedAt) || result.checkedAt < input.consentedAt ||
      result.checkedAt > now ||
      (result.validUntil !== undefined &&
        (result.outcome !== 'verified' || !validTimestamp(result.validUntil) ||
          result.validUntil <= result.checkedAt))) return rejected();
    const record = Object.freeze({...adapterRequest,
      attachmentId: input.attachmentId, requestedBySubjectId: authorization.subjectId,
      adapterName: result.adapterName, adapterReference: result.adapterReference,
      outcome: result.outcome, checkedAt: result.checkedAt,
      ...(result.validUntil === undefined ? {} : {validUntil: result.validUntil}),
      createdAt: now,
    });
    return await options.store.createCheck(record)
      ? {accepted: true, value: record} : rejected();
  } catch {
    return rejected();
  }
}

export async function getProviderCredentialCheck(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  credentialCheckId: string,
  options: CredentialCheckOptions,
): Promise<CredentialCheckResult<CredentialCheckRecord>> {
  const authorization = await authorize(request, state, 'credentials:read',
    'credentials.read', options);
  const now = options.now();
  if (!authorization || !IDENTIFIER.test(credentialCheckId) || !validTimestamp(now)) return rejected();
  try {
    const value = await options.store.getCheck(authorization.organizationId, credentialCheckId);
    return boundRecord(value, authorization.organizationId, credentialCheckId)
      ? {accepted: true, value: projectExpiry(value, now)} : rejected();
  } catch {
    return rejected();
  }
}

export async function listProviderCredentialChecks(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  providerOrganizationId: string,
  options: CredentialCheckOptions,
): Promise<CredentialCheckResult<readonly CredentialCheckRecord[]>> {
  const authorization = await authorize(request, state, 'credentials:read',
    'credentials.list', options);
  const now = options.now();
  if (!authorization || !IDENTIFIER.test(providerOrganizationId) || !validTimestamp(now)) return rejected();
  try {
    const [provider, values] = await Promise.all([
      options.store.getProvider(authorization.organizationId, providerOrganizationId),
      options.store.listChecks(authorization.organizationId, providerOrganizationId),
    ]);
    if (!boundProvider(provider, authorization.organizationId, providerOrganizationId) ||
      values.length > 1_000 ||
      new Set(values.map(value => value.credentialCheckId)).size !== values.length ||
      values.some(value => !boundRecord(value, authorization.organizationId,
        value.credentialCheckId) || value.providerOrganizationId !== providerOrganizationId)) {
      return rejected();
    }
    return {accepted: true, value: Object.freeze(values.map(value => projectExpiry(value, now)))};
  } catch {
    return rejected();
  }
}
