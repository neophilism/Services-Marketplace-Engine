import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const PROVIDER_CRM_CONTRACT_VERSION = 1 as const;
export const PROVIDER_CRM_REJECTED = 'provider_crm_rejected' as const;

export type ProviderCrmStage = 'lead' | 'qualified' | 'customer' | 'inactive';

export interface ProviderCrmCustomer {
  readonly organizationId: string;
  readonly customerProfileId: string;
  readonly status: 'active' | 'closed';
}

export interface ProviderCrmProvider {
  readonly organizationId: string;
  readonly providerOrganizationId: string;
  readonly status: 'active' | 'suspended' | 'closed';
}

export interface ProviderCrmOperator {
  readonly organizationId: string;
  readonly providerOrganizationId: string;
  readonly subjectId: string;
  readonly status: 'active' | 'inactive';
  readonly permissions: readonly string[];
}

export interface ProviderCrmRecord {
  readonly crmRecordId: string;
  readonly organizationId: string;
  readonly providerOrganizationId: string;
  readonly customerProfileId: string;
  readonly stage: ProviderCrmStage;
  readonly assignedSubjectId: string | null;
  readonly tags: readonly string[];
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ProviderCrmActivity {
  readonly activityId: string;
  readonly organizationId: string;
  readonly requestKey: string;
  readonly crmRecordId: string;
  readonly providerOrganizationId: string;
  readonly customerProfileId: string;
  readonly actorSubjectId: string;
  readonly stage: ProviderCrmStage;
  readonly assignedSubjectId: string | null;
  readonly tags: readonly string[];
  readonly version: number;
  readonly occurredAt: number;
}

export interface ProviderCrmMutation {
  readonly record: ProviderCrmRecord;
  readonly activity: ProviderCrmActivity;
}

export interface UpsertProviderCrmInput {
  readonly requestKey: string;
  readonly providerOrganizationId: string;
  readonly customerProfileId: string;
  readonly expectedVersion: number;
  readonly stage: ProviderCrmStage;
  readonly assignedSubjectId: string | null;
  readonly tags: readonly string[];
}

export interface ProviderCrmStore {
  getCustomer(organizationId: string, customerProfileId: string):
    Promise<ProviderCrmCustomer | null>;
  getProvider(organizationId: string, providerOrganizationId: string):
    Promise<ProviderCrmProvider | null>;
  getOperator(organizationId: string, providerOrganizationId: string, subjectId: string):
    Promise<ProviderCrmOperator | null>;
  getRecord(organizationId: string, providerOrganizationId: string, customerProfileId: string):
    Promise<ProviderCrmRecord | null>;
  getMutationByRequestKey(organizationId: string, requestKey: string):
    Promise<ProviderCrmMutation | null>;
  commitMutation(current: ProviderCrmRecord | null, mutation: ProviderCrmMutation):
    Promise<boolean>;
}

export interface ProviderCrmOptions {
  readonly store: ProviderCrmStore;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
}

export type ProviderCrmResult =
  | {readonly accepted: true; readonly value: ProviderCrmMutation; readonly replayed: boolean}
  | {readonly accepted: false; readonly code: typeof PROVIDER_CRM_REJECTED};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TAG = /^[a-z][a-z0-9-]{0,31}$/;
const STAGES = new Set<ProviderCrmStage>(['lead', 'qualified', 'customer', 'inactive']);
const DATE = 8_640_000_000_000_000;
const rejected = (): ProviderCrmResult => ({accepted: false, code: PROVIDER_CRM_REJECTED});
const integer = (value: number, minimum: number, maximum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;

function normalizedTags(values: readonly string[]): readonly string[] | null {
  if (values.length > 20 || values.some(value => !TAG.test(value))) return null;
  const unique = [...new Set(values)].sort();
  return unique.length === values.length ? Object.freeze(unique) : null;
}

function boundCustomer(value: ProviderCrmCustomer | null, organizationId: string,
  customerProfileId: string): value is ProviderCrmCustomer {
  return value?.organizationId === organizationId &&
    value.customerProfileId === customerProfileId && value.status === 'active';
}

function boundProvider(value: ProviderCrmProvider | null, organizationId: string,
  providerOrganizationId: string): value is ProviderCrmProvider {
  return value?.organizationId === organizationId &&
    value.providerOrganizationId === providerOrganizationId && value.status === 'active';
}

function boundOperator(value: ProviderCrmOperator | null, organizationId: string,
  providerOrganizationId: string, subjectId: string, requireWrite: boolean): boolean {
  return value?.organizationId === organizationId &&
    value.providerOrganizationId === providerOrganizationId &&
    value.subjectId === subjectId && value.status === 'active' &&
    (!requireWrite || value.permissions.includes('provider-crm:write'));
}

function validRecord(value: ProviderCrmRecord | null, organizationId: string): value is ProviderCrmRecord {
  return value?.organizationId === organizationId && ID.test(value.crmRecordId) &&
    ID.test(value.providerOrganizationId) && ID.test(value.customerProfileId) &&
    STAGES.has(value.stage) &&
    (value.assignedSubjectId === null || ID.test(value.assignedSubjectId)) &&
    normalizedTags(value.tags) !== null && integer(value.version, 1, Number.MAX_SAFE_INTEGER) &&
    integer(value.createdAt, 0, DATE) && integer(value.updatedAt, value.createdAt, DATE);
}

function validMutation(value: ProviderCrmMutation | null, organizationId: string):
  value is ProviderCrmMutation {
  if (!value || !validRecord(value.record, organizationId)) return false;
  const activity = value.activity;
  return activity.organizationId === organizationId && ID.test(activity.activityId) &&
    ID.test(activity.requestKey) && activity.crmRecordId === value.record.crmRecordId &&
    activity.providerOrganizationId === value.record.providerOrganizationId &&
    activity.customerProfileId === value.record.customerProfileId &&
    ID.test(activity.actorSubjectId) && activity.stage === value.record.stage &&
    activity.assignedSubjectId === value.record.assignedSubjectId &&
    activity.tags.length === value.record.tags.length &&
    activity.tags.every((tag, index) => tag === value.record.tags[index]) &&
    activity.version === value.record.version && activity.occurredAt === value.record.updatedAt;
}

function exactReplay(value: ProviderCrmMutation, input: UpsertProviderCrmInput,
  tags: readonly string[]): boolean {
  return value.activity.requestKey === input.requestKey &&
    value.record.providerOrganizationId === input.providerOrganizationId &&
    value.record.customerProfileId === input.customerProfileId &&
    value.record.version === input.expectedVersion + 1 &&
    value.record.stage === input.stage &&
    value.record.assignedSubjectId === input.assignedSubjectId &&
    value.record.tags.length === tags.length &&
    value.record.tags.every((tag, index) => tag === tags[index]);
}

export async function upsertProviderCrmRecord(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: UpsertProviderCrmInput, options: ProviderCrmOptions): Promise<ProviderCrmResult> {
  const authorization = await authorizeAndAuditOrganizationAction(
    request, state, 'provider-crm.upsert', options.audit);
  const now = options.now();
  const tags = normalizedTags(input.tags);
  if (!authorization.authorized || request.requiredPermission !== 'provider-crm:write' ||
    contractVersion !== PROVIDER_CRM_CONTRACT_VERSION || !ID.test(input.requestKey) ||
    !ID.test(input.providerOrganizationId) || !ID.test(input.customerProfileId) ||
    !integer(input.expectedVersion, 0, Number.MAX_SAFE_INTEGER - 1) ||
    !STAGES.has(input.stage) ||
    (input.assignedSubjectId !== null && !ID.test(input.assignedSubjectId)) ||
    tags === null || !integer(now, 0, DATE)) return rejected();

  try {
    const [customer, provider, actor, assignee, current, replay] = await Promise.all([
      options.store.getCustomer(authorization.organizationId, input.customerProfileId),
      options.store.getProvider(authorization.organizationId, input.providerOrganizationId),
      options.store.getOperator(authorization.organizationId, input.providerOrganizationId,
        authorization.subjectId),
      input.assignedSubjectId === null ? Promise.resolve(null) :
        options.store.getOperator(authorization.organizationId, input.providerOrganizationId,
          input.assignedSubjectId),
      options.store.getRecord(authorization.organizationId, input.providerOrganizationId,
        input.customerProfileId),
      options.store.getMutationByRequestKey(authorization.organizationId, input.requestKey),
    ]);
    if (!boundCustomer(customer, authorization.organizationId, input.customerProfileId) ||
      !boundProvider(provider, authorization.organizationId, input.providerOrganizationId) ||
      !boundOperator(actor, authorization.organizationId, input.providerOrganizationId,
        authorization.subjectId, true) ||
      (input.assignedSubjectId !== null &&
        !boundOperator(assignee, authorization.organizationId, input.providerOrganizationId,
          input.assignedSubjectId, false))) return rejected();

    if (replay !== null) return validMutation(replay, authorization.organizationId) &&
      replay.activity.actorSubjectId === authorization.subjectId &&
      exactReplay(replay, input, tags)
      ? {accepted: true, value: replay, replayed: true} : rejected();

    if ((current === null && input.expectedVersion !== 0) ||
      (current !== null && (!validRecord(current, authorization.organizationId) ||
        current.providerOrganizationId !== input.providerOrganizationId ||
        current.customerProfileId !== input.customerProfileId ||
        current.version !== input.expectedVersion || current.updatedAt > now))) return rejected();

    const crmRecordId = current?.crmRecordId ?? options.createOpaqueId();
    const activityId = options.createOpaqueId();
    if (!ID.test(crmRecordId) || !ID.test(activityId) || crmRecordId === activityId) {
      return rejected();
    }
    const version = input.expectedVersion + 1;
    const record = Object.freeze({
      crmRecordId, organizationId: authorization.organizationId,
      providerOrganizationId: input.providerOrganizationId,
      customerProfileId: input.customerProfileId, stage: input.stage,
      assignedSubjectId: input.assignedSubjectId, tags, version,
      createdAt: current?.createdAt ?? now, updatedAt: now,
    });
    const activity = Object.freeze({
      activityId, organizationId: authorization.organizationId,
      requestKey: input.requestKey, crmRecordId,
      providerOrganizationId: input.providerOrganizationId,
      customerProfileId: input.customerProfileId,
      actorSubjectId: authorization.subjectId, stage: input.stage,
      assignedSubjectId: input.assignedSubjectId, tags, version, occurredAt: now,
    });
    const mutation = Object.freeze({record, activity});
    return validMutation(mutation, authorization.organizationId) &&
      await options.store.commitMutation(current, mutation)
      ? {accepted: true, value: mutation, replayed: false} : rejected();
  } catch {
    return rejected();
  }
}
