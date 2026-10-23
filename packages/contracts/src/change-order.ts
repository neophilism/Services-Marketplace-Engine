import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const CHANGE_ORDER_CONTRACT_VERSION = 1 as const;
export const CHANGE_ORDER_REJECTED = 'change_order_rejected' as const;

export interface ChangeOrderRoom { readonly organizationId: string; readonly jobRoomId: string; readonly customerSubjectId: string; readonly status: 'active' | 'closed'; }
export interface ChangeOrderMember { readonly membershipId: string; readonly organizationId: string; readonly jobRoomId: string; readonly subjectId: string; readonly role: 'customer' | 'provider'; readonly status: 'active' | 'inactive'; }
export interface ApprovedEstimate { readonly estimateId: string; readonly organizationId: string; readonly jobRoomId: string; readonly currency: string; readonly status: 'approved' | 'superseded'; }
export interface ChangeOrderMilestone { readonly milestoneId: string; readonly label: string; readonly acceptanceCriteria: string; readonly amountDeltaMinor: number; readonly dueAt: number; }
export interface ChangeOrder { readonly changeOrderId: string; readonly organizationId: string; readonly requestKey: string; readonly jobRoomId: string; readonly estimateId: string; readonly providerMembershipId: string; readonly currency: string; readonly reason: string; readonly milestones: readonly ChangeOrderMilestone[]; readonly totalDeltaMinor: number; readonly acceptedMilestoneCount: number; readonly revision: number; readonly status: 'proposed' | 'partially_accepted' | 'accepted'; readonly createdAt: number; }
export interface ChangeOrderMilestoneAcceptance { readonly acceptanceId: string; readonly organizationId: string; readonly requestKey: string; readonly changeOrderId: string; readonly milestoneId: string; readonly milestoneIndex: number; readonly customerMembershipId: string; readonly customerSubjectId: string; readonly changeOrderRevision: number; readonly acceptedAt: number; }
export interface CreateChangeOrderInput { readonly requestKey: string; readonly jobRoomId: string; readonly estimateId: string; readonly currency: string; readonly reason: string; readonly milestones: readonly ChangeOrderMilestone[]; }
export interface AcceptChangeOrderMilestoneInput { readonly requestKey: string; readonly jobRoomId: string; readonly changeOrderId: string; readonly milestoneId: string; readonly expectedRevision: number; }
export interface ChangeOrderStore {
  getRoom(organizationId: string, jobRoomId: string): Promise<ChangeOrderRoom | null>;
  getMembership(organizationId: string, jobRoomId: string, subjectId: string): Promise<ChangeOrderMember | null>;
  getApprovedEstimate(organizationId: string, estimateId: string): Promise<ApprovedEstimate | null>;
  getChangeOrder(organizationId: string, changeOrderId: string): Promise<ChangeOrder | null>;
  getChangeOrderByRequestKey(organizationId: string, requestKey: string): Promise<ChangeOrder | null>;
  createChangeOrder(value: ChangeOrder): Promise<boolean>;
  getAcceptanceByRequestKey(organizationId: string, requestKey: string): Promise<ChangeOrderMilestoneAcceptance | null>;
  acceptMilestone(before: ChangeOrder, after: ChangeOrder, acceptance: ChangeOrderMilestoneAcceptance): Promise<boolean>;
}
export interface ChangeOrderOptions { readonly store: ChangeOrderStore; readonly audit: TenantAuditOptions; readonly createOpaqueId: () => string; readonly now: () => number; }
export type ChangeOrderResult<T> = {readonly accepted: true; readonly value: T; readonly replayed: boolean} | {readonly accepted: false; readonly code: typeof CHANGE_ORDER_REJECTED};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CURRENCY = /^[A-Z]{3}$/;
const TEXT = /^[\x20-\x7e]+$/;
const MAX_MINOR = 1_000_000_000_000;
const MAX_DATE = 8_640_000_000_000_000;
const rejected = <T>(): ChangeOrderResult<T> => ({accepted: false, code: CHANGE_ORDER_REJECTED});
const time = (value: number): boolean => Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE;
const text = (value: string, maximum: number): boolean => value === value.trim() && value.length > 0 && value.length <= maximum && TEXT.test(value);

function validMilestones(values: readonly ChangeOrderMilestone[], createdAt: number): boolean {
  if (values.length < 1 || values.length > 25) return false;
  const ids = new Set<string>(); let previousDueAt = createdAt;
  return values.every(value => {
    const valid = ID.test(value.milestoneId) && !ids.has(value.milestoneId) && text(value.label, 120) && text(value.acceptanceCriteria, 500) && Number.isSafeInteger(value.amountDeltaMinor) && Math.abs(value.amountDeltaMinor) <= MAX_MINOR && time(value.dueAt) && value.dueAt > previousDueAt;
    ids.add(value.milestoneId); previousDueAt = value.dueAt; return valid;
  });
}
function totalDelta(values: readonly ChangeOrderMilestone[]): number | null {
  let total = 0; for (const value of values) { total += value.amountDeltaMinor; if (!Number.isSafeInteger(total) || Math.abs(total) > MAX_MINOR) return null; } return total;
}
function boundOrder(value: ChangeOrder | null, organizationId: string): value is ChangeOrder {
  if (value?.organizationId !== organizationId || !ID.test(value.changeOrderId) || !ID.test(value.requestKey) || !ID.test(value.jobRoomId) || !ID.test(value.estimateId) || !ID.test(value.providerMembershipId) || !CURRENCY.test(value.currency) || !text(value.reason, 1_000) || !time(value.createdAt) || !validMilestones(value.milestones, value.createdAt) || totalDelta(value.milestones) !== value.totalDeltaMinor || !Number.isSafeInteger(value.acceptedMilestoneCount) || value.acceptedMilestoneCount < 0 || value.acceptedMilestoneCount > value.milestones.length || value.revision !== value.acceptedMilestoneCount + 1) return false;
  const status = value.acceptedMilestoneCount === 0 ? 'proposed' : value.acceptedMilestoneCount === value.milestones.length ? 'accepted' : 'partially_accepted'; return value.status === status;
}
function matchesOrder(value: ChangeOrder, input: CreateChangeOrderInput, membershipId: string): boolean {
  return value.requestKey === input.requestKey && value.jobRoomId === input.jobRoomId && value.estimateId === input.estimateId && value.providerMembershipId === membershipId && value.currency === input.currency && value.reason === input.reason && value.milestones.length === input.milestones.length && value.milestones.every((milestone, index) => { const requested = input.milestones[index]; return requested !== undefined && milestone.milestoneId === requested.milestoneId && milestone.label === requested.label && milestone.acceptanceCriteria === requested.acceptanceCriteria && milestone.amountDeltaMinor === requested.amountDeltaMinor && milestone.dueAt === requested.dueAt; });
}
function boundAcceptance(value: ChangeOrderMilestoneAcceptance | null, organizationId: string): value is ChangeOrderMilestoneAcceptance {
  return value?.organizationId === organizationId && ID.test(value.acceptanceId) && ID.test(value.requestKey) && ID.test(value.changeOrderId) && ID.test(value.milestoneId) && Number.isSafeInteger(value.milestoneIndex) && value.milestoneIndex >= 0 && ID.test(value.customerMembershipId) && ID.test(value.customerSubjectId) && Number.isSafeInteger(value.changeOrderRevision) && value.changeOrderRevision >= 2 && time(value.acceptedAt);
}

export async function createChangeOrder(contractVersion: number, request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState, input: CreateChangeOrderInput, options: ChangeOrderOptions): Promise<ChangeOrderResult<ChangeOrder>> {
  const authorization = await authorizeAndAuditOrganizationAction(request, state, 'job-room.change-order.create', options.audit); const now = options.now(); const delta = totalDelta(input.milestones);
  if (!authorization.authorized || request.requiredPermission !== 'job-rooms:change-orders:create' || contractVersion !== CHANGE_ORDER_CONTRACT_VERSION || !time(now) || !ID.test(input.requestKey) || !ID.test(input.jobRoomId) || !ID.test(input.estimateId) || !CURRENCY.test(input.currency) || !text(input.reason, 1_000) || !validMilestones(input.milestones, now) || delta === null) return rejected();
  try {
    const [room, member, estimate, replay] = await Promise.all([options.store.getRoom(authorization.organizationId, input.jobRoomId), options.store.getMembership(authorization.organizationId, input.jobRoomId, authorization.subjectId), options.store.getApprovedEstimate(authorization.organizationId, input.estimateId), options.store.getChangeOrderByRequestKey(authorization.organizationId, input.requestKey)]);
    if (room?.organizationId !== authorization.organizationId || room.jobRoomId !== input.jobRoomId || room.status !== 'active' || !ID.test(room.customerSubjectId) || member?.organizationId !== authorization.organizationId || member.jobRoomId !== input.jobRoomId || member.subjectId !== authorization.subjectId || member.role !== 'provider' || member.status !== 'active' || estimate?.organizationId !== authorization.organizationId || estimate.jobRoomId !== input.jobRoomId || estimate.estimateId !== input.estimateId || estimate.status !== 'approved' || estimate.currency !== input.currency) return rejected();
    if (replay !== null) return boundOrder(replay, authorization.organizationId) && matchesOrder(replay, input, member.membershipId) ? {accepted: true, value: replay, replayed: true} : rejected();
    const changeOrderId = options.createOpaqueId(); if (!ID.test(changeOrderId)) return rejected();
    const value: ChangeOrder = Object.freeze({changeOrderId, organizationId: authorization.organizationId, requestKey: input.requestKey, jobRoomId: input.jobRoomId, estimateId: input.estimateId, providerMembershipId: member.membershipId, currency: input.currency, reason: input.reason, milestones: Object.freeze(input.milestones.map(value => Object.freeze({...value}))), totalDeltaMinor: delta, acceptedMilestoneCount: 0, revision: 1, status: 'proposed', createdAt: now});
    return boundOrder(value, authorization.organizationId) && await options.store.createChangeOrder(value) ? {accepted: true, value, replayed: false} : rejected();
  } catch { return rejected(); }
}

export async function acceptChangeOrderMilestone(contractVersion: number, request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState, input: AcceptChangeOrderMilestoneInput, options: ChangeOrderOptions): Promise<ChangeOrderResult<ChangeOrderMilestoneAcceptance>> {
  const authorization = await authorizeAndAuditOrganizationAction(request, state, 'job-room.change-order.milestone.accept', options.audit); const now = options.now();
  if (!authorization.authorized || request.requiredPermission !== 'job-rooms:change-orders:accept' || contractVersion !== CHANGE_ORDER_CONTRACT_VERSION || !time(now) || !ID.test(input.requestKey) || !ID.test(input.jobRoomId) || !ID.test(input.changeOrderId) || !ID.test(input.milestoneId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) return rejected();
  try {
    const [room, member, order, replay] = await Promise.all([options.store.getRoom(authorization.organizationId, input.jobRoomId), options.store.getMembership(authorization.organizationId, input.jobRoomId, authorization.subjectId), options.store.getChangeOrder(authorization.organizationId, input.changeOrderId), options.store.getAcceptanceByRequestKey(authorization.organizationId, input.requestKey)]);
    if (room?.organizationId !== authorization.organizationId || room.jobRoomId !== input.jobRoomId || room.status !== 'active' || room.customerSubjectId !== authorization.subjectId || member?.organizationId !== authorization.organizationId || member.jobRoomId !== input.jobRoomId || member.subjectId !== authorization.subjectId || member.role !== 'customer' || member.status !== 'active' || !boundOrder(order, authorization.organizationId) || order.jobRoomId !== input.jobRoomId || order.changeOrderId !== input.changeOrderId) return rejected();
    if (replay !== null) { const milestone = order.milestones[replay.milestoneIndex]; return boundAcceptance(replay, authorization.organizationId) && replay.requestKey === input.requestKey && replay.changeOrderId === input.changeOrderId && replay.milestoneId === input.milestoneId && replay.customerMembershipId === member.membershipId && replay.customerSubjectId === authorization.subjectId && replay.changeOrderRevision === input.expectedRevision + 1 && milestone?.milestoneId === input.milestoneId && order.revision >= replay.changeOrderRevision ? {accepted: true, value: replay, replayed: true} : rejected(); }
    const milestone = order.milestones[order.acceptedMilestoneCount]; if (order.revision !== input.expectedRevision || milestone?.milestoneId !== input.milestoneId) return rejected();
    const acceptanceId = options.createOpaqueId(); if (!ID.test(acceptanceId)) return rejected();
    const acceptedMilestoneCount = order.acceptedMilestoneCount + 1; const revision = order.revision + 1;
    const after: ChangeOrder = Object.freeze({...order, acceptedMilestoneCount, revision, status: acceptedMilestoneCount === order.milestones.length ? 'accepted' : 'partially_accepted'});
    const acceptance: ChangeOrderMilestoneAcceptance = Object.freeze({acceptanceId, organizationId: authorization.organizationId, requestKey: input.requestKey, changeOrderId: order.changeOrderId, milestoneId: milestone.milestoneId, milestoneIndex: order.acceptedMilestoneCount, customerMembershipId: member.membershipId, customerSubjectId: authorization.subjectId, changeOrderRevision: revision, acceptedAt: now});
    return boundOrder(after, authorization.organizationId) && boundAcceptance(acceptance, authorization.organizationId) && await options.store.acceptMilestone(order, after, acceptance) ? {accepted: true, value: acceptance, replayed: false} : rejected();
  } catch { return rejected(); }
}
