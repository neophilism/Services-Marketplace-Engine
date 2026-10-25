import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const FUNNEL_ATTRIBUTION_CONTRACT_VERSION = 1 as const;
export const FUNNEL_ATTRIBUTION_REJECTED = 'funnel_attribution_rejected' as const;
export type FunnelStage = 'awareness' | 'lead' | 'quote' | 'booking' | 'completed';

export interface FunnelRelationship {
  readonly organizationId: string;
  readonly crmRecordId: string;
  readonly providerOrganizationId: string;
  readonly status: 'active' | 'inactive';
}
export interface FunnelOperator {
  readonly organizationId: string;
  readonly providerOrganizationId: string;
  readonly subjectId: string;
  readonly status: 'active' | 'inactive';
  readonly permissions: readonly string[];
}
export interface FunnelTouch {
  readonly source: string;
  readonly campaign: string | null;
}
export interface FunnelEvent {
  readonly eventId: string;
  readonly organizationId: string;
  readonly requestKey: string;
  readonly crmRecordId: string;
  readonly providerOrganizationId: string;
  readonly actorSubjectId: string;
  readonly stage: FunnelStage;
  readonly touch: FunnelTouch;
  readonly occurredAt: number;
}
export interface FunnelSnapshot {
  readonly snapshotId: string;
  readonly organizationId: string;
  readonly crmRecordId: string;
  readonly providerOrganizationId: string;
  readonly stage: FunnelStage;
  readonly firstTouch: FunnelTouch;
  readonly lastTouch: FunnelTouch;
  readonly eventCount: number;
  readonly version: number;
  readonly firstEventAt: number;
  readonly lastEventAt: number;
}
export interface FunnelMutation {
  readonly event: FunnelEvent;
  readonly snapshot: FunnelSnapshot;
}
export interface RecordFunnelEventInput {
  readonly requestKey: string;
  readonly crmRecordId: string;
  readonly stage: FunnelStage;
  readonly source: string;
  readonly campaign: string | null;
  readonly occurredAt: number;
  readonly expectedVersion: number;
}
export interface FunnelAttributionStore {
  getRelationship(organizationId: string, crmRecordId: string): Promise<FunnelRelationship | null>;
  getOperator(organizationId: string, providerOrganizationId: string, subjectId: string):
    Promise<FunnelOperator | null>;
  getSnapshot(organizationId: string, crmRecordId: string): Promise<FunnelSnapshot | null>;
  getEventByRequestKey(organizationId: string, requestKey: string): Promise<FunnelMutation | null>;
  commit(current: FunnelSnapshot | null, mutation: FunnelMutation): Promise<boolean>;
}
export interface FunnelAttributionOptions {
  readonly store: FunnelAttributionStore;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
}
export type FunnelAttributionResult =
  | {readonly accepted: true; readonly value: FunnelMutation; readonly replayed: boolean}
  | {readonly accepted: false; readonly code: typeof FUNNEL_ATTRIBUTION_REJECTED};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY = /^[a-z][a-z0-9._:-]{0,63}$/;
const STAGES: readonly FunnelStage[] = ['awareness', 'lead', 'quote', 'booking', 'completed'];
const DATE = 8_640_000_000_000_000;
const rejected = (): FunnelAttributionResult =>
  ({accepted: false, code: FUNNEL_ATTRIBUTION_REJECTED});
const integer = (value: number, min: number, max: number): boolean =>
  Number.isSafeInteger(value) && value >= min && value <= max;
const validTouch = (value: FunnelTouch): boolean =>
  KEY.test(value.source) && (value.campaign === null || KEY.test(value.campaign));
const sameTouch = (left: FunnelTouch, right: FunnelTouch): boolean =>
  left.source === right.source && left.campaign === right.campaign;

function validSnapshot(value: FunnelSnapshot | null, organizationId: string,
  crmRecordId: string, providerOrganizationId: string): value is FunnelSnapshot {
  return value?.organizationId === organizationId && value.crmRecordId === crmRecordId &&
    value.providerOrganizationId === providerOrganizationId && ID.test(value.snapshotId) &&
    STAGES.includes(value.stage) && validTouch(value.firstTouch) && validTouch(value.lastTouch) &&
    integer(value.eventCount, 1, Number.MAX_SAFE_INTEGER) &&
    integer(value.version, 1, Number.MAX_SAFE_INTEGER) && value.eventCount === value.version &&
    integer(value.firstEventAt, 0, DATE) &&
    integer(value.lastEventAt, value.firstEventAt, DATE);
}
function validMutation(value: FunnelMutation | null, organizationId: string):
  value is FunnelMutation {
  if (!value || !validSnapshot(value.snapshot, organizationId, value.snapshot.crmRecordId,
    value.snapshot.providerOrganizationId)) return false;
  const event = value.event;
  return event.organizationId === organizationId && ID.test(event.eventId) &&
    ID.test(event.requestKey) && event.crmRecordId === value.snapshot.crmRecordId &&
    event.providerOrganizationId === value.snapshot.providerOrganizationId &&
    ID.test(event.actorSubjectId) && STAGES.includes(event.stage) &&
    event.stage === value.snapshot.stage && validTouch(event.touch) &&
    event.occurredAt === value.snapshot.lastEventAt &&
    sameTouch(event.touch, value.snapshot.lastTouch);
}
function exactReplay(value: FunnelMutation, input: RecordFunnelEventInput): boolean {
  return value.event.requestKey === input.requestKey &&
    value.event.crmRecordId === input.crmRecordId && value.event.stage === input.stage &&
    value.event.touch.source === input.source &&
    value.event.touch.campaign === input.campaign &&
    value.event.occurredAt === input.occurredAt &&
    value.snapshot.version === input.expectedVersion + 1;
}

export async function recordFunnelAttributionEvent(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: RecordFunnelEventInput, options: FunnelAttributionOptions):
  Promise<FunnelAttributionResult> {
  const authorization = await authorizeAndAuditOrganizationAction(
    request, state, 'funnel-attribution.record', options.audit);
  const now = options.now();
  const touch = Object.freeze({source: input.source, campaign: input.campaign});
  if (!authorization.authorized || request.requiredPermission !== 'analytics:funnel:write' ||
    contractVersion !== FUNNEL_ATTRIBUTION_CONTRACT_VERSION ||
    !ID.test(input.requestKey) || !ID.test(input.crmRecordId) ||
    !STAGES.includes(input.stage) || !validTouch(touch) ||
    !integer(input.occurredAt, 0, DATE) || input.occurredAt > now ||
    !integer(now, 0, DATE) ||
    !integer(input.expectedVersion, 0, Number.MAX_SAFE_INTEGER - 1)) return rejected();
  try {
    const relationship = await options.store.getRelationship(
      authorization.organizationId, input.crmRecordId);
    if (relationship?.organizationId !== authorization.organizationId ||
      relationship.crmRecordId !== input.crmRecordId ||
      !ID.test(relationship.providerOrganizationId) || relationship.status !== 'active') {
      return rejected();
    }
    const [operator, current, replay] = await Promise.all([
      options.store.getOperator(authorization.organizationId,
        relationship.providerOrganizationId, authorization.subjectId),
      options.store.getSnapshot(authorization.organizationId, input.crmRecordId),
      options.store.getEventByRequestKey(authorization.organizationId, input.requestKey),
    ]);
    if (operator?.organizationId !== authorization.organizationId ||
      operator.providerOrganizationId !== relationship.providerOrganizationId ||
      operator.subjectId !== authorization.subjectId || operator.status !== 'active' ||
      !operator.permissions.includes('analytics:funnel:write')) return rejected();
    if (replay !== null) return validMutation(replay, authorization.organizationId) &&
      replay.event.actorSubjectId === authorization.subjectId && exactReplay(replay, input)
      ? {accepted: true, value: replay, replayed: true} : rejected();
    if ((current === null && input.expectedVersion !== 0) ||
      (current !== null && (!validSnapshot(current, authorization.organizationId,
        input.crmRecordId, relationship.providerOrganizationId) ||
        current.version !== input.expectedVersion ||
        input.occurredAt < current.lastEventAt ||
        STAGES.indexOf(input.stage) < STAGES.indexOf(current.stage)))) return rejected();

    const snapshotId = current?.snapshotId ?? options.createOpaqueId();
    const eventId = options.createOpaqueId();
    if (!ID.test(snapshotId) || !ID.test(eventId) || snapshotId === eventId) return rejected();
    const event = Object.freeze({
      eventId, organizationId: authorization.organizationId, requestKey: input.requestKey,
      crmRecordId: input.crmRecordId,
      providerOrganizationId: relationship.providerOrganizationId,
      actorSubjectId: authorization.subjectId, stage: input.stage, touch,
      occurredAt: input.occurredAt,
    });
    const snapshot = Object.freeze({
      snapshotId, organizationId: authorization.organizationId,
      crmRecordId: input.crmRecordId,
      providerOrganizationId: relationship.providerOrganizationId, stage: input.stage,
      firstTouch: current?.firstTouch ?? touch, lastTouch: touch,
      eventCount: (current?.eventCount ?? 0) + 1, version: input.expectedVersion + 1,
      firstEventAt: current?.firstEventAt ?? input.occurredAt,
      lastEventAt: input.occurredAt,
    });
    const mutation = Object.freeze({event, snapshot});
    return validMutation(mutation, authorization.organizationId) &&
      await options.store.commit(current, mutation)
      ? {accepted: true, value: mutation, replayed: false} : rejected();
  } catch {
    return rejected();
  }
}
