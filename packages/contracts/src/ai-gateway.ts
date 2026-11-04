import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const AI_GATEWAY_CONTRACT_VERSION = 1 as const;
export const AI_GATEWAY_REJECTED = 'ai_gateway_rejected' as const;

export interface AIGatewayOperator {
  readonly organizationId: string;
  readonly subjectId: string;
  readonly status: 'active' | 'inactive';
  readonly permissions: readonly string[];
}

export interface AIGatewayQuota {
  readonly organizationId: string;
  readonly quotaKey: string;
  readonly periodStartsAt: number;
  readonly periodEndsAt: number;
  readonly revision: number;
  readonly maximumRequests: number;
  readonly maximumInputTokens: number;
  readonly maximumOutputTokens: number;
  readonly maximumInputTokensPerRequest: number;
  readonly maximumOutputTokensPerRequest: number;
  readonly usedRequests: number;
  readonly usedInputTokens: number;
  readonly usedOutputTokens: number;
  readonly allowedModelKeys: readonly string[];
  readonly allowedToolKeys: readonly string[];
}

export interface ReserveAIInvocationInput {
  readonly requestKey: string;
  readonly quotaKey: string;
  readonly modelKey: string;
  readonly toolKeys: readonly string[];
  readonly maximumInputTokens: number;
  readonly maximumOutputTokens: number;
}

export interface AIInvocationReservation {
  readonly reservationId: string;
  readonly organizationId: string;
  readonly actorSubjectId: string;
  readonly requestKey: string;
  readonly quotaKey: string;
  readonly modelKey: string;
  readonly toolKeys: readonly string[];
  readonly maximumInputTokens: number;
  readonly maximumOutputTokens: number;
  readonly quotaRevision: number;
  readonly reservedAt: number;
}

export interface AIGatewayStore {
  getOperator(organizationId: string, subjectId: string): Promise<AIGatewayOperator | null>;
  getQuota(organizationId: string, quotaKey: string): Promise<AIGatewayQuota | null>;
  getByRequestKey(organizationId: string, requestKey: string):
    Promise<AIInvocationReservation | null>;
  commit(expected: AIGatewayQuota, next: AIGatewayQuota,
    reservation: AIInvocationReservation): Promise<boolean>;
}

export interface AIGatewayOptions {
  readonly store: AIGatewayStore;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
}

export type AIGatewayResult =
  | {readonly accepted: true; readonly value: AIInvocationReservation;
      readonly replayed: boolean}
  | {readonly accepted: false; readonly code: typeof AI_GATEWAY_REJECTED};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){0,15}$/;
const DATE = 8_640_000_000_000_000;
const TOKEN_LIMIT = 1_000_000;
const rejected = (): AIGatewayResult => ({accepted: false, code: AI_GATEWAY_REJECTED});
const integer = (value: number, minimum: number, maximum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const uniqueKeys = (values: readonly string[], maximum: number): boolean =>
  Array.isArray(values) && values.length <= maximum &&
  values.every((value, index) => KEY.test(value) &&
    (index === 0 || values[index - 1]! < value));

function validQuota(value: AIGatewayQuota | null,
  organizationId: string, quotaKey: string): value is AIGatewayQuota {
  return value?.organizationId === organizationId && value.quotaKey === quotaKey &&
    KEY.test(value.quotaKey) && integer(value.periodStartsAt, 0, DATE) &&
    integer(value.periodEndsAt, 1, DATE) && value.periodStartsAt < value.periodEndsAt &&
    integer(value.revision, 1, Number.MAX_SAFE_INTEGER - 1) &&
    integer(value.maximumRequests, 1, Number.MAX_SAFE_INTEGER) &&
    integer(value.maximumInputTokens, 1, Number.MAX_SAFE_INTEGER) &&
    integer(value.maximumOutputTokens, 1, Number.MAX_SAFE_INTEGER) &&
    integer(value.maximumInputTokensPerRequest, 1, TOKEN_LIMIT) &&
    integer(value.maximumOutputTokensPerRequest, 1, TOKEN_LIMIT) &&
    value.maximumInputTokensPerRequest <= value.maximumInputTokens &&
    value.maximumOutputTokensPerRequest <= value.maximumOutputTokens &&
    integer(value.usedRequests, 0, value.maximumRequests) &&
    integer(value.usedInputTokens, 0, value.maximumInputTokens) &&
    integer(value.usedOutputTokens, 0, value.maximumOutputTokens) &&
    uniqueKeys(value.allowedModelKeys, 64) && value.allowedModelKeys.length > 0 &&
    uniqueKeys(value.allowedToolKeys, 128);
}

function validReservation(value: AIInvocationReservation | null,
  organizationId: string): value is AIInvocationReservation {
  return value?.organizationId === organizationId && ID.test(value.reservationId) &&
    ID.test(value.actorSubjectId) && ID.test(value.requestKey) && KEY.test(value.quotaKey) &&
    KEY.test(value.modelKey) && uniqueKeys(value.toolKeys, 32) &&
    integer(value.maximumInputTokens, 1, TOKEN_LIMIT) &&
    integer(value.maximumOutputTokens, 1, TOKEN_LIMIT) &&
    integer(value.quotaRevision, 2, Number.MAX_SAFE_INTEGER) &&
    integer(value.reservedAt, 0, DATE);
}

function exactReplay(value: AIInvocationReservation,
  input: ReserveAIInvocationInput): boolean {
  return value.requestKey === input.requestKey && value.quotaKey === input.quotaKey &&
    value.modelKey === input.modelKey &&
    value.toolKeys.length === input.toolKeys.length &&
    value.toolKeys.every((tool, index) => tool === input.toolKeys[index]) &&
    value.maximumInputTokens === input.maximumInputTokens &&
    value.maximumOutputTokens === input.maximumOutputTokens;
}

export async function reserveAIInvocation(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: ReserveAIInvocationInput, options: AIGatewayOptions): Promise<AIGatewayResult> {
  try {
    const authorization = await authorizeAndAuditOrganizationAction(
    request, state, 'ai-gateway.reserve', options.audit);
  const now = options.now();
  if (!authorization.authorized || request.requiredPermission !== 'ai-gateway:invoke' ||
    contractVersion !== AI_GATEWAY_CONTRACT_VERSION || !ID.test(input.requestKey) ||
    !KEY.test(input.quotaKey) || !KEY.test(input.modelKey) ||
    !uniqueKeys(input.toolKeys, 32) ||
    !integer(input.maximumInputTokens, 1, TOKEN_LIMIT) ||
    !integer(input.maximumOutputTokens, 1, TOKEN_LIMIT) ||
    !integer(now, 0, DATE)) return rejected();

    const [operator, quota, replay] = await Promise.all([
      options.store.getOperator(authorization.organizationId, authorization.subjectId),
      options.store.getQuota(authorization.organizationId, input.quotaKey),
      options.store.getByRequestKey(authorization.organizationId, input.requestKey),
    ]);
    if (operator?.organizationId !== authorization.organizationId ||
      operator.subjectId !== authorization.subjectId || operator.status !== 'active' ||
      !operator.permissions.includes('ai-gateway:invoke')) return rejected();
    if (replay !== null) return validReservation(replay, authorization.organizationId) &&
      replay.actorSubjectId === authorization.subjectId && exactReplay(replay, input)
      ? {accepted: true, value: replay, replayed: true} : rejected();
    if (!validQuota(quota, authorization.organizationId, input.quotaKey) ||
      now < quota.periodStartsAt || now >= quota.periodEndsAt ||
      !quota.allowedModelKeys.includes(input.modelKey) ||
      input.toolKeys.some(tool => !quota.allowedToolKeys.includes(tool)) ||
      input.maximumInputTokens > quota.maximumInputTokensPerRequest ||
      input.maximumOutputTokens > quota.maximumOutputTokensPerRequest ||
      quota.usedRequests >= quota.maximumRequests ||
      quota.usedInputTokens > quota.maximumInputTokens - input.maximumInputTokens ||
      quota.usedOutputTokens > quota.maximumOutputTokens - input.maximumOutputTokens)
      return rejected();

    const reservationId = options.createOpaqueId();
    if (!ID.test(reservationId)) return rejected();
    const reservation = Object.freeze({
      reservationId, organizationId: authorization.organizationId,
      actorSubjectId: authorization.subjectId, requestKey: input.requestKey,
      quotaKey: input.quotaKey, modelKey: input.modelKey,
      toolKeys: Object.freeze([...input.toolKeys]),
      maximumInputTokens: input.maximumInputTokens,
      maximumOutputTokens: input.maximumOutputTokens,
      quotaRevision: quota.revision + 1, reservedAt: now,
    });
    const next = Object.freeze({...quota, revision: quota.revision + 1,
      usedRequests: quota.usedRequests + 1,
      usedInputTokens: quota.usedInputTokens + input.maximumInputTokens,
      usedOutputTokens: quota.usedOutputTokens + input.maximumOutputTokens});
    return validReservation(reservation, authorization.organizationId) &&
      validQuota(next, authorization.organizationId, input.quotaKey) &&
      await options.store.commit(quota, next, reservation)
      ? {accepted: true, value: reservation, replayed: false} : rejected();
  } catch {
    return rejected();
  }
}
