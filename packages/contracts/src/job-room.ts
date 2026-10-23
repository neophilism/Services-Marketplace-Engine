import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const JOB_ROOM_CONTRACT_VERSION = 1 as const;
export const JOB_ROOM_REJECTED = 'job_room_rejected' as const;

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const REQUEST_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const MAX_INVITATION_LIFETIME = 14 * 86_400_000;

export type JobRoomRole = 'customer' | 'provider';
export interface JobRoom { readonly organizationId: string; readonly jobRoomId: string; readonly customerSubjectId: string; readonly providerOrganizationId: string; readonly status: 'active' | 'closed'; }
export interface JobRoomProviderOperator { readonly organizationId: string; readonly providerOrganizationId: string; readonly subjectId: string; readonly status: 'active' | 'inactive'; readonly permissions: readonly string[]; }
export interface JobRoomMembership { readonly membershipId: string; readonly organizationId: string; readonly jobRoomId: string; readonly subjectId: string; readonly role: JobRoomRole; readonly canInvite: boolean; readonly invitationId: string | null; readonly createdAt: number; }
export interface JobRoomInvitation { readonly invitationId: string; readonly organizationId: string; readonly requestKey: string; readonly jobRoomId: string; readonly invitedSubjectId: string; readonly role: JobRoomRole; readonly invitedBySubjectId: string; readonly expiresAt: number; readonly createdAt: number; }
export interface JobRoomAcceptance { readonly acceptanceId: string; readonly organizationId: string; readonly requestKey: string; readonly invitationId: string; readonly membershipId: string; readonly acceptedBySubjectId: string; readonly acceptedAt: number; }
export interface InviteJobRoomMemberInput { readonly requestKey: string; readonly jobRoomId: string; readonly invitedSubjectId: string; readonly role: JobRoomRole; readonly expiresAt: number; }
export interface AcceptJobRoomInvitationInput { readonly requestKey: string; readonly invitationId: string; }
export interface JobRoomStore {
  getJobRoom(organizationId: string, jobRoomId: string): Promise<JobRoom | null>;
  getMembership(organizationId: string, jobRoomId: string, subjectId: string): Promise<JobRoomMembership | null>;
  getProviderOperator(organizationId: string, providerOrganizationId: string, subjectId: string): Promise<JobRoomProviderOperator | null>;
  getInvitation(organizationId: string, invitationId: string): Promise<JobRoomInvitation | null>;
  getInvitationByRequestKey(organizationId: string, requestKey: string): Promise<JobRoomInvitation | null>;
  getPendingInvitation(organizationId: string, jobRoomId: string, subjectId: string): Promise<JobRoomInvitation | null>;
  createInvitation(value: JobRoomInvitation): Promise<boolean>;
  getAcceptanceByRequestKey(organizationId: string, requestKey: string): Promise<JobRoomAcceptance | null>;
  getAcceptanceByInvitation(organizationId: string, invitationId: string): Promise<JobRoomAcceptance | null>;
  createMembershipFromInvitation(membership: JobRoomMembership, acceptance: JobRoomAcceptance): Promise<boolean>;
}
export interface JobRoomOptions { readonly store: JobRoomStore; readonly audit: TenantAuditOptions; readonly createOpaqueId: () => string; readonly now: () => number; }
export type JobRoomResult<T> = {readonly accepted: true; readonly value: T; readonly replayed: boolean} | {readonly accepted: false; readonly code: typeof JOB_ROOM_REJECTED};

const rejected = <T>(): JobRoomResult<T> => ({accepted: false, code: JOB_ROOM_REJECTED});
const timestamp = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
function boundRoom(value: JobRoom | null, organizationId: string, jobRoomId: string): value is JobRoom { return value?.organizationId === organizationId && value.jobRoomId === jobRoomId && IDENTIFIER.test(value.customerSubjectId) && IDENTIFIER.test(value.providerOrganizationId) && value.status === 'active'; }
function boundMembership(value: JobRoomMembership | null, organizationId: string, jobRoomId: string, subjectId: string): value is JobRoomMembership { return value?.organizationId === organizationId && value.jobRoomId === jobRoomId && value.subjectId === subjectId && IDENTIFIER.test(value.membershipId) && (value.role === 'customer' || value.role === 'provider') && timestamp(value.createdAt); }
function boundOperator(value: JobRoomProviderOperator | null, organizationId: string, providerOrganizationId: string, subjectId: string): boolean { return value?.organizationId === organizationId && value.providerOrganizationId === providerOrganizationId && value.subjectId === subjectId && value.status === 'active' && value.permissions.includes('job-rooms:join'); }
function storedInvitation(value: JobRoomInvitation | null, organizationId: string): value is JobRoomInvitation { return value?.organizationId === organizationId && IDENTIFIER.test(value.invitationId) && REQUEST_KEY.test(value.requestKey) && IDENTIFIER.test(value.jobRoomId) && IDENTIFIER.test(value.invitedSubjectId) && IDENTIFIER.test(value.invitedBySubjectId) && (value.role === 'customer' || value.role === 'provider') && timestamp(value.expiresAt) && timestamp(value.createdAt) && value.expiresAt > value.createdAt; }
function matchesInvitation(value: JobRoomInvitation | null, organizationId: string, input: InviteJobRoomMemberInput, inviter: string): value is JobRoomInvitation { return storedInvitation(value, organizationId) && value.requestKey === input.requestKey && value.jobRoomId === input.jobRoomId && value.invitedSubjectId === input.invitedSubjectId && value.role === input.role && value.invitedBySubjectId === inviter && value.expiresAt === input.expiresAt; }
function matchesAcceptance(value: JobRoomAcceptance | null, organizationId: string, input: AcceptJobRoomInvitationInput, subjectId: string, invitation: JobRoomInvitation): value is JobRoomAcceptance { return value?.organizationId === organizationId && value.requestKey === input.requestKey && value.invitationId === invitation.invitationId && value.acceptedBySubjectId === subjectId && IDENTIFIER.test(value.acceptanceId) && IDENTIFIER.test(value.membershipId) && timestamp(value.acceptedAt); }
async function authorize(request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState, action: string, permission: string, options: JobRoomOptions): Promise<{organizationId: string; subjectId: string} | null> { const result = await authorizeAndAuditOrganizationAction(request, state, action, options.audit); return result.authorized && request.requiredPermission === permission ? {organizationId: result.organizationId, subjectId: result.subjectId} : null; }

export async function inviteJobRoomMember(contractVersion: number, request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState, input: InviteJobRoomMemberInput, options: JobRoomOptions): Promise<JobRoomResult<JobRoomInvitation>> {
  const identity = await authorize(request, state, 'job-room.invite', 'job-rooms:invite', options); const now = options.now();
  if (!identity || contractVersion !== JOB_ROOM_CONTRACT_VERSION || !timestamp(now) || !REQUEST_KEY.test(input.requestKey) || !IDENTIFIER.test(input.jobRoomId) || !IDENTIFIER.test(input.invitedSubjectId) || input.invitedSubjectId === identity.subjectId || (input.role !== 'customer' && input.role !== 'provider') || !timestamp(input.expiresAt) || input.expiresAt <= now || input.expiresAt > now + MAX_INVITATION_LIFETIME) return rejected();
  try {
    const [room, inviter, existing, member, pending] = await Promise.all([options.store.getJobRoom(identity.organizationId, input.jobRoomId), options.store.getMembership(identity.organizationId, input.jobRoomId, identity.subjectId), options.store.getInvitationByRequestKey(identity.organizationId, input.requestKey), options.store.getMembership(identity.organizationId, input.jobRoomId, input.invitedSubjectId), options.store.getPendingInvitation(identity.organizationId, input.jobRoomId, input.invitedSubjectId)]);
    if (!boundRoom(room, identity.organizationId, input.jobRoomId) || !boundMembership(inviter, identity.organizationId, input.jobRoomId, identity.subjectId) || !inviter.canInvite) return rejected();
    if (existing !== null) return matchesInvitation(existing, identity.organizationId, input, identity.subjectId) ? {accepted: true, value: existing, replayed: true} : rejected();
    if (member !== null || pending !== null) return rejected();
    const invitationId = options.createOpaqueId(); if (!IDENTIFIER.test(invitationId)) return rejected();
    const value = Object.freeze({invitationId, organizationId: identity.organizationId, requestKey: input.requestKey, jobRoomId: input.jobRoomId, invitedSubjectId: input.invitedSubjectId, role: input.role, invitedBySubjectId: identity.subjectId, expiresAt: input.expiresAt, createdAt: now});
    return await options.store.createInvitation(value) ? {accepted: true, value, replayed: false} : rejected();
  } catch { return rejected(); }
}

export async function acceptJobRoomInvitation(contractVersion: number, request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState, input: AcceptJobRoomInvitationInput, options: JobRoomOptions): Promise<JobRoomResult<JobRoomMembership>> {
  const identity = await authorize(request, state, 'job-room.invitation.accept', 'job-rooms:join', options); const now = options.now();
  if (!identity || contractVersion !== JOB_ROOM_CONTRACT_VERSION || !timestamp(now) || !REQUEST_KEY.test(input.requestKey) || !IDENTIFIER.test(input.invitationId)) return rejected();
  try {
    const invitation = await options.store.getInvitation(identity.organizationId, input.invitationId);
    if (!storedInvitation(invitation, identity.organizationId) || invitation.invitedSubjectId !== identity.subjectId || invitation.expiresAt <= now) return rejected();
    const [room, existingMember, replay, accepted] = await Promise.all([options.store.getJobRoom(identity.organizationId, invitation.jobRoomId), options.store.getMembership(identity.organizationId, invitation.jobRoomId, identity.subjectId), options.store.getAcceptanceByRequestKey(identity.organizationId, input.requestKey), options.store.getAcceptanceByInvitation(identity.organizationId, input.invitationId)]);
    if (!boundRoom(room, identity.organizationId, invitation.jobRoomId)) return rejected();
    if (replay !== null) {
      if (!matchesAcceptance(replay, identity.organizationId, input, identity.subjectId, invitation) || !boundMembership(existingMember, identity.organizationId, invitation.jobRoomId, identity.subjectId) || existingMember.membershipId !== replay.membershipId || existingMember.invitationId !== invitation.invitationId || existingMember.role !== invitation.role) return rejected();
      return {accepted: true, value: existingMember, replayed: true};
    }
    if (existingMember !== null || accepted !== null) return rejected();
    if (invitation.role === 'provider') {
      const operator = await options.store.getProviderOperator(identity.organizationId, room.providerOrganizationId, identity.subjectId);
      if (!boundOperator(operator, identity.organizationId, room.providerOrganizationId, identity.subjectId)) return rejected();
    }
    const membershipId = options.createOpaqueId(); const acceptanceId = options.createOpaqueId();
    if (!IDENTIFIER.test(membershipId) || !IDENTIFIER.test(acceptanceId)) return rejected();
    const membership = Object.freeze({membershipId, organizationId: identity.organizationId, jobRoomId: invitation.jobRoomId, subjectId: identity.subjectId, role: invitation.role, canInvite: false, invitationId: invitation.invitationId, createdAt: now});
    const acceptance = Object.freeze({acceptanceId, organizationId: identity.organizationId, requestKey: input.requestKey, invitationId: invitation.invitationId, membershipId, acceptedBySubjectId: identity.subjectId, acceptedAt: now});
    return await options.store.createMembershipFromInvitation(membership, acceptance) ? {accepted: true, value: membership, replayed: false} : rejected();
  } catch { return rejected(); }
}
