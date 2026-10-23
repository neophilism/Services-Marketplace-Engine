import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const JOB_ROOM_CHAT_CONTRACT_VERSION = 1 as const;
export const JOB_ROOM_CHAT_REJECTED = 'job_room_chat_rejected' as const;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_BODY_LENGTH = 4_000;
const MAX_ROOM_MEMBERS = 100;

export interface ChatJobRoom { readonly organizationId: string; readonly jobRoomId: string; readonly status: 'active' | 'closed'; }
export interface ChatJobRoomMembership { readonly membershipId: string; readonly organizationId: string; readonly jobRoomId: string; readonly subjectId: string; readonly role: 'customer' | 'provider'; }
export interface JobRoomMessage { readonly messageId: string; readonly organizationId: string; readonly requestKey: string; readonly jobRoomId: string; readonly senderMembershipId: string; readonly senderSubjectId: string; readonly body: string; readonly createdAt: number; }
export interface JobRoomMessageNotification { readonly notificationId: string; readonly organizationId: string; readonly eventType: 'job-room.message.created'; readonly jobRoomId: string; readonly messageId: string; readonly recipientSubjectId: string; readonly occurredAt: number; }
export type JobRoomReceiptStatus = 'delivered' | 'read';
export interface JobRoomMessageReceipt { readonly receiptId: string; readonly organizationId: string; readonly requestKey: string; readonly jobRoomId: string; readonly messageId: string; readonly membershipId: string; readonly subjectId: string; readonly status: JobRoomReceiptStatus; readonly occurredAt: number; }
export interface SendJobRoomMessageInput { readonly requestKey: string; readonly jobRoomId: string; readonly body: string; }
export interface RecordJobRoomReceiptInput { readonly requestKey: string; readonly jobRoomId: string; readonly messageId: string; readonly status: JobRoomReceiptStatus; }

export interface JobRoomChatStore {
  getJobRoom(organizationId: string, jobRoomId: string): Promise<ChatJobRoom | null>;
  getMembership(organizationId: string, jobRoomId: string, subjectId: string): Promise<ChatJobRoomMembership | null>;
  listMemberships(organizationId: string, jobRoomId: string): Promise<readonly ChatJobRoomMembership[]>;
  getMessage(organizationId: string, messageId: string): Promise<JobRoomMessage | null>;
  getMessageByRequestKey(organizationId: string, requestKey: string): Promise<JobRoomMessage | null>;
  createMessage(message: JobRoomMessage, notifications: readonly JobRoomMessageNotification[]): Promise<boolean>;
  getReceiptByRequestKey(organizationId: string, requestKey: string): Promise<JobRoomMessageReceipt | null>;
  getReceipt(organizationId: string, messageId: string, membershipId: string): Promise<JobRoomMessageReceipt | null>;
  advanceReceipt(receipt: JobRoomMessageReceipt, previousReceiptId: string | null): Promise<boolean>;
}

export interface JobRoomChatOptions { readonly store: JobRoomChatStore; readonly audit: TenantAuditOptions; readonly createOpaqueId: () => string; readonly now: () => number; }
export type JobRoomChatResult<T> = {readonly accepted: true; readonly value: T; readonly replayed: boolean} | {readonly accepted: false; readonly code: typeof JOB_ROOM_CHAT_REJECTED};

const rejected = <T>(): JobRoomChatResult<T> => ({accepted: false, code: JOB_ROOM_CHAT_REJECTED});
const timestamp = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const boundRoom = (value: ChatJobRoom | null, organizationId: string, jobRoomId: string): value is ChatJobRoom => value?.organizationId === organizationId && value.jobRoomId === jobRoomId && value.status === 'active';
function boundMember(value: ChatJobRoomMembership | null, organizationId: string, jobRoomId: string, subjectId?: string): value is ChatJobRoomMembership { return value?.organizationId === organizationId && value.jobRoomId === jobRoomId && IDENTIFIER.test(value.membershipId) && IDENTIFIER.test(value.subjectId) && (subjectId === undefined || value.subjectId === subjectId) && (value.role === 'customer' || value.role === 'provider'); }
function storedMessage(value: JobRoomMessage | null, organizationId: string): value is JobRoomMessage { return value?.organizationId === organizationId && IDENTIFIER.test(value.messageId) && IDENTIFIER.test(value.requestKey) && IDENTIFIER.test(value.jobRoomId) && IDENTIFIER.test(value.senderMembershipId) && IDENTIFIER.test(value.senderSubjectId) && value.body === value.body.trim() && value.body.length > 0 && value.body.length <= MAX_BODY_LENGTH && timestamp(value.createdAt); }
function matchesMessage(value: JobRoomMessage | null, organizationId: string, input: SendJobRoomMessageInput, member: ChatJobRoomMembership): value is JobRoomMessage { return storedMessage(value, organizationId) && value.requestKey === input.requestKey && value.jobRoomId === input.jobRoomId && value.senderMembershipId === member.membershipId && value.senderSubjectId === member.subjectId && value.body === input.body; }
function storedReceipt(value: JobRoomMessageReceipt | null, organizationId: string): value is JobRoomMessageReceipt { return value?.organizationId === organizationId && IDENTIFIER.test(value.receiptId) && IDENTIFIER.test(value.requestKey) && IDENTIFIER.test(value.jobRoomId) && IDENTIFIER.test(value.messageId) && IDENTIFIER.test(value.membershipId) && IDENTIFIER.test(value.subjectId) && (value.status === 'delivered' || value.status === 'read') && timestamp(value.occurredAt); }
function matchesReceipt(value: JobRoomMessageReceipt | null, organizationId: string, input: RecordJobRoomReceiptInput, member: ChatJobRoomMembership): value is JobRoomMessageReceipt { return storedReceipt(value, organizationId) && value.requestKey === input.requestKey && value.jobRoomId === input.jobRoomId && value.messageId === input.messageId && value.membershipId === member.membershipId && value.subjectId === member.subjectId && value.status === input.status; }
async function authorize(request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState, action: string, permission: string, options: JobRoomChatOptions): Promise<{organizationId: string; subjectId: string} | null> { const result = await authorizeAndAuditOrganizationAction(request, state, action, options.audit); return result.authorized && request.requiredPermission === permission ? {organizationId: result.organizationId, subjectId: result.subjectId} : null; }

export async function sendJobRoomMessage(contractVersion: number, request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState, input: SendJobRoomMessageInput, options: JobRoomChatOptions): Promise<JobRoomChatResult<{message: JobRoomMessage; notifications: readonly JobRoomMessageNotification[]}>> {
  const identity = await authorize(request, state, 'job-room.message.send', 'job-rooms:chat', options); const now = options.now();
  if (!identity || contractVersion !== JOB_ROOM_CHAT_CONTRACT_VERSION || !timestamp(now) || !IDENTIFIER.test(input.requestKey) || !IDENTIFIER.test(input.jobRoomId) || input.body !== input.body.trim() || input.body.length === 0 || input.body.length > MAX_BODY_LENGTH) return rejected();
  try {
    const [room, member, existing] = await Promise.all([options.store.getJobRoom(identity.organizationId, input.jobRoomId), options.store.getMembership(identity.organizationId, input.jobRoomId, identity.subjectId), options.store.getMessageByRequestKey(identity.organizationId, input.requestKey)]);
    if (!boundRoom(room, identity.organizationId, input.jobRoomId) || !boundMember(member, identity.organizationId, input.jobRoomId, identity.subjectId)) return rejected();
    if (existing !== null) return matchesMessage(existing, identity.organizationId, input, member) ? {accepted: true, value: Object.freeze({message: existing, notifications: Object.freeze([])}), replayed: true} : rejected();
    const members = await options.store.listMemberships(identity.organizationId, input.jobRoomId);
    if (members.length === 0 || members.length > MAX_ROOM_MEMBERS || members.some(value => !boundMember(value, identity.organizationId, input.jobRoomId)) || new Set(members.map(value => value.membershipId)).size !== members.length || new Set(members.map(value => value.subjectId)).size !== members.length || !members.some(value => value.membershipId === member.membershipId && value.subjectId === member.subjectId)) return rejected();
    const messageId = options.createOpaqueId(); if (!IDENTIFIER.test(messageId)) return rejected();
    const message = Object.freeze({messageId, organizationId: identity.organizationId, requestKey: input.requestKey, jobRoomId: input.jobRoomId, senderMembershipId: member.membershipId, senderSubjectId: member.subjectId, body: input.body, createdAt: now});
    const notifications: JobRoomMessageNotification[] = [];
    for (const recipient of members) { if (recipient.membershipId === member.membershipId) continue; const notificationId = options.createOpaqueId(); if (!IDENTIFIER.test(notificationId)) return rejected(); notifications.push(Object.freeze({notificationId, organizationId: identity.organizationId, eventType: 'job-room.message.created' as const, jobRoomId: input.jobRoomId, messageId, recipientSubjectId: recipient.subjectId, occurredAt: now})); }
    if (new Set([messageId, ...notifications.map(value => value.notificationId)]).size !== notifications.length + 1) return rejected();
    const frozenNotifications = Object.freeze(notifications);
    return await options.store.createMessage(message, frozenNotifications) ? {accepted: true, value: Object.freeze({message, notifications: frozenNotifications}), replayed: false} : rejected();
  } catch { return rejected(); }
}

export async function recordJobRoomReceipt(contractVersion: number, request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState, input: RecordJobRoomReceiptInput, options: JobRoomChatOptions): Promise<JobRoomChatResult<JobRoomMessageReceipt>> {
  const identity = await authorize(request, state, 'job-room.message.receipt', 'job-rooms:receipts', options); const now = options.now();
  if (!identity || contractVersion !== JOB_ROOM_CHAT_CONTRACT_VERSION || !timestamp(now) || !IDENTIFIER.test(input.requestKey) || !IDENTIFIER.test(input.jobRoomId) || !IDENTIFIER.test(input.messageId) || (input.status !== 'delivered' && input.status !== 'read')) return rejected();
  try {
    const [room, member, message, replay] = await Promise.all([options.store.getJobRoom(identity.organizationId, input.jobRoomId), options.store.getMembership(identity.organizationId, input.jobRoomId, identity.subjectId), options.store.getMessage(identity.organizationId, input.messageId), options.store.getReceiptByRequestKey(identity.organizationId, input.requestKey)]);
    if (!boundRoom(room, identity.organizationId, input.jobRoomId) || !boundMember(member, identity.organizationId, input.jobRoomId, identity.subjectId) || !storedMessage(message, identity.organizationId) || message.jobRoomId !== input.jobRoomId || message.senderMembershipId === member.membershipId) return rejected();
    if (replay !== null) return matchesReceipt(replay, identity.organizationId, input, member) ? {accepted: true, value: replay, replayed: true} : rejected();
    const previous = await options.store.getReceipt(identity.organizationId, input.messageId, member.membershipId);
    if (previous !== null && (!storedReceipt(previous, identity.organizationId) || previous.jobRoomId !== input.jobRoomId || previous.messageId !== input.messageId || previous.membershipId !== member.membershipId || previous.subjectId !== member.subjectId || previous.status === 'read' || input.status === 'delivered')) return rejected();
    const receiptId = options.createOpaqueId(); if (!IDENTIFIER.test(receiptId)) return rejected();
    const receipt = Object.freeze({receiptId, organizationId: identity.organizationId, requestKey: input.requestKey, jobRoomId: input.jobRoomId, messageId: input.messageId, membershipId: member.membershipId, subjectId: member.subjectId, status: input.status, occurredAt: now});
    return await options.store.advanceReceipt(receipt, previous?.receiptId ?? null) ? {accepted: true, value: receipt, replayed: false} : rejected();
  } catch { return rejected(); }
}
