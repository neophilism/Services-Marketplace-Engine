import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const INSURANCE_CONTRACT_VERSION = 1 as const;
export const INSURANCE_REJECTED = 'insurance_rejected' as const;

export interface InsuranceProvider {
  readonly providerOrganizationId: string;
  readonly organizationId: string;
  readonly status: 'draft' | 'active' | 'suspended' | 'closed';
}

export interface InsuranceAttachment {
  readonly attachmentId: string;
  readonly organizationId: string;
  readonly status: 'quarantined' | 'clean' | 'infected';
  readonly sha256: string;
}

export interface ProviderInsuranceEvidence {
  readonly insuranceEvidenceId: string;
  readonly organizationId: string;
  readonly providerOrganizationId: string;
  readonly attachmentId: string;
  readonly attachmentSha256: string;
  readonly coverageType: string;
  readonly insurerName: string;
  readonly policyReference: string;
  readonly coverageStartsAt: number;
  readonly coverageEndsAt: number;
  readonly status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'expired';
  readonly submittedBySubjectId?: string;
  readonly reviewedBySubjectId?: string;
  readonly decisionReason?: string;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly submittedAt?: number;
  readonly reviewedAt?: number;
}

export interface InsuranceEvidenceInput {
  readonly providerOrganizationId: string;
  readonly attachmentId: string;
  readonly coverageType: string;
  readonly insurerName: string;
  readonly policyReference: string;
  readonly coverageStartsAt: number;
  readonly coverageEndsAt: number;
}

export interface InsuranceStore {
  getProvider(organizationId: string, providerOrganizationId: string): Promise<InsuranceProvider | null>;
  getAttachment(organizationId: string, attachmentId: string): Promise<InsuranceAttachment | null>;
  getEvidence(organizationId: string, insuranceEvidenceId: string): Promise<ProviderInsuranceEvidence | null>;
  listEvidence(organizationId: string, providerOrganizationId: string): Promise<readonly ProviderInsuranceEvidence[]>;
  createEvidence(evidence: ProviderInsuranceEvidence): Promise<boolean>;
  replaceEvidence(current: ProviderInsuranceEvidence, replacement: ProviderInsuranceEvidence): Promise<boolean>;
}

export interface InsuranceOptions {
  readonly store: InsuranceStore;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
}

export type InsuranceResult<T> =
  | {readonly accepted: true; readonly value: T}
  | {readonly accepted: false; readonly code: typeof INSURANCE_REJECTED};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COVERAGE_TYPE = /^[a-z][a-z0-9-]{0,62}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const rejected = <T>(): InsuranceResult<T> => ({accepted: false, code: INSURANCE_REJECTED});

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validText(value: string, maximum: number): boolean {
  return value === value.trim() && value.length > 0 && value.length <= maximum;
}

function boundProvider(value: InsuranceProvider | null, organizationId: string, id: string): boolean {
  return value?.organizationId === organizationId && value.providerOrganizationId === id &&
    ['active', 'suspended'].includes(value.status);
}

function validAttachment(value: InsuranceAttachment | null, organizationId: string,
  attachmentId: string, expectedSha256?: string): boolean {
  return value?.organizationId === organizationId && value.attachmentId === attachmentId &&
    value.status === 'clean' && SHA256.test(value.sha256) &&
    (expectedSha256 === undefined || value.sha256 === expectedSha256);
}

function boundEvidence(value: ProviderInsuranceEvidence | null, organizationId: string,
  insuranceEvidenceId: string): value is ProviderInsuranceEvidence {
  if (!(value?.organizationId === organizationId && value.insuranceEvidenceId === insuranceEvidenceId &&
    IDENTIFIER.test(value.providerOrganizationId) && IDENTIFIER.test(value.attachmentId) &&
    SHA256.test(value.attachmentSha256) && COVERAGE_TYPE.test(value.coverageType) &&
    validText(value.insurerName, 200) && validText(value.policyReference, 160) &&
    validTimestamp(value.coverageStartsAt) && validTimestamp(value.coverageEndsAt) &&
    value.coverageStartsAt < value.coverageEndsAt && Number.isSafeInteger(value.version) &&
    value.version >= 1 && validTimestamp(value.createdAt) && validTimestamp(value.updatedAt) &&
    value.updatedAt >= value.createdAt &&
    ['draft', 'submitted', 'approved', 'rejected'].includes(value.status))) return false;
  if (value.status === 'draft') {
    return value.submittedBySubjectId === undefined && value.submittedAt === undefined &&
      value.reviewedBySubjectId === undefined && value.reviewedAt === undefined &&
      value.decisionReason === undefined;
  }
  if (!value.submittedBySubjectId || !IDENTIFIER.test(value.submittedBySubjectId) ||
    value.submittedAt === undefined || !validTimestamp(value.submittedAt) ||
    value.submittedAt < value.createdAt || value.submittedAt > value.updatedAt) return false;
  if (value.status === 'submitted') {
    return value.reviewedBySubjectId === undefined && value.reviewedAt === undefined &&
      value.decisionReason === undefined;
  }
  return Boolean(value.reviewedBySubjectId && IDENTIFIER.test(value.reviewedBySubjectId) &&
    value.reviewedBySubjectId !== value.submittedBySubjectId &&
    value.reviewedAt !== undefined && validTimestamp(value.reviewedAt) &&
    value.reviewedAt >= value.submittedAt && value.reviewedAt <= value.updatedAt &&
    value.decisionReason && validText(value.decisionReason, 1_000));
}

function projectExpiry(value: ProviderInsuranceEvidence, now: number): ProviderInsuranceEvidence {
  return value.status === 'approved' && value.coverageEndsAt <= now
    ? Object.freeze({...value, status: 'expired' as const}) : value;
}

async function authorize(request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState, permission: string, action: string,
  options: InsuranceOptions): Promise<{organizationId: string; subjectId: string} | null> {
  const result = await authorizeAndAuditOrganizationAction(request, state, action, options.audit);
  return result.authorized && request.requiredPermission === permission
    ? {organizationId: result.organizationId, subjectId: result.subjectId} : null;
}

export async function createProviderInsuranceEvidence(
  contractVersion: number,
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  input: InsuranceEvidenceInput,
  options: InsuranceOptions,
): Promise<InsuranceResult<ProviderInsuranceEvidence>> {
  const authorization = await authorize(request, state, 'insurance:write', 'insurance.create', options);
  const insuranceEvidenceId = options.createOpaqueId();
  const now = options.now();
  if (!authorization || contractVersion !== INSURANCE_CONTRACT_VERSION ||
    !IDENTIFIER.test(insuranceEvidenceId) || !IDENTIFIER.test(input.providerOrganizationId) ||
    !IDENTIFIER.test(input.attachmentId) || !COVERAGE_TYPE.test(input.coverageType) ||
    !validText(input.insurerName, 200) || !validText(input.policyReference, 160) ||
    !validTimestamp(input.coverageStartsAt) || !validTimestamp(input.coverageEndsAt) ||
    input.coverageStartsAt >= input.coverageEndsAt || input.coverageEndsAt <= now ||
    !validTimestamp(now)) return rejected();
  try {
    const [provider, attachment] = await Promise.all([
      options.store.getProvider(authorization.organizationId, input.providerOrganizationId),
      options.store.getAttachment(authorization.organizationId, input.attachmentId),
    ]);
    if (!boundProvider(provider, authorization.organizationId, input.providerOrganizationId) ||
      provider!.status !== 'active' ||
      !validAttachment(attachment, authorization.organizationId, input.attachmentId)) return rejected();
    const evidence = Object.freeze({
      insuranceEvidenceId, organizationId: authorization.organizationId,
      providerOrganizationId: input.providerOrganizationId, attachmentId: input.attachmentId,
      attachmentSha256: attachment!.sha256, coverageType: input.coverageType,
      insurerName: input.insurerName, policyReference: input.policyReference,
      coverageStartsAt: input.coverageStartsAt, coverageEndsAt: input.coverageEndsAt,
      status: 'draft' as const, version: 1, createdAt: now, updatedAt: now,
    });
    return await options.store.createEvidence(evidence)
      ? {accepted: true, value: evidence} : rejected();
  } catch {
    return rejected();
  }
}

export async function getProviderInsuranceEvidence(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  insuranceEvidenceId: string,
  options: InsuranceOptions,
): Promise<InsuranceResult<ProviderInsuranceEvidence>> {
  const authorization = await authorize(request, state, 'insurance:read', 'insurance.read', options);
  const now = options.now();
  if (!authorization || !IDENTIFIER.test(insuranceEvidenceId) || !validTimestamp(now)) return rejected();
  try {
    const value = await options.store.getEvidence(authorization.organizationId, insuranceEvidenceId);
    return boundEvidence(value, authorization.organizationId, insuranceEvidenceId)
      ? {accepted: true, value: projectExpiry(value, now)} : rejected();
  } catch {
    return rejected();
  }
}

export async function listProviderInsuranceEvidence(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  providerOrganizationId: string,
  options: InsuranceOptions,
): Promise<InsuranceResult<readonly ProviderInsuranceEvidence[]>> {
  const authorization = await authorize(request, state, 'insurance:read', 'insurance.list', options);
  const now = options.now();
  if (!authorization || !IDENTIFIER.test(providerOrganizationId) || !validTimestamp(now)) return rejected();
  try {
    const provider = await options.store.getProvider(authorization.organizationId, providerOrganizationId);
    const values = await options.store.listEvidence(authorization.organizationId, providerOrganizationId);
    if (!boundProvider(provider, authorization.organizationId, providerOrganizationId) ||
      values.length > 1_000 || new Set(values.map(value => value.insuranceEvidenceId)).size !== values.length ||
      values.some(value => !boundEvidence(value, authorization.organizationId, value.insuranceEvidenceId) ||
        value.providerOrganizationId !== providerOrganizationId)) return rejected();
    return {accepted: true, value: Object.freeze(values.map(value => projectExpiry(value, now)))};
  } catch {
    return rejected();
  }
}

export async function submitProviderInsuranceEvidence(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  insuranceEvidenceId: string,
  expectedVersion: number,
  options: InsuranceOptions,
): Promise<InsuranceResult<ProviderInsuranceEvidence>> {
  const authorization = await authorize(request, state, 'insurance:write', 'insurance.submit', options);
  const now = options.now();
  if (!authorization || !IDENTIFIER.test(insuranceEvidenceId) || !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1 || !validTimestamp(now)) return rejected();
  try {
    const current = await options.store.getEvidence(authorization.organizationId, insuranceEvidenceId);
    if (!boundEvidence(current, authorization.organizationId, insuranceEvidenceId) ||
      current.status !== 'draft' || current.version !== expectedVersion || now < current.updatedAt ||
      current.coverageEndsAt <= now) return rejected();
    const [provider, attachment] = await Promise.all([
      options.store.getProvider(authorization.organizationId, current.providerOrganizationId),
      options.store.getAttachment(authorization.organizationId, current.attachmentId),
    ]);
    if (!boundProvider(provider, authorization.organizationId, current.providerOrganizationId) ||
      provider!.status !== 'active' ||
      !validAttachment(attachment, authorization.organizationId, current.attachmentId,
        current.attachmentSha256)) return rejected();
    const replacement = Object.freeze({...current, status: 'submitted' as const,
      submittedBySubjectId: authorization.subjectId, submittedAt: now,
      version: current.version + 1, updatedAt: now});
    return await options.store.replaceEvidence(current, replacement)
      ? {accepted: true, value: replacement} : rejected();
  } catch {
    return rejected();
  }
}

export async function decideProviderInsuranceEvidence(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  insuranceEvidenceId: string,
  expectedVersion: number,
  decision: 'approved' | 'rejected',
  reason: string,
  options: InsuranceOptions,
): Promise<InsuranceResult<ProviderInsuranceEvidence>> {
  const authorization = await authorize(request, state, 'insurance:review', 'insurance.decide', options);
  const now = options.now();
  if (!authorization || !IDENTIFIER.test(insuranceEvidenceId) || !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1 || !['approved', 'rejected'].includes(decision) ||
    !validText(reason, 1_000) || !validTimestamp(now)) return rejected();
  try {
    const current = await options.store.getEvidence(authorization.organizationId, insuranceEvidenceId);
    if (!boundEvidence(current, authorization.organizationId, insuranceEvidenceId) ||
      current.status !== 'submitted' || current.version !== expectedVersion || now < current.updatedAt ||
      current.coverageEndsAt <= now || current.submittedBySubjectId === authorization.subjectId) return rejected();
    const [provider, attachment] = await Promise.all([
      options.store.getProvider(authorization.organizationId, current.providerOrganizationId),
      options.store.getAttachment(authorization.organizationId, current.attachmentId),
    ]);
    if (!boundProvider(provider, authorization.organizationId, current.providerOrganizationId) ||
      provider!.status !== 'active' ||
      !validAttachment(attachment, authorization.organizationId, current.attachmentId,
        current.attachmentSha256)) return rejected();
    const replacement = Object.freeze({...current, status: decision,
      decisionReason: reason, reviewedBySubjectId: authorization.subjectId, reviewedAt: now,
      version: current.version + 1, updatedAt: now});
    return await options.store.replaceEvidence(current, replacement)
      ? {accepted: true, value: replacement} : rejected();
  } catch {
    return rejected();
  }
}
