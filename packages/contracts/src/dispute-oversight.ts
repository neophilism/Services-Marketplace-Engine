import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const DISPUTE_OVERSIGHT_CONTRACT_VERSION = 1 as const;
export const DISPUTE_OVERSIGHT_REJECTED = 'dispute_oversight_rejected' as const;

export interface DisputeRoom { readonly organizationId: string; readonly jobRoomId: string; readonly customerSubjectId: string; readonly status: 'active' | 'completed' | 'closed'; }
export interface DisputeMember { readonly membershipId: string; readonly organizationId: string; readonly jobRoomId: string; readonly subjectId: string; readonly role: 'customer' | 'provider'; readonly status: 'active' | 'inactive'; }
export interface HumanReviewer { readonly organizationId: string; readonly subjectId: string; readonly status: 'active' | 'inactive'; readonly humanVerified: boolean; readonly permissions: readonly string[]; }
export interface JobRoomDispute { readonly disputeId: string; readonly organizationId: string; readonly requestKey: string; readonly jobRoomId: string; readonly openedByMembershipId: string; readonly openedBySubjectId: string; readonly openedByRole: 'customer' | 'provider'; readonly reasonCode: string; readonly statement: string; readonly evidenceReferences: readonly string[]; readonly status: 'open' | 'resolved'; readonly revision: number; readonly createdAt: number; readonly resolvedAt: number | null; }
export interface DisputeResolution { readonly resolutionId: string; readonly organizationId: string; readonly requestKey: string; readonly disputeId: string; readonly reviewerSubjectId: string; readonly outcome: 'upheld' | 'remedy'; readonly rationale: string; readonly reversal: {readonly targetType: 'none'} | {readonly targetType: 'completion' | 'milestone_acceptance'; readonly targetId: string}; readonly disputeRevision: number; readonly createdAt: number; }
export interface OpenDisputeInput { readonly requestKey: string; readonly jobRoomId: string; readonly reasonCode: string; readonly statement: string; readonly evidenceReferences: readonly string[]; }
export interface ResolveDisputeInput { readonly requestKey: string; readonly disputeId: string; readonly expectedRevision: number; readonly outcome: 'upheld' | 'remedy'; readonly rationale: string; readonly reversal: {readonly targetType: 'none'} | {readonly targetType: 'completion' | 'milestone_acceptance'; readonly targetId: string}; }
export interface DisputeOversightStore {
  getRoom(organizationId: string, jobRoomId: string): Promise<DisputeRoom | null>;
  getMembership(organizationId: string, jobRoomId: string, subjectId: string): Promise<DisputeMember | null>;
  getReviewer(organizationId: string, subjectId: string): Promise<HumanReviewer | null>;
  getDispute(organizationId: string, disputeId: string): Promise<JobRoomDispute | null>;
  getDisputeByRequestKey(organizationId: string, requestKey: string): Promise<JobRoomDispute | null>;
  createDispute(value: JobRoomDispute): Promise<boolean>;
  getResolutionByRequestKey(organizationId: string, requestKey: string): Promise<DisputeResolution | null>;
  resolveDispute(before: JobRoomDispute, after: JobRoomDispute, resolution: DisputeResolution): Promise<boolean>;
}
export interface DisputeOversightOptions { readonly store: DisputeOversightStore; readonly audit: TenantAuditOptions; readonly createOpaqueId: () => string; readonly now: () => number; }
export type DisputeOversightResult<T> = {readonly accepted: true; readonly value: T; readonly replayed: boolean} | {readonly accepted: false; readonly code: typeof DISPUTE_OVERSIGHT_REJECTED};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REASON = /^[a-z][a-z0-9_]{1,63}$/;
const PRINTABLE = /^[\x20-\x7e]+$/;
const rejected = <T>(): DisputeOversightResult<T> => ({accepted:false, code:DISPUTE_OVERSIGHT_REJECTED});
const time = (value:number):boolean => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const text = (value:string, maximum:number):boolean => value === value.trim() && value.length > 0 && value.length <= maximum && PRINTABLE.test(value);
const references = (values:readonly string[]):boolean => values.length <= 20 && new Set(values).size === values.length && values.every(value => ID.test(value));
const validReversal = (value:ResolveDisputeInput['reversal']):boolean => value.targetType === 'none' ? Object.keys(value).length === 1 : (value.targetType === 'completion' || value.targetType === 'milestone_acceptance') && ID.test(value.targetId);
const boundDispute = (value:JobRoomDispute|null, organizationId:string):value is JobRoomDispute => value?.organizationId === organizationId && ID.test(value.disputeId) && ID.test(value.requestKey) && ID.test(value.jobRoomId) && ID.test(value.openedByMembershipId) && ID.test(value.openedBySubjectId) && (value.openedByRole === 'customer' || value.openedByRole === 'provider') && REASON.test(value.reasonCode) && text(value.statement, 4_000) && references(value.evidenceReferences) && (value.status === 'open' || value.status === 'resolved') && Number.isSafeInteger(value.revision) && value.revision >= 1 && time(value.createdAt) && (value.status === 'open' ? value.revision === 1 && value.resolvedAt === null : value.revision === 2 && value.resolvedAt !== null && time(value.resolvedAt));
const boundResolution = (value:DisputeResolution|null, organizationId:string):value is DisputeResolution => value?.organizationId === organizationId && ID.test(value.resolutionId) && ID.test(value.requestKey) && ID.test(value.disputeId) && ID.test(value.reviewerSubjectId) && (value.outcome === 'upheld' || value.outcome === 'remedy') && text(value.rationale, 4_000) && validReversal(value.reversal) && value.disputeRevision === 2 && time(value.createdAt);

async function authorize(request:OrganizationAuthorizationRequest,state:OrganizationAuthorizationState,action:string,permission:string,options:DisputeOversightOptions):Promise<{organizationId:string;subjectId:string}|null>{
  const result=await authorizeAndAuditOrganizationAction(request,state,action,options.audit);
  return result.authorized && request.requiredPermission === permission ? {organizationId:result.organizationId,subjectId:result.subjectId} : null;
}

export async function openJobRoomDispute(contractVersion:number,request:OrganizationAuthorizationRequest,state:OrganizationAuthorizationState,input:OpenDisputeInput,options:DisputeOversightOptions):Promise<DisputeOversightResult<JobRoomDispute>>{
  const who=await authorize(request,state,'job-room.dispute.open','job-rooms:disputes:open',options),now=options.now();
  if(!who || contractVersion !== DISPUTE_OVERSIGHT_CONTRACT_VERSION || !time(now) || !ID.test(input.requestKey) || !ID.test(input.jobRoomId) || !REASON.test(input.reasonCode) || !text(input.statement,4_000) || !references(input.evidenceReferences)) return rejected();
  try {
    const [room,member,replay]=await Promise.all([options.store.getRoom(who.organizationId,input.jobRoomId),options.store.getMembership(who.organizationId,input.jobRoomId,who.subjectId),options.store.getDisputeByRequestKey(who.organizationId,input.requestKey)]);
    if(room?.organizationId !== who.organizationId || room.jobRoomId !== input.jobRoomId || room.status !== 'completed' || !ID.test(room.customerSubjectId) || member?.organizationId !== who.organizationId || member.jobRoomId !== input.jobRoomId || member.subjectId !== who.subjectId || member.status !== 'active' || (member.role !== 'customer' && member.role !== 'provider') || (member.role === 'customer' && room.customerSubjectId !== who.subjectId)) return rejected();
    if(replay !== null) return boundDispute(replay,who.organizationId) && replay.requestKey === input.requestKey && replay.jobRoomId === input.jobRoomId && replay.openedByMembershipId === member.membershipId && replay.openedBySubjectId === who.subjectId && replay.openedByRole === member.role && replay.reasonCode === input.reasonCode && replay.statement === input.statement && replay.evidenceReferences.length === input.evidenceReferences.length && replay.evidenceReferences.every((value,index)=>value === input.evidenceReferences[index]) ? {accepted:true,value:replay,replayed:true} : rejected();
    const disputeId=options.createOpaqueId(); if(!ID.test(disputeId)) return rejected();
    const value:JobRoomDispute=Object.freeze({disputeId,organizationId:who.organizationId,requestKey:input.requestKey,jobRoomId:input.jobRoomId,openedByMembershipId:member.membershipId,openedBySubjectId:who.subjectId,openedByRole:member.role,reasonCode:input.reasonCode,statement:input.statement,evidenceReferences:Object.freeze([...input.evidenceReferences]),status:'open',revision:1,createdAt:now,resolvedAt:null});
    return boundDispute(value,who.organizationId) && await options.store.createDispute(value) ? {accepted:true,value,replayed:false} : rejected();
  } catch { return rejected(); }
}

export async function resolveJobRoomDispute(contractVersion:number,request:OrganizationAuthorizationRequest,state:OrganizationAuthorizationState,input:ResolveDisputeInput,options:DisputeOversightOptions):Promise<DisputeOversightResult<DisputeResolution>>{
  const who=await authorize(request,state,'job-room.dispute.resolve','job-rooms:disputes:resolve',options),now=options.now();
  if(!who || contractVersion !== DISPUTE_OVERSIGHT_CONTRACT_VERSION || !time(now) || !ID.test(input.requestKey) || !ID.test(input.disputeId) || input.expectedRevision !== 1 || (input.outcome !== 'upheld' && input.outcome !== 'remedy') || !text(input.rationale,4_000) || !validReversal(input.reversal) || (input.outcome === 'upheld' && input.reversal.targetType !== 'none')) return rejected();
  try {
    const [dispute,reviewer,replay]=await Promise.all([options.store.getDispute(who.organizationId,input.disputeId),options.store.getReviewer(who.organizationId,who.subjectId),options.store.getResolutionByRequestKey(who.organizationId,input.requestKey)]);
    if(!boundDispute(dispute,who.organizationId) || dispute.disputeId !== input.disputeId || reviewer?.organizationId !== who.organizationId || reviewer.subjectId !== who.subjectId || reviewer.status !== 'active' || reviewer.humanVerified !== true || !reviewer.permissions.includes('job-rooms:disputes:resolve') || dispute.openedBySubjectId === who.subjectId) return rejected();
    if(replay !== null) return boundResolution(replay,who.organizationId) && replay.requestKey === input.requestKey && replay.disputeId === input.disputeId && replay.reviewerSubjectId === who.subjectId && replay.outcome === input.outcome && replay.rationale === input.rationale && JSON.stringify(replay.reversal) === JSON.stringify(input.reversal) && dispute.revision >= replay.disputeRevision ? {accepted:true,value:replay,replayed:true} : rejected();
    if(dispute.status !== 'open' || dispute.revision !== input.expectedRevision) return rejected();
    const resolutionId=options.createOpaqueId(); if(!ID.test(resolutionId)) return rejected();
    const after:JobRoomDispute=Object.freeze({...dispute,status:'resolved',revision:2,resolvedAt:now});
    const resolution:DisputeResolution=Object.freeze({resolutionId,organizationId:who.organizationId,requestKey:input.requestKey,disputeId:dispute.disputeId,reviewerSubjectId:who.subjectId,outcome:input.outcome,rationale:input.rationale,reversal:Object.freeze({...input.reversal}),disputeRevision:2,createdAt:now});
    return boundDispute(after,who.organizationId) && boundResolution(resolution,who.organizationId) && await options.store.resolveDispute(dispute,after,resolution) ? {accepted:true,value:resolution,replayed:false} : rejected();
  } catch { return rejected(); }
}
