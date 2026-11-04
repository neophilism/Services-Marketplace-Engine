import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const ASSISTANT_REGISTRY_CONTRACT_VERSION = 1 as const;
export const ASSISTANT_REGISTRY_REJECTED = 'assistant_registry_rejected' as const;

export interface AssistantRegistryOperator {
  readonly organizationId: string;
  readonly subjectId: string;
  readonly status: 'active' | 'inactive';
  readonly permissions: readonly string[];
}

export interface AssistantConfiguration {
  readonly configurationId: string;
  readonly organizationId: string;
  readonly requestKey: string;
  readonly assistantKey: string;
  readonly status: 'active' | 'disabled';
  readonly modelKey: string;
  readonly toolKeys: readonly string[];
  readonly instructionTemplateKey: string;
  readonly knowledgeSourceKeys: readonly string[];
  readonly revision: number;
  readonly actorSubjectId: string;
  readonly configuredAt: number;
}

export interface ConfigureAssistantInput {
  readonly requestKey: string;
  readonly assistantKey: string;
  readonly status: 'active' | 'disabled';
  readonly modelKey: string;
  readonly toolKeys: readonly string[];
  readonly instructionTemplateKey: string;
  readonly knowledgeSourceKeys: readonly string[];
  readonly expectedRevision: number;
}

export interface AssistantRegistryStore {
  getOperator(organizationId: string, subjectId: string):
    Promise<AssistantRegistryOperator | null>;
  getCurrent(organizationId: string, assistantKey: string):
    Promise<AssistantConfiguration | null>;
  getByRequestKey(organizationId: string, requestKey: string):
    Promise<AssistantConfiguration | null>;
  commit(current: AssistantConfiguration | null,
    configuration: AssistantConfiguration): Promise<boolean>;
}

export interface AssistantRegistryOptions {
  readonly store: AssistantRegistryStore;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
}

export type AssistantRegistryResult =
  | {readonly accepted: true; readonly value: AssistantConfiguration;
      readonly replayed: boolean}
  | {readonly accepted: false; readonly code: typeof ASSISTANT_REGISTRY_REJECTED};

export type AssistantResolutionResult =
  | {readonly accepted: true; readonly value: AssistantConfiguration}
  | {readonly accepted: false; readonly code: typeof ASSISTANT_REGISTRY_REJECTED};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){0,15}$/;
const DATE = 8_640_000_000_000_000;
const rejected = (): AssistantRegistryResult =>
  ({accepted: false, code: ASSISTANT_REGISTRY_REJECTED});
const resolutionRejected = (): AssistantResolutionResult =>
  ({accepted: false, code: ASSISTANT_REGISTRY_REJECTED});
const integer = (value: number, minimum: number, maximum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const orderedUniqueKeys = (values: readonly string[], maximum: number): boolean =>
  Array.isArray(values) && values.length <= maximum &&
  values.every((value, index) => KEY.test(value) &&
    (index === 0 || values[index - 1]! < value));

function validConfiguration(value: AssistantConfiguration | null,
  organizationId: string): value is AssistantConfiguration {
  return value?.organizationId === organizationId && ID.test(value.configurationId) &&
    ID.test(value.requestKey) && KEY.test(value.assistantKey) &&
    (value.status === 'active' || value.status === 'disabled') &&
    KEY.test(value.modelKey) && orderedUniqueKeys(value.toolKeys, 32) &&
    KEY.test(value.instructionTemplateKey) &&
    orderedUniqueKeys(value.knowledgeSourceKeys, 64) &&
    integer(value.revision, 1, Number.MAX_SAFE_INTEGER) &&
    ID.test(value.actorSubjectId) && integer(value.configuredAt, 0, DATE);
}

function exactReplay(value: AssistantConfiguration,
  input: ConfigureAssistantInput): boolean {
  return value.requestKey === input.requestKey &&
    value.assistantKey === input.assistantKey && value.status === input.status &&
    value.modelKey === input.modelKey &&
    value.toolKeys.length === input.toolKeys.length &&
    value.toolKeys.every((key, index) => key === input.toolKeys[index]) &&
    value.instructionTemplateKey === input.instructionTemplateKey &&
    value.knowledgeSourceKeys.length === input.knowledgeSourceKeys.length &&
    value.knowledgeSourceKeys.every((key, index) =>
      key === input.knowledgeSourceKeys[index]) &&
    value.revision === input.expectedRevision + 1;
}

export async function configureAssistant(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: ConfigureAssistantInput,
  options: AssistantRegistryOptions): Promise<AssistantRegistryResult> {
  const authorization = await authorizeAndAuditOrganizationAction(
    request, state, 'assistant-registry.configure', options.audit);
  const now = options.now();
  if (!authorization.authorized ||
    request.requiredPermission !== 'assistant-registry:write' ||
    contractVersion !== ASSISTANT_REGISTRY_CONTRACT_VERSION ||
    !ID.test(input.requestKey) || !KEY.test(input.assistantKey) ||
    (input.status !== 'active' && input.status !== 'disabled') ||
    !KEY.test(input.modelKey) || !orderedUniqueKeys(input.toolKeys, 32) ||
    !KEY.test(input.instructionTemplateKey) ||
    !orderedUniqueKeys(input.knowledgeSourceKeys, 64) ||
    !integer(input.expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1) ||
    !integer(now, 0, DATE)) return rejected();

  try {
    const [operator, current, replay] = await Promise.all([
      options.store.getOperator(authorization.organizationId, authorization.subjectId),
      options.store.getCurrent(authorization.organizationId, input.assistantKey),
      options.store.getByRequestKey(authorization.organizationId, input.requestKey),
    ]);
    if (operator?.organizationId !== authorization.organizationId ||
      operator.subjectId !== authorization.subjectId || operator.status !== 'active' ||
      !operator.permissions.includes('assistant-registry:write')) return rejected();
    if (replay !== null) return validConfiguration(replay, authorization.organizationId) &&
      replay.actorSubjectId === authorization.subjectId && exactReplay(replay, input)
      ? {accepted: true, value: replay, replayed: true} : rejected();
    if ((current === null && input.expectedRevision !== 0) ||
      (current !== null && (!validConfiguration(current, authorization.organizationId) ||
        current.assistantKey !== input.assistantKey ||
        current.revision !== input.expectedRevision || current.configuredAt > now)))
      return rejected();

    const configurationId = options.createOpaqueId();
    if (!ID.test(configurationId)) return rejected();
    const configuration = Object.freeze({
      configurationId, organizationId: authorization.organizationId,
      requestKey: input.requestKey, assistantKey: input.assistantKey,
      status: input.status, modelKey: input.modelKey,
      toolKeys: Object.freeze([...input.toolKeys]),
      instructionTemplateKey: input.instructionTemplateKey,
      knowledgeSourceKeys: Object.freeze([...input.knowledgeSourceKeys]),
      revision: input.expectedRevision + 1,
      actorSubjectId: authorization.subjectId, configuredAt: now,
    });
    return validConfiguration(configuration, authorization.organizationId) &&
      await options.store.commit(current, configuration)
      ? {accepted: true, value: configuration, replayed: false} : rejected();
  } catch {
    return rejected();
  }
}

export function resolveActiveAssistant(contractVersion: number, organizationId: string,
  assistantKey: string,
  configuration: AssistantConfiguration | null): AssistantResolutionResult {
  if (contractVersion !== ASSISTANT_REGISTRY_CONTRACT_VERSION ||
    !ID.test(organizationId) || !KEY.test(assistantKey) ||
    !validConfiguration(configuration, organizationId) ||
    configuration.assistantKey !== assistantKey || configuration.status !== 'active')
    return resolutionRejected();
  return {accepted: true, value: Object.freeze({...configuration,
    toolKeys: Object.freeze([...configuration.toolKeys]),
    knowledgeSourceKeys: Object.freeze([...configuration.knowledgeSourceKeys])})};
}
