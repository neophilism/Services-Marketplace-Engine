import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const JOB_ROOM_MEDIA_CONTRACT_VERSION = 1 as const;
export const JOB_ROOM_MEDIA_REJECTED = 'job_room_media_rejected' as const;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface MediaJobRoom { readonly organizationId: string; readonly jobRoomId: string; readonly status: 'active' | 'closed'; }
export interface MediaJobRoomMembership { readonly membershipId: string; readonly organizationId: string; readonly jobRoomId: string; readonly subjectId: string; }
export interface ShareableAttachment { readonly attachmentId: string; readonly organizationId: string; readonly objectKey: string; readonly contentType: string; readonly sizeBytes: number; readonly sha256: string; readonly status: 'quarantined' | 'clean' | 'infected'; }
export interface JobRoomMediaShare { readonly shareId: string; readonly organizationId: string; readonly requestKey: string; readonly jobRoomId: string; readonly attachmentId: string; readonly senderMembershipId: string; readonly senderSubjectId: string; readonly caption: string | null; readonly createdAt: number; }
export interface ShareJobRoomMediaInput { readonly requestKey: string; readonly jobRoomId: string; readonly attachmentId: string; readonly caption: string | null; }
export interface JobRoomMediaStore {
  getJobRoom(organizationId: string, jobRoomId: string): Promise<MediaJobRoom | null>;
  getMembership(organizationId: string, jobRoomId: string, subjectId: string): Promise<MediaJobRoomMembership | null>;
  getAttachment(organizationId: string, attachmentId: string): Promise<ShareableAttachment | null>;
  getShare(organizationId: string, shareId: string): Promise<JobRoomMediaShare | null>;
  getShareByRequestKey(organizationId: string, requestKey: string): Promise<JobRoomMediaShare | null>;
  createShare(share: JobRoomMediaShare): Promise<boolean>;
}
export interface PrivateMediaObjects { createPrivateDownloadUrl(objectKey: string, subjectId: string): Promise<string>; }
export interface JobRoomMediaOptions { readonly store: JobRoomMediaStore; readonly objects: PrivateMediaObjects; readonly audit: TenantAuditOptions; readonly createOpaqueId: () => string; readonly now: () => number; }
export type JobRoomMediaResult<T> = {readonly accepted: true; readonly value: T; readonly replayed: boolean} | {readonly accepted: false; readonly code: typeof JOB_ROOM_MEDIA_REJECTED};

const rejected = <T>(): JobRoomMediaResult<T> => ({accepted: false, code: JOB_ROOM_MEDIA_REJECTED});
const timestamp = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
function room(value: MediaJobRoom | null, organizationId: string, jobRoomId: string): value is MediaJobRoom { return value?.organizationId === organizationId && value.jobRoomId === jobRoomId && value.status === 'active'; }
function member(value: MediaJobRoomMembership | null, organizationId: string, jobRoomId: string, subjectId: string): value is MediaJobRoomMembership { return value?.organizationId === organizationId && value.jobRoomId === jobRoomId && value.subjectId === subjectId && IDENTIFIER.test(value.membershipId); }
function attachment(value: ShareableAttachment | null, organizationId: string, attachmentId: string): value is ShareableAttachment { return value?.organizationId === organizationId && value.attachmentId === attachmentId && value.status === 'clean' && IDENTIFIER.test(value.objectKey) && value.contentType.length > 0 && value.contentType.length <= 127 && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes > 0 && SHA256.test(value.sha256); }
function storedShare(value: JobRoomMediaShare | null, organizationId: string): value is JobRoomMediaShare { return value?.organizationId === organizationId && IDENTIFIER.test(value.shareId) && IDENTIFIER.test(value.requestKey) && IDENTIFIER.test(value.jobRoomId) && IDENTIFIER.test(value.attachmentId) && IDENTIFIER.test(value.senderMembershipId) && IDENTIFIER.test(value.senderSubjectId) && (value.caption === null || (value.caption === value.caption.trim() && value.caption.length > 0 && value.caption.length <= 500)) && timestamp(value.createdAt); }
function matchesShare(value: JobRoomMediaShare | null, organizationId: string, input: ShareJobRoomMediaInput, membership: MediaJobRoomMembership): value is JobRoomMediaShare { return storedShare(value, organizationId) && value.requestKey === input.requestKey && value.jobRoomId === input.jobRoomId && value.attachmentId === input.attachmentId && value.senderMembershipId === membership.membershipId && value.senderSubjectId === membership.subjectId && value.caption === input.caption; }
async function authorize(request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState, action: string, permission: string, options: JobRoomMediaOptions): Promise<{organizationId: string; subjectId: string} | null> { const result = await authorizeAndAuditOrganizationAction(request, state, action, options.audit); return result.authorized && request.requiredPermission === permission ? {organizationId: result.organizationId, subjectId: result.subjectId} : null; }

export async function shareJobRoomMedia(contractVersion: number, request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState, input: ShareJobRoomMediaInput, options: JobRoomMediaOptions): Promise<JobRoomMediaResult<JobRoomMediaShare>> {
  const identity = await authorize(request, state, 'job-room.media.share', 'job-rooms:media:share', options); const now = options.now();
  if (!identity || contractVersion !== JOB_ROOM_MEDIA_CONTRACT_VERSION || !timestamp(now) || !IDENTIFIER.test(input.requestKey) || !IDENTIFIER.test(input.jobRoomId) || !IDENTIFIER.test(input.attachmentId) || (input.caption !== null && (input.caption !== input.caption.trim() || input.caption.length === 0 || input.caption.length > 500))) return rejected();
  try {
    const [currentRoom, membership, media, existing] = await Promise.all([options.store.getJobRoom(identity.organizationId, input.jobRoomId), options.store.getMembership(identity.organizationId, input.jobRoomId, identity.subjectId), options.store.getAttachment(identity.organizationId, input.attachmentId), options.store.getShareByRequestKey(identity.organizationId, input.requestKey)]);
    if (!room(currentRoom, identity.organizationId, input.jobRoomId) || !member(membership, identity.organizationId, input.jobRoomId, identity.subjectId) || !attachment(media, identity.organizationId, input.attachmentId)) return rejected();
    if (existing !== null) return matchesShare(existing, identity.organizationId, input, membership) ? {accepted: true, value: existing, replayed: true} : rejected();
    const shareId = options.createOpaqueId(); if (!IDENTIFIER.test(shareId)) return rejected();
    const share = Object.freeze({shareId, organizationId: identity.organizationId, requestKey: input.requestKey, jobRoomId: input.jobRoomId, attachmentId: input.attachmentId, senderMembershipId: membership.membershipId, senderSubjectId: membership.subjectId, caption: input.caption, createdAt: now});
    return await options.store.createShare(share) ? {accepted: true, value: share, replayed: false} : rejected();
  } catch { return rejected(); }
}

export async function createJobRoomMediaDownload(request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState, shareId: string, options: JobRoomMediaOptions): Promise<JobRoomMediaResult<{downloadUrl: string}>> {
  const identity = await authorize(request, state, 'job-room.media.download', 'job-rooms:media:read', options);
  if (!identity || !IDENTIFIER.test(shareId)) return rejected();
  try {
    const share = await options.store.getShare(identity.organizationId, shareId); if (!storedShare(share, identity.organizationId)) return rejected();
    const [currentRoom, membership, media] = await Promise.all([options.store.getJobRoom(identity.organizationId, share.jobRoomId), options.store.getMembership(identity.organizationId, share.jobRoomId, identity.subjectId), options.store.getAttachment(identity.organizationId, share.attachmentId)]);
    if (!room(currentRoom, identity.organizationId, share.jobRoomId) || !member(membership, identity.organizationId, share.jobRoomId, identity.subjectId) || !attachment(media, identity.organizationId, share.attachmentId)) return rejected();
    const downloadUrl = await options.objects.createPrivateDownloadUrl(media.objectKey, identity.subjectId);
    return downloadUrl.startsWith('https://') ? {accepted: true, value: Object.freeze({downloadUrl}), replayed: false} : rejected();
  } catch { return rejected(); }
}
