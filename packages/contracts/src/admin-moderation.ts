import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const ADMIN_MODERATION_CONTRACT_VERSION = 1 as const;
export const ADMIN_MODERATION_REJECTED = 'admin_moderation_rejected' as const;

export type ModerationTargetType = 'profile' | 'review' | 'message' | 'transaction';
export type ModerationReason = 'abuse' | 'fraud' | 'safety' | 'spam' | 'support';
export type ModerationActionType =
  'open' | 'note' | 'restrict' | 'restore' | 'resolve' | 'dismiss';
export type ModerationCaseStatus = 'open' | 'restricted' | 'resolved' | 'dismissed';

export interface AdminModerationOperator {
  readonly organizationId: string;
  readonly subjectId: string;
  readonly status: 'active' | 'inactive';
  readonly permissions: readonly string[];
}

export interface ModerationCase {
  readonly caseId: string;
  readonly organizationId: string;
  readonly targetType: ModerationTargetType;
  readonly targetId: string;
  readonly status: ModerationCaseStatus;
  readonly version: number;
  readonly openedAt: number;
  readonly updatedAt: number;
}

export interface ModerationAction {
  readonly actionId: string;
  readonly organizationId: string;
  readonly requestKey: string;
  readonly caseId: string;
  readonly actorSubjectId: string;
  readonly targetType: ModerationTargetType;
  readonly targetId: string;
  readonly action: ModerationActionType;
  readonly reason: ModerationReason;
  readonly evidenceRefs: readonly string[];
  readonly caseVersion: number;
  readonly occurredAt: number;
}

export interface AdminModerationMutation {
  readonly moderationCase: ModerationCase;
  readonly action: ModerationAction;
}

export interface RecordModerationActionInput {
  readonly requestKey: string;
  readonly caseId: string | null;
  readonly targetType: ModerationTargetType;
  readonly targetId: string;
  readonly action: ModerationActionType;
  readonly reason: ModerationReason;
  readonly evidenceRefs: readonly string[];
  readonly expectedVersion: number;
}

export interface AdminModerationStore {
  getOperator(organizationId: string, subjectId: string):
    Promise<AdminModerationOperator | null>;
  getCase(organizationId: string, caseId: string): Promise<ModerationCase | null>;
  getActionByRequestKey(organizationId: string, requestKey: string):
    Promise<AdminModerationMutation | null>;
  commit(current: ModerationCase | null, mutation: AdminModerationMutation): Promise<boolean>;
}

export interface AdminModerationOptions {
  readonly store: AdminModerationStore;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
}

export type AdminModerationResult =
  | {readonly accepted: true; readonly value: AdminModerationMutation; readonly replayed: boolean}
  | {readonly accepted: false; readonly code: typeof ADMIN_MODERATION_REJECTED};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TARGETS = new Set<ModerationTargetType>(['profile', 'review', 'message', 'transaction']);
const REASONS = new Set<ModerationReason>(['abuse', 'fraud', 'safety', 'spam', 'support']);
const ACTIONS = new Set<ModerationActionType>(
  ['open', 'note', 'restrict', 'restore', 'resolve', 'dismiss']);
const STATUSES = new Set<ModerationCaseStatus>(['open', 'restricted', 'resolved', 'dismissed']);
const DATE = 8_640_000_000_000_000;
const rejected = (): AdminModerationResult =>
  ({accepted: false, code: ADMIN_MODERATION_REJECTED});
const integer = (value: number, minimum: number, maximum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;

function normalizedEvidence(values: readonly string[]): readonly string[] | null {
  if (values.length > 10 || values.some(value => !ID.test(value))) return null;
  const unique = [...new Set(values)].sort();
  return unique.length === values.length ? Object.freeze(unique) : null;
}

function nextStatus(current: ModerationCaseStatus | null,
  action: ModerationActionType): ModerationCaseStatus | null {
  if (current === null) return action === 'open' ? 'open' : null;
  if (current === 'resolved' || current === 'dismissed' || action === 'open') return null;
  if (action === 'note') return current;
  if (action === 'restrict') return current === 'open' ? 'restricted' : null;
  if (action === 'restore') return current === 'restricted' ? 'open' : null;
  if (action === 'resolve') return 'resolved';
  return action === 'dismiss' ? 'dismissed' : null;
}

function validCase(value: ModerationCase | null, organizationId: string): value is ModerationCase {
  return value?.organizationId === organizationId && ID.test(value.caseId) &&
    TARGETS.has(value.targetType) && ID.test(value.targetId) && STATUSES.has(value.status) &&
    integer(value.version, 1, Number.MAX_SAFE_INTEGER) &&
    integer(value.openedAt, 0, DATE) && integer(value.updatedAt, value.openedAt, DATE);
}

function validMutation(value: AdminModerationMutation | null, organizationId: string):
  value is AdminModerationMutation {
  if (!value || !validCase(value.moderationCase, organizationId)) return false;
  const action = value.action;
  return action.organizationId === organizationId && ID.test(action.actionId) &&
    ID.test(action.requestKey) && action.caseId === value.moderationCase.caseId &&
    ID.test(action.actorSubjectId) && action.targetType === value.moderationCase.targetType &&
    action.targetId === value.moderationCase.targetId && ACTIONS.has(action.action) &&
    REASONS.has(action.reason) && normalizedEvidence(action.evidenceRefs) !== null &&
    action.caseVersion === value.moderationCase.version &&
    action.occurredAt === value.moderationCase.updatedAt;
}

function exactReplay(value: AdminModerationMutation, input: RecordModerationActionInput,
  evidenceRefs: readonly string[]): boolean {
  return value.action.requestKey === input.requestKey &&
    value.moderationCase.caseId === (input.caseId ?? value.moderationCase.caseId) &&
    value.action.targetType === input.targetType && value.action.targetId === input.targetId &&
    value.action.action === input.action && value.action.reason === input.reason &&
    value.action.caseVersion === input.expectedVersion + 1 &&
    value.action.evidenceRefs.length === evidenceRefs.length &&
    value.action.evidenceRefs.every((item, index) => item === evidenceRefs[index]);
}

export async function recordAdminModerationAction(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: RecordModerationActionInput, options: AdminModerationOptions):
  Promise<AdminModerationResult> {
  const authorization = await authorizeAndAuditOrganizationAction(
    request, state, 'admin-moderation.record', options.audit);
  const now = options.now();
  const evidenceRefs = normalizedEvidence(input.evidenceRefs);
  if (!authorization.authorized || request.requiredPermission !== 'admin:moderation:write' ||
    contractVersion !== ADMIN_MODERATION_CONTRACT_VERSION || !ID.test(input.requestKey) ||
    (input.caseId !== null && !ID.test(input.caseId)) || !TARGETS.has(input.targetType) ||
    !ID.test(input.targetId) || !ACTIONS.has(input.action) || !REASONS.has(input.reason) ||
    evidenceRefs === null || !integer(input.expectedVersion, 0, Number.MAX_SAFE_INTEGER - 1) ||
    !integer(now, 0, DATE)) return rejected();

  try {
    const [operator, current, replay] = await Promise.all([
      options.store.getOperator(authorization.organizationId, authorization.subjectId),
      input.caseId === null ? Promise.resolve(null) :
        options.store.getCase(authorization.organizationId, input.caseId),
      options.store.getActionByRequestKey(authorization.organizationId, input.requestKey),
    ]);
    if (operator?.organizationId !== authorization.organizationId ||
      operator.subjectId !== authorization.subjectId || operator.status !== 'active' ||
      !operator.permissions.includes('admin:moderation:write')) return rejected();
    if (replay !== null) return validMutation(replay, authorization.organizationId) &&
      replay.action.actorSubjectId === authorization.subjectId &&
      exactReplay(replay, input, evidenceRefs)
      ? {accepted: true, value: replay, replayed: true} : rejected();
    if ((input.caseId === null && input.expectedVersion !== 0) ||
      (input.caseId !== null && (!validCase(current, authorization.organizationId) ||
        current.caseId !== input.caseId || current.targetType !== input.targetType ||
        current.targetId !== input.targetId || current.version !== input.expectedVersion ||
        current.updatedAt > now))) return rejected();
    const status = nextStatus(current?.status ?? null, input.action);
    if (status === null) return rejected();

    const caseId = current?.caseId ?? options.createOpaqueId();
    const actionId = options.createOpaqueId();
    if (!ID.test(caseId) || !ID.test(actionId) || caseId === actionId) return rejected();
    const moderationCase = Object.freeze({
      caseId, organizationId: authorization.organizationId,
      targetType: input.targetType, targetId: input.targetId, status,
      version: input.expectedVersion + 1, openedAt: current?.openedAt ?? now, updatedAt: now,
    });
    const action = Object.freeze({
      actionId, organizationId: authorization.organizationId, requestKey: input.requestKey,
      caseId, actorSubjectId: authorization.subjectId, targetType: input.targetType,
      targetId: input.targetId, action: input.action, reason: input.reason,
      evidenceRefs, caseVersion: moderationCase.version, occurredAt: now,
    });
    const mutation = Object.freeze({moderationCase, action});
    return validMutation(mutation, authorization.organizationId) &&
      await options.store.commit(current, mutation)
      ? {accepted: true, value: mutation, replayed: false} : rejected();
  } catch {
    return rejected();
  }
}
