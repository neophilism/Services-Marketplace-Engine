import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const FEATURE_FLAG_CONTRACT_VERSION = 1 as const;
export const FEATURE_FLAG_REJECTED = 'feature_flag_rejected' as const;

export type FeatureFlagEnvironment = 'development' | 'staging' | 'production';

export interface FeatureFlagOperator {
  readonly organizationId: string;
  readonly subjectId: string;
  readonly status: 'active' | 'inactive';
  readonly permissions: readonly string[];
}

export interface FeatureFlagConfiguration {
  readonly configurationId: string;
  readonly organizationId: string;
  readonly requestKey: string;
  readonly flagKey: string;
  readonly environment: FeatureFlagEnvironment;
  readonly enabled: boolean;
  readonly variantKey: string;
  readonly revision: number;
  readonly actorSubjectId: string;
  readonly changedAt: number;
}

export interface ConfigureFeatureFlagInput {
  readonly requestKey: string;
  readonly flagKey: string;
  readonly environment: FeatureFlagEnvironment;
  readonly enabled: boolean;
  readonly variantKey: string;
  readonly expectedRevision: number;
}

export interface FeatureFlagStore {
  getOperator(organizationId: string, subjectId: string): Promise<FeatureFlagOperator | null>;
  getCurrent(organizationId: string, flagKey: string, environment: FeatureFlagEnvironment):
    Promise<FeatureFlagConfiguration | null>;
  getByRequestKey(organizationId: string, requestKey: string):
    Promise<FeatureFlagConfiguration | null>;
  commit(current: FeatureFlagConfiguration | null,
    configuration: FeatureFlagConfiguration): Promise<boolean>;
}

export interface FeatureFlagOptions {
  readonly store: FeatureFlagStore;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
}

export type FeatureFlagResult =
  | {readonly accepted: true; readonly value: FeatureFlagConfiguration; readonly replayed: boolean}
  | {readonly accepted: false; readonly code: typeof FEATURE_FLAG_REJECTED};

export type FeatureFlagEvaluation =
  | {readonly accepted: true; readonly enabled: boolean; readonly variantKey: string;
      readonly revision: number}
  | {readonly accepted: false; readonly code: typeof FEATURE_FLAG_REJECTED};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FLAG_KEY = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){0,15}$/;
const ENVIRONMENTS = new Set<FeatureFlagEnvironment>(['development', 'staging', 'production']);
const DATE = 8_640_000_000_000_000;
const rejected = (): FeatureFlagResult => ({accepted: false, code: FEATURE_FLAG_REJECTED});
const evaluationRejected = (): FeatureFlagEvaluation =>
  ({accepted: false, code: FEATURE_FLAG_REJECTED});
const integer = (value: number, minimum: number, maximum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;

function validConfiguration(value: FeatureFlagConfiguration | null,
  organizationId: string): value is FeatureFlagConfiguration {
  return value?.organizationId === organizationId && ID.test(value.configurationId) &&
    ID.test(value.requestKey) && FLAG_KEY.test(value.flagKey) &&
    ENVIRONMENTS.has(value.environment) && typeof value.enabled === 'boolean' &&
    ID.test(value.variantKey) && integer(value.revision, 1, Number.MAX_SAFE_INTEGER) &&
    ID.test(value.actorSubjectId) && integer(value.changedAt, 0, DATE);
}

function exactReplay(value: FeatureFlagConfiguration, input: ConfigureFeatureFlagInput): boolean {
  return value.requestKey === input.requestKey && value.flagKey === input.flagKey &&
    value.environment === input.environment && value.enabled === input.enabled &&
    value.variantKey === input.variantKey && value.revision === input.expectedRevision + 1;
}

export async function configureFeatureFlag(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: ConfigureFeatureFlagInput, options: FeatureFlagOptions): Promise<FeatureFlagResult> {
  const authorization = await authorizeAndAuditOrganizationAction(
    request, state, 'feature-flags.configure', options.audit);
  const now = options.now();
  if (!authorization.authorized || request.requiredPermission !== 'feature-flags:write' ||
    contractVersion !== FEATURE_FLAG_CONTRACT_VERSION || !ID.test(input.requestKey) ||
    !FLAG_KEY.test(input.flagKey) || !ENVIRONMENTS.has(input.environment) ||
    typeof input.enabled !== 'boolean' || !ID.test(input.variantKey) ||
    !integer(input.expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1) ||
    !integer(now, 0, DATE)) return rejected();

  try {
    const [operator, current, replay] = await Promise.all([
      options.store.getOperator(authorization.organizationId, authorization.subjectId),
      options.store.getCurrent(authorization.organizationId, input.flagKey, input.environment),
      options.store.getByRequestKey(authorization.organizationId, input.requestKey),
    ]);
    if (operator?.organizationId !== authorization.organizationId ||
      operator.subjectId !== authorization.subjectId || operator.status !== 'active' ||
      !operator.permissions.includes('feature-flags:write')) return rejected();
    if (replay !== null) return validConfiguration(replay, authorization.organizationId) &&
      replay.actorSubjectId === authorization.subjectId && exactReplay(replay, input)
      ? {accepted: true, value: replay, replayed: true} : rejected();
    if ((current === null && input.expectedRevision !== 0) ||
      (current !== null && (!validConfiguration(current, authorization.organizationId) ||
        current.flagKey !== input.flagKey || current.environment !== input.environment ||
        current.revision !== input.expectedRevision || current.changedAt > now))) return rejected();

    const configurationId = options.createOpaqueId();
    if (!ID.test(configurationId)) return rejected();
    const configuration = Object.freeze({
      configurationId, organizationId: authorization.organizationId,
      requestKey: input.requestKey, flagKey: input.flagKey, environment: input.environment,
      enabled: input.enabled, variantKey: input.variantKey,
      revision: input.expectedRevision + 1, actorSubjectId: authorization.subjectId,
      changedAt: now,
    });
    return validConfiguration(configuration, authorization.organizationId) &&
      await options.store.commit(current, configuration)
      ? {accepted: true, value: configuration, replayed: false} : rejected();
  } catch {
    return rejected();
  }
}

export function evaluateFeatureFlag(contractVersion: number, organizationId: string,
  flagKey: string, environment: FeatureFlagEnvironment,
  configuration: FeatureFlagConfiguration | null): FeatureFlagEvaluation {
  if (contractVersion !== FEATURE_FLAG_CONTRACT_VERSION || !ID.test(organizationId) ||
    !FLAG_KEY.test(flagKey) || !ENVIRONMENTS.has(environment) ||
    !validConfiguration(configuration, organizationId) || configuration.flagKey !== flagKey ||
    configuration.environment !== environment) return evaluationRejected();
  return {accepted: true, enabled: configuration.enabled,
    variantKey: configuration.variantKey, revision: configuration.revision};
}
