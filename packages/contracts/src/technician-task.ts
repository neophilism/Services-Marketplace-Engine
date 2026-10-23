import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const TECHNICIAN_TASK_CONTRACT_VERSION = 1 as const;
export const TECHNICIAN_TASK_REJECTED = 'technician_task_rejected' as const;

export interface TechnicianTaskRoom { readonly organizationId: string; readonly jobRoomId: string; readonly status: 'active' | 'closed'; }
export interface TechnicianTaskMember { readonly membershipId: string; readonly organizationId: string; readonly jobRoomId: string; readonly subjectId: string; readonly role: 'customer' | 'provider'; readonly status: 'active' | 'inactive'; }
export interface TechnicianTaskSchedule { readonly schedulingHoldId: string; readonly organizationId: string; readonly jobRoomId: string; readonly providerMembershipId: string; readonly status: 'held' | 'confirmed'; }
export interface TechnicianChecklistItem { readonly checklistItemId: string; readonly label: string; readonly status: 'pending' | 'completed'; readonly completedByMembershipId: string | null; readonly completedAt: number | null; }
export interface TechnicianTask { readonly technicianTaskId: string; readonly organizationId: string; readonly requestKey: string; readonly jobRoomId: string; readonly schedulingHoldId: string; readonly assignedMembershipId: string; readonly title: string; readonly checklist: readonly TechnicianChecklistItem[]; readonly status: 'active' | 'completed'; readonly revision: number; readonly createdAt: number; readonly completedAt: number | null; }
export interface TechnicianChecklistCompletion { readonly completionId: string; readonly organizationId: string; readonly requestKey: string; readonly technicianTaskId: string; readonly checklistItemId: string; readonly technicianMembershipId: string; readonly taskRevision: number; readonly completedAt: number; }
export interface CreateTechnicianTaskInput { readonly requestKey: string; readonly jobRoomId: string; readonly schedulingHoldId: string; readonly assignedMembershipId: string; readonly title: string; readonly checklist: readonly {readonly checklistItemId: string; readonly label: string}[]; }
export interface CompleteTechnicianChecklistItemInput { readonly requestKey: string; readonly technicianTaskId: string; readonly checklistItemId: string; readonly expectedRevision: number; }

export interface TechnicianTaskStore {
  getRoom(organizationId: string, jobRoomId: string): Promise<TechnicianTaskRoom | null>;
  getMembership(organizationId: string, jobRoomId: string, subjectId: string): Promise<TechnicianTaskMember | null>;
  getMembershipById(organizationId: string, jobRoomId: string, membershipId: string): Promise<TechnicianTaskMember | null>;
  getSchedule(organizationId: string, schedulingHoldId: string): Promise<TechnicianTaskSchedule | null>;
  getTaskByRequestKey(organizationId: string, requestKey: string): Promise<TechnicianTask | null>;
  getTask(organizationId: string, technicianTaskId: string): Promise<TechnicianTask | null>;
  createTask(value: TechnicianTask): Promise<boolean>;
  getCompletionByRequestKey(organizationId: string, requestKey: string): Promise<TechnicianChecklistCompletion | null>;
  completeChecklistItem(value: TechnicianTask, completion: TechnicianChecklistCompletion, expectedRevision: number): Promise<boolean>;
}
export interface TechnicianTaskOptions { readonly store: TechnicianTaskStore; readonly audit: TenantAuditOptions; readonly createOpaqueId: () => string; readonly now: () => number; }
export type TechnicianTaskResult<T> = {readonly accepted: true; readonly value: T; readonly replayed: boolean} | {readonly accepted: false; readonly code: typeof TECHNICIAN_TASK_REJECTED};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LABEL = /^[\x20-\x7e]{1,160}$/;
const MAX_DATE = 8_640_000_000_000_000;
const rejected = <T>(): TechnicianTaskResult<T> => ({accepted: false, code: TECHNICIAN_TASK_REJECTED});
const timestamp = (value: number): boolean => Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE;

function validChecklist(checklist: readonly TechnicianChecklistItem[]): boolean {
  if (checklist.length < 1 || checklist.length > 50) return false;
  const ids = new Set<string>();
  for (const item of checklist) {
    if (!IDENTIFIER.test(item.checklistItemId) || !LABEL.test(item.label) || ids.has(item.checklistItemId)) return false;
    ids.add(item.checklistItemId);
    if (item.status === 'pending') {
      if (item.completedByMembershipId !== null || item.completedAt !== null) return false;
    } else if (item.status === 'completed') {
      if (item.completedByMembershipId === null || !IDENTIFIER.test(item.completedByMembershipId) || item.completedAt === null || !timestamp(item.completedAt)) return false;
    } else return false;
  }
  return true;
}

function boundTask(value: TechnicianTask | null, organizationId: string): value is TechnicianTask {
  if (value?.organizationId !== organizationId || !IDENTIFIER.test(value.technicianTaskId) || !IDENTIFIER.test(value.requestKey) || !IDENTIFIER.test(value.jobRoomId) || !IDENTIFIER.test(value.schedulingHoldId) || !IDENTIFIER.test(value.assignedMembershipId) || !LABEL.test(value.title) || !Number.isSafeInteger(value.revision) || value.revision < 1 || !timestamp(value.createdAt) || !validChecklist(value.checklist)) return false;
  const allCompleted = value.checklist.every(item => item.status === 'completed');
  return (value.status === 'active' && !allCompleted && value.completedAt === null) || (value.status === 'completed' && allCompleted && value.completedAt !== null && timestamp(value.completedAt) && value.completedAt >= value.createdAt);
}

async function authorize(request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState, action: string, permission: string, options: TechnicianTaskOptions): Promise<{organizationId: string; subjectId: string} | null> {
  const result = await authorizeAndAuditOrganizationAction(request, state, action, options.audit);
  return result.authorized && request.requiredPermission === permission ? {organizationId: result.organizationId, subjectId: result.subjectId} : null;
}

function matchesCreation(value: TechnicianTask, input: CreateTechnicianTaskInput): boolean {
  return value.requestKey === input.requestKey && value.jobRoomId === input.jobRoomId && value.schedulingHoldId === input.schedulingHoldId && value.assignedMembershipId === input.assignedMembershipId && value.title === input.title && value.checklist.length === input.checklist.length && value.checklist.every((item, index) => {
    const requested = input.checklist[index];
    return requested !== undefined && item.checklistItemId === requested.checklistItemId && item.label === requested.label;
  });
}

export async function createTechnicianTask(contractVersion: number, request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState, input: CreateTechnicianTaskInput, options: TechnicianTaskOptions): Promise<TechnicianTaskResult<TechnicianTask>> {
  const who = await authorize(request, state, 'job-room.technician-task.create', 'job-rooms:tasks:write', options);
  const now = options.now();
  const requestedItems = input.checklist.map(item => Object.freeze({...item, status: 'pending' as const, completedByMembershipId: null, completedAt: null}));
  if (!who || contractVersion !== TECHNICIAN_TASK_CONTRACT_VERSION || !timestamp(now) || !IDENTIFIER.test(input.requestKey) || !IDENTIFIER.test(input.jobRoomId) || !IDENTIFIER.test(input.schedulingHoldId) || !IDENTIFIER.test(input.assignedMembershipId) || !LABEL.test(input.title) || !validChecklist(requestedItems)) return rejected();
  try {
    const [room, creator, assigned, schedule, replay] = await Promise.all([
      options.store.getRoom(who.organizationId, input.jobRoomId),
      options.store.getMembership(who.organizationId, input.jobRoomId, who.subjectId),
      options.store.getMembershipById(who.organizationId, input.jobRoomId, input.assignedMembershipId),
      options.store.getSchedule(who.organizationId, input.schedulingHoldId),
      options.store.getTaskByRequestKey(who.organizationId, input.requestKey),
    ]);
    if (room?.organizationId !== who.organizationId || room.jobRoomId !== input.jobRoomId || room.status !== 'active' || creator?.organizationId !== who.organizationId || creator.jobRoomId !== input.jobRoomId || creator.subjectId !== who.subjectId || creator.role !== 'provider' || creator.status !== 'active' || assigned?.organizationId !== who.organizationId || assigned.jobRoomId !== input.jobRoomId || assigned.membershipId !== input.assignedMembershipId || assigned.role !== 'provider' || assigned.status !== 'active' || schedule?.organizationId !== who.organizationId || schedule.jobRoomId !== input.jobRoomId || schedule.schedulingHoldId !== input.schedulingHoldId || schedule.status !== 'confirmed' || schedule.providerMembershipId !== creator.membershipId) return rejected();
    if (replay !== null) return boundTask(replay, who.organizationId) && matchesCreation(replay, input) ? {accepted: true, value: replay, replayed: true} : rejected();
    const technicianTaskId = options.createOpaqueId();
    if (!IDENTIFIER.test(technicianTaskId)) return rejected();
    const value = Object.freeze({technicianTaskId, organizationId: who.organizationId, requestKey: input.requestKey, jobRoomId: input.jobRoomId, schedulingHoldId: input.schedulingHoldId, assignedMembershipId: input.assignedMembershipId, title: input.title, checklist: Object.freeze(requestedItems), status: 'active' as const, revision: 1, createdAt: now, completedAt: null});
    return await options.store.createTask(value) ? {accepted: true, value, replayed: false} : rejected();
  } catch { return rejected(); }
}

function boundCompletion(value: TechnicianChecklistCompletion | null, organizationId: string): value is TechnicianChecklistCompletion {
  return value?.organizationId === organizationId && IDENTIFIER.test(value.completionId) && IDENTIFIER.test(value.requestKey) && IDENTIFIER.test(value.technicianTaskId) && IDENTIFIER.test(value.checklistItemId) && IDENTIFIER.test(value.technicianMembershipId) && Number.isSafeInteger(value.taskRevision) && value.taskRevision >= 2 && timestamp(value.completedAt);
}

export async function completeTechnicianChecklistItem(contractVersion: number, request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState, input: CompleteTechnicianChecklistItemInput, options: TechnicianTaskOptions): Promise<TechnicianTaskResult<TechnicianTask>> {
  const who = await authorize(request, state, 'job-room.technician-task.checklist.complete', 'job-rooms:tasks:complete', options);
  const now = options.now();
  if (!who || contractVersion !== TECHNICIAN_TASK_CONTRACT_VERSION || !timestamp(now) || !IDENTIFIER.test(input.requestKey) || !IDENTIFIER.test(input.technicianTaskId) || !IDENTIFIER.test(input.checklistItemId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) return rejected();
  try {
    const [task, replay] = await Promise.all([options.store.getTask(who.organizationId, input.technicianTaskId), options.store.getCompletionByRequestKey(who.organizationId, input.requestKey)]);
    if (!boundTask(task, who.organizationId)) return rejected();
    const [room, member] = await Promise.all([options.store.getRoom(who.organizationId, task.jobRoomId), options.store.getMembership(who.organizationId, task.jobRoomId, who.subjectId)]);
    if (room?.organizationId !== who.organizationId || room.jobRoomId !== task.jobRoomId || room.status !== 'active' || member?.organizationId !== who.organizationId || member.jobRoomId !== task.jobRoomId || member.subjectId !== who.subjectId || member.membershipId !== task.assignedMembershipId || member.role !== 'provider' || member.status !== 'active') return rejected();
    if (replay !== null) {
      const item = task.checklist.find(candidate => candidate.checklistItemId === input.checklistItemId);
      const exact = boundCompletion(replay, who.organizationId) && replay.requestKey === input.requestKey && replay.technicianTaskId === input.technicianTaskId && replay.checklistItemId === input.checklistItemId && replay.technicianMembershipId === member.membershipId && replay.taskRevision === input.expectedRevision + 1 && task.revision === replay.taskRevision && item?.status === 'completed' && item.completedByMembershipId === member.membershipId && item.completedAt === replay.completedAt;
      return exact ? {accepted: true, value: task, replayed: true} : rejected();
    }
    if (task.status !== 'active' || task.revision !== input.expectedRevision) return rejected();
    const itemIndex = task.checklist.findIndex(item => item.checklistItemId === input.checklistItemId);
    if (itemIndex < 0 || task.checklist[itemIndex]?.status !== 'pending') return rejected();
    const checklist = task.checklist.map((item, index) => index === itemIndex ? Object.freeze({...item, status: 'completed' as const, completedByMembershipId: member.membershipId, completedAt: now}) : item);
    const allCompleted = checklist.every(item => item.status === 'completed');
    const updated = Object.freeze({...task, checklist: Object.freeze(checklist), status: allCompleted ? 'completed' as const : 'active' as const, revision: task.revision + 1, completedAt: allCompleted ? now : null});
    const completionId = options.createOpaqueId();
    if (!IDENTIFIER.test(completionId) || !boundTask(updated, who.organizationId)) return rejected();
    const completion = Object.freeze({completionId, organizationId: who.organizationId, requestKey: input.requestKey, technicianTaskId: input.technicianTaskId, checklistItemId: input.checklistItemId, technicianMembershipId: member.membershipId, taskRevision: updated.revision, completedAt: now});
    return await options.store.completeChecklistItem(updated, completion, input.expectedRevision) ? {accepted: true, value: updated, replayed: false} : rejected();
  } catch { return rejected(); }
}
