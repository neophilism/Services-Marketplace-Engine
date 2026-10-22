import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const SERVICE_TAXONOMY_CONTRACT_VERSION = 1 as const;
export const SERVICE_TAXONOMY_REJECTED = 'service_taxonomy_rejected' as const;

export type IntakeAnswer = string | number | boolean;
export type IntakeFieldKind = 'text' | 'integer' | 'decimal' | 'boolean' | 'date' | 'choice';

export interface IntakeField {
  readonly key: string;
  readonly label: string;
  readonly kind: IntakeFieldKind;
  readonly required: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly options?: readonly string[];
}

export interface ServiceDefinition {
  readonly serviceDefinitionId: string;
  readonly organizationId: string;
  readonly serviceKey: string;
  readonly revision: number;
  readonly parentServiceKey?: string;
  readonly title: string;
  readonly description: string;
  readonly fields: readonly IntakeField[];
  readonly status: 'draft' | 'published' | 'retired';
  readonly recordVersion: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ServiceTaxonomyStore {
  getDefinition(
    organizationId: string,
    serviceKey: string,
    revision: number,
  ): Promise<ServiceDefinition | null>;
  getPublishedDefinition(
    organizationId: string,
    serviceKey: string,
  ): Promise<ServiceDefinition | null>;
  createDefinition(definition: ServiceDefinition): Promise<boolean>;
  replaceDefinition(current: ServiceDefinition, replacement: ServiceDefinition): Promise<boolean>;
  listPublishedDefinitions(organizationId: string): Promise<readonly ServiceDefinition[]>;
}

export interface ServiceTaxonomyOptions {
  readonly store: ServiceTaxonomyStore;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
}

export interface DraftServiceDefinition {
  readonly serviceKey: string;
  readonly revision: number;
  readonly parentServiceKey?: string;
  readonly title: string;
  readonly description: string;
  readonly fields: readonly IntakeField[];
}

export type ServiceTaxonomyResult<T> =
  | {readonly accepted: true; readonly value: T}
  | {readonly accepted: false; readonly code: typeof SERVICE_TAXONOMY_REJECTED};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY = /^[a-z][a-z0-9-]{0,62}$/;
const DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const rejected = <T>(): ServiceTaxonomyResult<T> => ({
  accepted: false, code: SERVICE_TAXONOMY_REJECTED,
});

function validText(value: string, maximum: number): boolean {
  return value === value.trim() && value.length > 0 && value.length <= maximum;
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validField(field: IntakeField): boolean {
  if (!KEY.test(field.key) || !validText(field.label, 120) ||
    typeof field.required !== 'boolean') return false;
  const hasMinimum = field.minimum !== undefined;
  const hasMaximum = field.maximum !== undefined;
  if ((hasMinimum && !Number.isFinite(field.minimum)) ||
    (hasMaximum && !Number.isFinite(field.maximum)) ||
    (hasMinimum && hasMaximum && field.minimum! > field.maximum!)) return false;
  if (field.kind === 'choice') {
    if (hasMinimum || hasMaximum || !field.options ||
      field.options.length < 2 || field.options.length > 50) return false;
    const normalized = field.options.map(option => option.trim());
    return normalized.every((option, index) =>
      validText(option, 80) && option === field.options?.[index],
    ) && new Set(normalized).size === normalized.length;
  }
  if (field.options !== undefined) return false;
  if (field.kind === 'boolean' || field.kind === 'date') return !hasMinimum && !hasMaximum;
  if (field.kind === 'text') {
    return (!hasMinimum || Number.isSafeInteger(field.minimum)) &&
      (!hasMaximum || Number.isSafeInteger(field.maximum)) &&
      (field.minimum ?? 0) >= 0 && (field.maximum ?? 4_000) <= 4_000;
  }
  if (field.kind === 'integer') {
    return (!hasMinimum || Number.isSafeInteger(field.minimum)) &&
      (!hasMaximum || Number.isSafeInteger(field.maximum));
  }
  return field.kind === 'decimal';
}

function normalizeFields(fields: readonly IntakeField[]): readonly IntakeField[] | null {
  if (fields.length < 1 || fields.length > 64 ||
    new Set(fields.map(field => field.key)).size !== fields.length ||
    fields.some(field => !validField(field))) return null;
  return Object.freeze(fields.map(field => Object.freeze({
    ...field,
    ...(field.options ? {options: Object.freeze([...field.options])} : {}),
  })));
}

function isBoundDefinition(
  definition: ServiceDefinition | null,
  organizationId: string,
  serviceKey: string,
  revision?: number,
): definition is ServiceDefinition {
  return definition?.organizationId === organizationId &&
    definition.serviceKey === serviceKey &&
    (revision === undefined || definition.revision === revision);
}

async function authorize(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  permission: string,
  action: string,
  options: ServiceTaxonomyOptions,
): Promise<string | null> {
  const result = await authorizeAndAuditOrganizationAction(request, state, action, options.audit);
  return result.authorized && request.requiredPermission === permission ? result.organizationId : null;
}

async function validPublishedParent(
  organizationId: string,
  serviceKey: string,
  parentServiceKey: string | undefined,
  options: ServiceTaxonomyOptions,
): Promise<boolean> {
  if (!parentServiceKey) return true;
  if (parentServiceKey === serviceKey || !KEY.test(parentServiceKey)) return false;
  const parent = await options.store.getPublishedDefinition(organizationId, parentServiceKey);
  return isBoundDefinition(parent, organizationId, parentServiceKey) && parent.status === 'published';
}

export async function createDraftServiceDefinition(
  contractVersion: number,
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  input: DraftServiceDefinition,
  options: ServiceTaxonomyOptions,
): Promise<ServiceTaxonomyResult<ServiceDefinition>> {
  const organizationId = await authorize(
    request, state, 'service-taxonomy:write', 'service-taxonomy.create', options,
  );
  const serviceDefinitionId = options.createOpaqueId();
  const now = options.now();
  const fields = normalizeFields(input.fields);
  if (!organizationId || contractVersion !== SERVICE_TAXONOMY_CONTRACT_VERSION ||
    !IDENTIFIER.test(serviceDefinitionId) || !KEY.test(input.serviceKey) ||
    !Number.isSafeInteger(input.revision) || input.revision < 1 ||
    !validText(input.title, 120) || !validText(input.description, 2_000) ||
    !fields || !validTimestamp(now)) return rejected();
  try {
    const existing = await options.store.getDefinition(
      organizationId, input.serviceKey, input.revision,
    );
    if (existing || !await validPublishedParent(
      organizationId, input.serviceKey, input.parentServiceKey, options,
    )) return rejected();
    if (input.revision > 1) {
      const previous = await options.store.getDefinition(
        organizationId, input.serviceKey, input.revision - 1,
      );
      if (!isBoundDefinition(previous, organizationId, input.serviceKey, input.revision - 1) ||
        previous.status === 'draft') return rejected();
    }
    const definition = Object.freeze({
      serviceDefinitionId, organizationId, serviceKey: input.serviceKey,
      revision: input.revision, ...(input.parentServiceKey
        ? {parentServiceKey: input.parentServiceKey} : {}),
      title: input.title, description: input.description, fields,
      status: 'draft' as const, recordVersion: 1, createdAt: now, updatedAt: now,
    });
    return await options.store.createDefinition(definition)
      ? {accepted: true, value: definition} : rejected();
  } catch {
    return rejected();
  }
}

async function transitionDefinition(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  serviceKey: string,
  revision: number,
  expectedRecordVersion: number,
  from: ServiceDefinition['status'],
  to: ServiceDefinition['status'],
  action: string,
  options: ServiceTaxonomyOptions,
): Promise<ServiceTaxonomyResult<ServiceDefinition>> {
  const organizationId = await authorize(
    request, state, 'service-taxonomy:write', action, options,
  );
  const now = options.now();
  if (!organizationId || !KEY.test(serviceKey) || !Number.isSafeInteger(revision) ||
    revision < 1 || !Number.isSafeInteger(expectedRecordVersion) ||
    expectedRecordVersion < 1 || !validTimestamp(now)) return rejected();
  try {
    const current = await options.store.getDefinition(organizationId, serviceKey, revision);
    if (!isBoundDefinition(current, organizationId, serviceKey, revision) ||
      current.status !== from || current.recordVersion !== expectedRecordVersion ||
      now < current.updatedAt || (to === 'published' && !await validPublishedParent(
        organizationId, serviceKey, current.parentServiceKey, options,
      ))) return rejected();
    const replacement = Object.freeze({
      ...current, status: to, recordVersion: current.recordVersion + 1, updatedAt: now,
    });
    return await options.store.replaceDefinition(current, replacement)
      ? {accepted: true, value: replacement} : rejected();
  } catch {
    return rejected();
  }
}

export const publishServiceDefinition = (
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  serviceKey: string,
  revision: number,
  expectedRecordVersion: number,
  options: ServiceTaxonomyOptions,
): Promise<ServiceTaxonomyResult<ServiceDefinition>> => transitionDefinition(
  request, state, serviceKey, revision, expectedRecordVersion,
  'draft', 'published', 'service-taxonomy.publish', options,
);

export const retireServiceDefinition = (
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  serviceKey: string,
  revision: number,
  expectedRecordVersion: number,
  options: ServiceTaxonomyOptions,
): Promise<ServiceTaxonomyResult<ServiceDefinition>> => transitionDefinition(
  request, state, serviceKey, revision, expectedRecordVersion,
  'published', 'retired', 'service-taxonomy.retire', options,
);

export async function listPublishedServiceDefinitions(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  options: ServiceTaxonomyOptions,
): Promise<ServiceTaxonomyResult<readonly ServiceDefinition[]>> {
  const organizationId = await authorize(
    request, state, 'service-taxonomy:read', 'service-taxonomy.list', options,
  );
  if (!organizationId) return rejected();
  try {
    const definitions = await options.store.listPublishedDefinitions(organizationId);
    if (definitions.some(definition =>
      definition.organizationId !== organizationId || definition.status !== 'published')) {
      return rejected();
    }
    return {accepted: true, value: Object.freeze([...definitions])};
  } catch {
    return rejected();
  }
}

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function validAnswer(field: IntakeField, answer: IntakeAnswer): boolean {
  if (field.kind === 'text') {
    return typeof answer === 'string' && answer === answer.trim() &&
      answer.length >= (field.minimum ?? 0) && answer.length <= (field.maximum ?? 4_000);
  }
  if (field.kind === 'choice') {
    return typeof answer === 'string' && (field.options?.includes(answer) ?? false);
  }
  if (field.kind === 'date') return typeof answer === 'string' && validDate(answer);
  if (field.kind === 'boolean') return typeof answer === 'boolean';
  if (typeof answer !== 'number' || !Number.isFinite(answer) ||
    answer < (field.minimum ?? -Number.MAX_VALUE) ||
    answer > (field.maximum ?? Number.MAX_VALUE)) return false;
  return field.kind === 'decimal' || Number.isSafeInteger(answer);
}

export async function validateServiceIntake(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  serviceKey: string,
  revision: number,
  answers: Readonly<Record<string, IntakeAnswer>>,
  options: ServiceTaxonomyOptions,
): Promise<ServiceTaxonomyResult<Readonly<Record<string, IntakeAnswer>>>> {
  const organizationId = await authorize(
    request, state, 'service-intake:submit', 'service-intake.validate', options,
  );
  if (!organizationId || !KEY.test(serviceKey) || !Number.isSafeInteger(revision) ||
    revision < 1 || !answers || Array.isArray(answers) ||
    Object.getPrototypeOf(answers) !== Object.prototype) return rejected();
  try {
    const definition = await options.store.getDefinition(organizationId, serviceKey, revision);
    if (!isBoundDefinition(definition, organizationId, serviceKey, revision) ||
      definition.status !== 'published') return rejected();
    const fields = new Map(definition.fields.map(field => [field.key, field]));
    const answerKeys = Object.keys(answers);
    if (answerKeys.some(key => !fields.has(key)) ||
      definition.fields.some(field =>
        field.required && !Object.prototype.hasOwnProperty.call(answers, field.key),
      ) ||
      answerKeys.some(key => !validAnswer(fields.get(key)!, answers[key]!))) return rejected();
    const normalized = Object.fromEntries(
      definition.fields
        .filter(field => Object.prototype.hasOwnProperty.call(answers, field.key))
        .map(field => [field.key, answers[field.key]!]),
    );
    return {accepted: true, value: Object.freeze(normalized)};
  } catch {
    return rejected();
  }
}
