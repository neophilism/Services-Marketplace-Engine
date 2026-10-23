import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const COMPLETION_WARRANTY_CONTRACT_VERSION = 1 as const;
export const COMPLETION_WARRANTY_REJECTED = 'completion_warranty_rejected' as const;

export interface WarrantyRoom { readonly organizationId: string; readonly jobRoomId: string; readonly customerSubjectId: string; readonly status: 'active' | 'completed' | 'closed'; }
export interface WarrantyMember { readonly membershipId: string; readonly organizationId: string; readonly jobRoomId: string; readonly subjectId: string; readonly role: 'customer' | 'provider'; readonly status: 'active' | 'inactive'; }
export interface AcceptedCompletion { readonly completionId: string; readonly organizationId: string; readonly jobRoomId: string; readonly providerMembershipId: string; readonly completedAt: number; readonly status: 'accepted' | 'reversed'; }
export interface CompletionWarranty { readonly warrantyId: string; readonly organizationId: string; readonly requestKey: string; readonly jobRoomId: string; readonly completionId: string; readonly providerMembershipId: string; readonly terms: string; readonly coverageEndsAt: number; readonly createdAt: number; }
export interface CompletionFollowUp { readonly followUpId: string; readonly organizationId: string; readonly requestKey: string; readonly warrantyId: string; readonly jobRoomId: string; readonly customerMembershipId: string; readonly kind: 'routine' | 'warranty_claim'; readonly summary: string; readonly createdAt: number; }
export interface CreateCompletionWarrantyInput { readonly requestKey: string; readonly jobRoomId: string; readonly completionId: string; readonly terms: string; readonly coverageEndsAt: number; }
export interface CreateCompletionFollowUpInput { readonly requestKey: string; readonly jobRoomId: string; readonly warrantyId: string; readonly kind: 'routine' | 'warranty_claim'; readonly summary: string; }
export interface CompletionWarrantyStore {
  getRoom(organizationId: string, jobRoomId: string): Promise<WarrantyRoom | null>;
  getMembership(organizationId: string, jobRoomId: string, subjectId: string): Promise<WarrantyMember | null>;
  getCompletion(organizationId: string, completionId: string): Promise<AcceptedCompletion | null>;
  getWarranty(organizationId: string, warrantyId: string): Promise<CompletionWarranty | null>;
  getWarrantyByRequestKey(organizationId: string, requestKey: string): Promise<CompletionWarranty | null>;
  createWarranty(value: CompletionWarranty): Promise<boolean>;
  getFollowUpByRequestKey(organizationId: string, requestKey: string): Promise<CompletionFollowUp | null>;
  createFollowUp(value: CompletionFollowUp): Promise<boolean>;
}
export interface CompletionWarrantyOptions { readonly store: CompletionWarrantyStore; readonly audit: TenantAuditOptions; readonly createOpaqueId: () => string; readonly now: () => number; }
export type CompletionWarrantyResult<T> = {readonly accepted: true; readonly value: T; readonly replayed: boolean} | {readonly accepted: false; readonly code: typeof COMPLETION_WARRANTY_REJECTED};

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TEXT=/^[\x20-\x7e]+$/;
const MAX_DATE=8_640_000_000_000_000;
const MAX_COVERAGE=5*365*24*60*60*1_000;
const rejected=<T>(): CompletionWarrantyResult<T>=>({accepted:false,code:COMPLETION_WARRANTY_REJECTED});
const timestamp=(value:number):boolean=>Number.isSafeInteger(value)&&value>=0&&value<=MAX_DATE;
const text=(value:string,maximum:number):boolean=>value===value.trim()&&value.length>0&&value.length<=maximum&&TEXT.test(value);
const boundWarranty=(value:CompletionWarranty|null,organizationId:string):value is CompletionWarranty=>value?.organizationId===organizationId&&ID.test(value.warrantyId)&&ID.test(value.requestKey)&&ID.test(value.jobRoomId)&&ID.test(value.completionId)&&ID.test(value.providerMembershipId)&&text(value.terms,2_000)&&timestamp(value.createdAt)&&timestamp(value.coverageEndsAt)&&value.coverageEndsAt>value.createdAt&&value.coverageEndsAt-value.createdAt<=MAX_COVERAGE;
const boundFollowUp=(value:CompletionFollowUp|null,organizationId:string):value is CompletionFollowUp=>value?.organizationId===organizationId&&ID.test(value.followUpId)&&ID.test(value.requestKey)&&ID.test(value.warrantyId)&&ID.test(value.jobRoomId)&&ID.test(value.customerMembershipId)&&(value.kind==='routine'||value.kind==='warranty_claim')&&text(value.summary,1_000)&&timestamp(value.createdAt);

async function authorize(request:OrganizationAuthorizationRequest,state:OrganizationAuthorizationState,action:string,permission:string,options:CompletionWarrantyOptions):Promise<{organizationId:string;subjectId:string}|null>{
  const result=await authorizeAndAuditOrganizationAction(request,state,action,options.audit);
  return result.authorized&&request.requiredPermission===permission?{organizationId:result.organizationId,subjectId:result.subjectId}:null;
}

export async function createCompletionWarranty(contractVersion:number,request:OrganizationAuthorizationRequest,state:OrganizationAuthorizationState,input:CreateCompletionWarrantyInput,options:CompletionWarrantyOptions):Promise<CompletionWarrantyResult<CompletionWarranty>>{
  const who=await authorize(request,state,'job-room.completion-warranty.create','job-rooms:warranties:create',options),now=options.now();
  if(!who||contractVersion!==COMPLETION_WARRANTY_CONTRACT_VERSION||!timestamp(now)||!ID.test(input.requestKey)||!ID.test(input.jobRoomId)||!ID.test(input.completionId)||!text(input.terms,2_000)||!timestamp(input.coverageEndsAt)||input.coverageEndsAt<=now||input.coverageEndsAt-now>MAX_COVERAGE)return rejected();
  try{
    const [room,member,completion,replay]=await Promise.all([options.store.getRoom(who.organizationId,input.jobRoomId),options.store.getMembership(who.organizationId,input.jobRoomId,who.subjectId),options.store.getCompletion(who.organizationId,input.completionId),options.store.getWarrantyByRequestKey(who.organizationId,input.requestKey)]);
    if(room?.organizationId!==who.organizationId||room.jobRoomId!==input.jobRoomId||room.status!=='completed'||!ID.test(room.customerSubjectId)||member?.organizationId!==who.organizationId||member.jobRoomId!==input.jobRoomId||member.subjectId!==who.subjectId||member.role!=='provider'||member.status!=='active'||completion?.organizationId!==who.organizationId||completion.jobRoomId!==input.jobRoomId||completion.completionId!==input.completionId||completion.providerMembershipId!==member.membershipId||completion.status!=='accepted'||!timestamp(completion.completedAt)||completion.completedAt>now)return rejected();
    if(replay!==null)return boundWarranty(replay,who.organizationId)&&replay.requestKey===input.requestKey&&replay.jobRoomId===input.jobRoomId&&replay.completionId===input.completionId&&replay.providerMembershipId===member.membershipId&&replay.terms===input.terms&&replay.coverageEndsAt===input.coverageEndsAt?{accepted:true,value:replay,replayed:true}:rejected();
    const warrantyId=options.createOpaqueId();if(!ID.test(warrantyId))return rejected();
    const value:CompletionWarranty=Object.freeze({warrantyId,organizationId:who.organizationId,requestKey:input.requestKey,jobRoomId:input.jobRoomId,completionId:input.completionId,providerMembershipId:member.membershipId,terms:input.terms,coverageEndsAt:input.coverageEndsAt,createdAt:now});
    return boundWarranty(value,who.organizationId)&&await options.store.createWarranty(value)?{accepted:true,value,replayed:false}:rejected();
  }catch{return rejected();}
}

export async function createCompletionFollowUp(contractVersion:number,request:OrganizationAuthorizationRequest,state:OrganizationAuthorizationState,input:CreateCompletionFollowUpInput,options:CompletionWarrantyOptions):Promise<CompletionWarrantyResult<CompletionFollowUp>>{
  const who=await authorize(request,state,'job-room.completion-follow-up.create','job-rooms:follow-ups:create',options),now=options.now();
  if(!who||contractVersion!==COMPLETION_WARRANTY_CONTRACT_VERSION||!timestamp(now)||!ID.test(input.requestKey)||!ID.test(input.jobRoomId)||!ID.test(input.warrantyId)||(input.kind!=='routine'&&input.kind!=='warranty_claim')||!text(input.summary,1_000))return rejected();
  try{
    const [room,member,warranty,replay]=await Promise.all([options.store.getRoom(who.organizationId,input.jobRoomId),options.store.getMembership(who.organizationId,input.jobRoomId,who.subjectId),options.store.getWarranty(who.organizationId,input.warrantyId),options.store.getFollowUpByRequestKey(who.organizationId,input.requestKey)]);
    if(room?.organizationId!==who.organizationId||room.jobRoomId!==input.jobRoomId||room.status!=='completed'||room.customerSubjectId!==who.subjectId||member?.organizationId!==who.organizationId||member.jobRoomId!==input.jobRoomId||member.subjectId!==who.subjectId||member.role!=='customer'||member.status!=='active'||!boundWarranty(warranty,who.organizationId)||warranty.jobRoomId!==input.jobRoomId||warranty.warrantyId!==input.warrantyId||warranty.coverageEndsAt<=now)return rejected();
    if(replay!==null)return boundFollowUp(replay,who.organizationId)&&replay.requestKey===input.requestKey&&replay.warrantyId===input.warrantyId&&replay.jobRoomId===input.jobRoomId&&replay.customerMembershipId===member.membershipId&&replay.kind===input.kind&&replay.summary===input.summary?{accepted:true,value:replay,replayed:true}:rejected();
    const followUpId=options.createOpaqueId();if(!ID.test(followUpId))return rejected();
    const value:CompletionFollowUp=Object.freeze({followUpId,organizationId:who.organizationId,requestKey:input.requestKey,warrantyId:input.warrantyId,jobRoomId:input.jobRoomId,customerMembershipId:member.membershipId,kind:input.kind,summary:input.summary,createdAt:now});
    return boundFollowUp(value,who.organizationId)&&await options.store.createFollowUp(value)?{accepted:true,value,replayed:false}:rejected();
  }catch{return rejected();}
}
