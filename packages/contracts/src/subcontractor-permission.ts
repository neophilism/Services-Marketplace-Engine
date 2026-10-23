import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const SUBCONTRACTOR_PERMISSION_CONTRACT_VERSION = 1 as const;
export const SUBCONTRACTOR_PERMISSION_REJECTED = 'subcontractor_permission_rejected' as const;

export type SubcontractorPermission =
  | 'job-room:media:read'
  | 'job-room:tasks:complete'
  | 'job-room:tasks:view'
  | 'job-room:work-records:create';

export interface SubcontractorPermissionRoom { readonly organizationId: string; readonly jobRoomId: string; readonly status: 'active' | 'closed'; }
export interface SubcontractorPermissionMember { readonly membershipId: string; readonly organizationId: string; readonly jobRoomId: string; readonly subjectId: string; readonly role: 'provider' | 'subcontractor'; readonly status: 'active' | 'inactive'; }
export interface SubcontractorDelegation { readonly delegationId: string; readonly organizationId: string; readonly requestKey: string; readonly jobRoomId: string; readonly providerMembershipId: string; readonly subcontractorMembershipId: string; readonly permissions: readonly SubcontractorPermission[]; readonly expiresAt: number; readonly status: 'active' | 'revoked'; readonly revision: number; readonly createdAt: number; readonly revokedAt: number | null; }
export interface SubcontractorRevocation { readonly revocationId: string; readonly organizationId: string; readonly requestKey: string; readonly delegationId: string; readonly providerMembershipId: string; readonly delegationRevision: number; readonly revokedAt: number; }
export interface GrantSubcontractorPermissionsInput { readonly requestKey: string; readonly jobRoomId: string; readonly subcontractorMembershipId: string; readonly permissions: readonly SubcontractorPermission[]; readonly expiresAt: number; }
export interface RevokeSubcontractorPermissionsInput { readonly requestKey: string; readonly delegationId: string; readonly expectedRevision: number; }

export interface SubcontractorPermissionStore {
  getRoom(organizationId: string, jobRoomId: string): Promise<SubcontractorPermissionRoom | null>;
  getMembership(organizationId: string, jobRoomId: string, subjectId: string): Promise<SubcontractorPermissionMember | null>;
  getMembershipById(organizationId: string, jobRoomId: string, membershipId: string): Promise<SubcontractorPermissionMember | null>;
  getDelegation(organizationId: string, delegationId: string): Promise<SubcontractorDelegation | null>;
  getDelegationByRequestKey(organizationId: string, requestKey: string): Promise<SubcontractorDelegation | null>;
  getActiveDelegation(organizationId: string, jobRoomId: string, subcontractorMembershipId: string): Promise<SubcontractorDelegation | null>;
  createDelegation(value: SubcontractorDelegation): Promise<boolean>;
  getRevocationByRequestKey(organizationId: string, requestKey: string): Promise<SubcontractorRevocation | null>;
  revokeDelegation(before: SubcontractorDelegation, after: SubcontractorDelegation, revocation: SubcontractorRevocation): Promise<boolean>;
}
export interface SubcontractorPermissionOptions { readonly store: SubcontractorPermissionStore; readonly audit: TenantAuditOptions; readonly createOpaqueId: () => string; readonly now: () => number; }
export type SubcontractorPermissionResult<T> = {readonly accepted: true; readonly value: T; readonly replayed: boolean} | {readonly accepted: false; readonly code: typeof SUBCONTRACTOR_PERMISSION_REJECTED};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_DATE = 8_640_000_000_000_000;
const MAX_DURATION_MS = 90 * 24 * 60 * 60 * 1_000;
const ALLOWED = new Set<SubcontractorPermission>(['job-room:media:read', 'job-room:tasks:complete', 'job-room:tasks:view', 'job-room:work-records:create']);
const rejected = <T>(): SubcontractorPermissionResult<T> => ({accepted: false, code: SUBCONTRACTOR_PERMISSION_REJECTED});
const timestamp = (value: number): boolean => Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE;

function validPermissions(values: readonly SubcontractorPermission[]): boolean {
  if (values.length < 1 || values.length > ALLOWED.size) return false;
  const sorted = [...values].sort();
  return values.every((value, index) => ALLOWED.has(value) && value === sorted[index] && (index === 0 || value !== values[index - 1]));
}

function boundDelegation(value: SubcontractorDelegation | null, organizationId: string): value is SubcontractorDelegation {
  if (value?.organizationId !== organizationId || !ID.test(value.delegationId) || !ID.test(value.requestKey) || !ID.test(value.jobRoomId) || !ID.test(value.providerMembershipId) || !ID.test(value.subcontractorMembershipId) || value.providerMembershipId === value.subcontractorMembershipId || !validPermissions(value.permissions) || !timestamp(value.createdAt) || !timestamp(value.expiresAt) || value.expiresAt <= value.createdAt || value.expiresAt - value.createdAt > MAX_DURATION_MS || !Number.isSafeInteger(value.revision)) return false;
  return (value.status === 'active' && value.revision === 1 && value.revokedAt === null) || (value.status === 'revoked' && value.revision === 2 && value.revokedAt !== null && timestamp(value.revokedAt) && value.revokedAt >= value.createdAt);
}

function matchesGrant(value: SubcontractorDelegation, input: GrantSubcontractorPermissionsInput, providerMembershipId: string): boolean {
  return value.status === 'active' && value.requestKey === input.requestKey && value.jobRoomId === input.jobRoomId && value.providerMembershipId === providerMembershipId && value.subcontractorMembershipId === input.subcontractorMembershipId && value.expiresAt === input.expiresAt && value.permissions.length === input.permissions.length && value.permissions.every((permission, index) => permission === input.permissions[index]);
}

function boundRevocation(value: SubcontractorRevocation | null, organizationId: string): value is SubcontractorRevocation {
  return value?.organizationId === organizationId && ID.test(value.revocationId) && ID.test(value.requestKey) && ID.test(value.delegationId) && ID.test(value.providerMembershipId) && value.delegationRevision === 2 && timestamp(value.revokedAt);
}

async function manager(request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState, action: string, options: SubcontractorPermissionOptions): Promise<{organizationId: string; subjectId: string} | null> {
  const result = await authorizeAndAuditOrganizationAction(request, state, action, options.audit);
  return result.authorized && request.requiredPermission === 'job-rooms:subcontractors:manage' ? {organizationId: result.organizationId, subjectId: result.subjectId} : null;
}

export async function grantSubcontractorPermissions(contractVersion: number, request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState, input: GrantSubcontractorPermissionsInput, options: SubcontractorPermissionOptions): Promise<SubcontractorPermissionResult<SubcontractorDelegation>> {
  const who = await manager(request, state, 'job-room.subcontractor-permissions.grant', options);
  const now = options.now();
  if (!who || contractVersion !== SUBCONTRACTOR_PERMISSION_CONTRACT_VERSION || !timestamp(now) || !ID.test(input.requestKey) || !ID.test(input.jobRoomId) || !ID.test(input.subcontractorMembershipId) || !validPermissions(input.permissions) || !timestamp(input.expiresAt) || input.expiresAt <= now || input.expiresAt - now > MAX_DURATION_MS) return rejected();
  try {
    const [room, provider, subcontractor, replay, current] = await Promise.all([
      options.store.getRoom(who.organizationId, input.jobRoomId),
      options.store.getMembership(who.organizationId, input.jobRoomId, who.subjectId),
      options.store.getMembershipById(who.organizationId, input.jobRoomId, input.subcontractorMembershipId),
      options.store.getDelegationByRequestKey(who.organizationId, input.requestKey),
      options.store.getActiveDelegation(who.organizationId, input.jobRoomId, input.subcontractorMembershipId),
    ]);
    if (room?.organizationId !== who.organizationId || room.jobRoomId !== input.jobRoomId || room.status !== 'active' || provider?.organizationId !== who.organizationId || provider.jobRoomId !== input.jobRoomId || provider.subjectId !== who.subjectId || provider.role !== 'provider' || provider.status !== 'active' || subcontractor?.organizationId !== who.organizationId || subcontractor.jobRoomId !== input.jobRoomId || subcontractor.membershipId !== input.subcontractorMembershipId || subcontractor.role !== 'subcontractor' || subcontractor.status !== 'active' || subcontractor.subjectId === who.subjectId) return rejected();
    if (replay !== null) return boundDelegation(replay, who.organizationId) && matchesGrant(replay, input, provider.membershipId) ? {accepted: true, value: replay, replayed: true} : rejected();
    if (current !== null) return rejected();
    const delegationId = options.createOpaqueId();
    if (!ID.test(delegationId)) return rejected();
    const value: SubcontractorDelegation = Object.freeze({delegationId, organizationId: who.organizationId, requestKey: input.requestKey, jobRoomId: input.jobRoomId, providerMembershipId: provider.membershipId, subcontractorMembershipId: subcontractor.membershipId, permissions: Object.freeze([...input.permissions]), expiresAt: input.expiresAt, status: 'active', revision: 1, createdAt: now, revokedAt: null});
    return boundDelegation(value, who.organizationId) && await options.store.createDelegation(value) ? {accepted: true, value, replayed: false} : rejected();
  } catch { return rejected(); }
}

export async function revokeSubcontractorPermissions(contractVersion: number, request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState, input: RevokeSubcontractorPermissionsInput, options: SubcontractorPermissionOptions): Promise<SubcontractorPermissionResult<SubcontractorRevocation>> {
  const who = await manager(request, state, 'job-room.subcontractor-permissions.revoke', options);
  const now = options.now();
  if (!who || contractVersion !== SUBCONTRACTOR_PERMISSION_CONTRACT_VERSION || !timestamp(now) || !ID.test(input.requestKey) || !ID.test(input.delegationId) || input.expectedRevision !== 1) return rejected();
  try {
    const [delegation, replay] = await Promise.all([options.store.getDelegation(who.organizationId, input.delegationId), options.store.getRevocationByRequestKey(who.organizationId, input.requestKey)]);
    if (!boundDelegation(delegation, who.organizationId)) return rejected();
    const [room, provider] = await Promise.all([options.store.getRoom(who.organizationId, delegation.jobRoomId), options.store.getMembership(who.organizationId, delegation.jobRoomId, who.subjectId)]);
    if (room?.organizationId !== who.organizationId || room.jobRoomId !== delegation.jobRoomId || provider?.organizationId !== who.organizationId || provider.jobRoomId !== delegation.jobRoomId || provider.subjectId !== who.subjectId || provider.membershipId !== delegation.providerMembershipId || provider.role !== 'provider' || provider.status !== 'active') return rejected();
    if (replay !== null) return boundRevocation(replay, who.organizationId) && replay.requestKey === input.requestKey && replay.delegationId === input.delegationId && replay.providerMembershipId === provider.membershipId && delegation.status === 'revoked' && delegation.revision === replay.delegationRevision && delegation.revokedAt === replay.revokedAt ? {accepted: true, value: replay, replayed: true} : rejected();
    if (delegation.status !== 'active' || delegation.revision !== input.expectedRevision) return rejected();
    const revocationId = options.createOpaqueId();
    if (!ID.test(revocationId)) return rejected();
    const after: SubcontractorDelegation = Object.freeze({...delegation, status: 'revoked', revision: 2, revokedAt: now});
    const revocation: SubcontractorRevocation = Object.freeze({revocationId, organizationId: who.organizationId, requestKey: input.requestKey, delegationId: delegation.delegationId, providerMembershipId: provider.membershipId, delegationRevision: 2, revokedAt: now});
    return boundDelegation(after, who.organizationId) && boundRevocation(revocation, who.organizationId) && await options.store.revokeDelegation(delegation, after, revocation) ? {accepted: true, value: revocation, replayed: false} : rejected();
  } catch { return rejected(); }
}

export async function authorizeSubcontractorPermission(contractVersion: number, organizationId: string, subjectId: string, jobRoomId: string, requiredPermission: SubcontractorPermission, options: Pick<SubcontractorPermissionOptions, 'store' | 'now'>): Promise<SubcontractorPermissionResult<SubcontractorDelegation>> {
  const now = options.now();
  if (contractVersion !== SUBCONTRACTOR_PERMISSION_CONTRACT_VERSION || !ID.test(organizationId) || !ID.test(subjectId) || !ID.test(jobRoomId) || !ALLOWED.has(requiredPermission) || !timestamp(now)) return rejected();
  try {
    const [room, member] = await Promise.all([options.store.getRoom(organizationId, jobRoomId), options.store.getMembership(organizationId, jobRoomId, subjectId)]);
    if (room?.organizationId !== organizationId || room.jobRoomId !== jobRoomId || room.status !== 'active' || member?.organizationId !== organizationId || member.jobRoomId !== jobRoomId || member.subjectId !== subjectId || member.role !== 'subcontractor' || member.status !== 'active') return rejected();
    const delegation = await options.store.getActiveDelegation(organizationId, jobRoomId, member.membershipId);
    return boundDelegation(delegation, organizationId) && delegation.status === 'active' && delegation.jobRoomId === jobRoomId && delegation.subcontractorMembershipId === member.membershipId && delegation.expiresAt > now && delegation.permissions.includes(requiredPermission) ? {accepted: true, value: delegation, replayed: false} : rejected();
  } catch { return rejected(); }
}
