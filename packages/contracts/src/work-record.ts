import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const WORK_RECORD_CONTRACT_VERSION = 1 as const;
export const WORK_RECORD_REJECTED = 'work_record_rejected' as const;

export interface WorkRecordRoom { readonly organizationId: string; readonly jobRoomId: string; readonly status: 'active' | 'closed'; }
export interface WorkRecordMember { readonly membershipId: string; readonly organizationId: string; readonly jobRoomId: string; readonly subjectId: string; readonly role: 'customer' | 'provider'; readonly status: 'active' | 'inactive'; }
export interface WorkRecordTask { readonly technicianTaskId: string; readonly organizationId: string; readonly jobRoomId: string; readonly assignedMembershipId: string; readonly status: 'active' | 'completed'; }
export interface InventoryItem { readonly inventoryItemId: string; readonly organizationId: string; readonly providerMembershipId: string; readonly sku: string; readonly unit: string; readonly availableQuantity: number; readonly revision: number; readonly status: 'active' | 'retired'; }
export interface MaterialUsage { readonly inventoryItemId: string; readonly sku: string; readonly unit: string; readonly quantity: number; readonly inventoryRevision: number; }
export interface TechnicianWorkRecord { readonly workRecordId: string; readonly organizationId: string; readonly requestKey: string; readonly jobRoomId: string; readonly technicianTaskId: string; readonly technicianMembershipId: string; readonly startedAt: number; readonly endedAt: number; readonly minutes: number; readonly materials: readonly MaterialUsage[]; readonly recordedAt: number; }
export interface RecordTechnicianWorkInput { readonly requestKey: string; readonly jobRoomId: string; readonly technicianTaskId: string; readonly startedAt: number; readonly endedAt: number; readonly materials: readonly {readonly inventoryItemId: string; readonly quantity: number; readonly expectedRevision: number}[]; }
export interface InventoryAdjustment { readonly before: InventoryItem; readonly after: InventoryItem; }

export interface WorkRecordStore {
  getRoom(organizationId: string, jobRoomId: string): Promise<WorkRecordRoom | null>;
  getMembership(organizationId: string, jobRoomId: string, subjectId: string): Promise<WorkRecordMember | null>;
  getTask(organizationId: string, technicianTaskId: string): Promise<WorkRecordTask | null>;
  getWorkByRequestKey(organizationId: string, requestKey: string): Promise<TechnicianWorkRecord | null>;
  hasOverlappingWork(organizationId: string, membershipId: string, startedAt: number, endedAt: number): Promise<boolean>;
  getInventoryItem(organizationId: string, inventoryItemId: string): Promise<InventoryItem | null>;
  recordWork(value: TechnicianWorkRecord, adjustments: readonly InventoryAdjustment[]): Promise<boolean>;
}
export interface WorkRecordOptions { readonly store: WorkRecordStore; readonly audit: TenantAuditOptions; readonly createOpaqueId: () => string; readonly now: () => number; }
export type WorkRecordResult = {readonly accepted: true; readonly value: TechnicianWorkRecord; readonly replayed: boolean} | {readonly accepted: false; readonly code: typeof WORK_RECORD_REJECTED};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TEXT = /^[\x20-\x7e]{1,80}$/;
const MAX_DATE = 8_640_000_000_000_000;
const rejected = (): WorkRecordResult => ({accepted: false, code: WORK_RECORD_REJECTED});
const timestamp = (value: number): boolean => Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE;
const positive = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

function boundInventory(value: InventoryItem | null, organizationId: string, membershipId: string): value is InventoryItem {
  return value?.organizationId === organizationId && value.providerMembershipId === membershipId && IDENTIFIER.test(value.inventoryItemId) && TEXT.test(value.sku) && TEXT.test(value.unit) && Number.isSafeInteger(value.availableQuantity) && value.availableQuantity >= 0 && Number.isSafeInteger(value.revision) && value.revision >= 1 && (value.status === 'active' || value.status === 'retired');
}

function boundRecord(value: TechnicianWorkRecord | null, organizationId: string): value is TechnicianWorkRecord {
  if (value?.organizationId !== organizationId || !IDENTIFIER.test(value.workRecordId) || !IDENTIFIER.test(value.requestKey) || !IDENTIFIER.test(value.jobRoomId) || !IDENTIFIER.test(value.technicianTaskId) || !IDENTIFIER.test(value.technicianMembershipId) || !timestamp(value.startedAt) || !timestamp(value.endedAt) || value.endedAt <= value.startedAt || !positive(value.minutes) || value.minutes !== Math.ceil((value.endedAt - value.startedAt) / 60_000) || !timestamp(value.recordedAt) || value.recordedAt < value.endedAt || value.materials.length > 25) return false;
  const ids = new Set<string>();
  return value.materials.every(material => IDENTIFIER.test(material.inventoryItemId) && !ids.has(material.inventoryItemId) && ids.add(material.inventoryItemId) && TEXT.test(material.sku) && TEXT.test(material.unit) && positive(material.quantity) && Number.isSafeInteger(material.inventoryRevision) && material.inventoryRevision >= 2);
}

function matches(value: TechnicianWorkRecord, input: RecordTechnicianWorkInput): boolean {
  return value.requestKey === input.requestKey && value.jobRoomId === input.jobRoomId && value.technicianTaskId === input.technicianTaskId && value.startedAt === input.startedAt && value.endedAt === input.endedAt && value.materials.length === input.materials.length && value.materials.every((material, index) => {
    const requested = input.materials[index];
    return requested !== undefined && material.inventoryItemId === requested.inventoryItemId && material.quantity === requested.quantity && material.inventoryRevision === requested.expectedRevision + 1;
  });
}

export async function recordTechnicianWork(contractVersion: number, request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState, input: RecordTechnicianWorkInput, options: WorkRecordOptions): Promise<WorkRecordResult> {
  const authorization = await authorizeAndAuditOrganizationAction(request, state, 'job-room.work-record.create', options.audit);
  const now = options.now();
  if (!authorization.authorized || request.requiredPermission !== 'job-rooms:work:record' || contractVersion !== WORK_RECORD_CONTRACT_VERSION || !timestamp(now) || !IDENTIFIER.test(input.requestKey) || !IDENTIFIER.test(input.jobRoomId) || !IDENTIFIER.test(input.technicianTaskId) || !timestamp(input.startedAt) || !timestamp(input.endedAt) || input.endedAt <= input.startedAt || input.endedAt > now || input.endedAt - input.startedAt > 24 * 60 * 60 * 1_000 || input.materials.length > 25) return rejected();
  const ids = new Set<string>();
  if (input.materials.some(material => !IDENTIFIER.test(material.inventoryItemId) || ids.has(material.inventoryItemId) || !ids.add(material.inventoryItemId) || !positive(material.quantity) || !Number.isSafeInteger(material.expectedRevision) || material.expectedRevision < 1)) return rejected();
  try {
    const [room, member, task, replay] = await Promise.all([
      options.store.getRoom(authorization.organizationId, input.jobRoomId),
      options.store.getMembership(authorization.organizationId, input.jobRoomId, authorization.subjectId),
      options.store.getTask(authorization.organizationId, input.technicianTaskId),
      options.store.getWorkByRequestKey(authorization.organizationId, input.requestKey),
    ]);
    if (room?.organizationId !== authorization.organizationId || room.jobRoomId !== input.jobRoomId || room.status !== 'active' || member?.organizationId !== authorization.organizationId || member.jobRoomId !== input.jobRoomId || member.subjectId !== authorization.subjectId || member.role !== 'provider' || member.status !== 'active' || task?.organizationId !== authorization.organizationId || task.jobRoomId !== input.jobRoomId || task.technicianTaskId !== input.technicianTaskId || task.assignedMembershipId !== member.membershipId || (task.status !== 'active' && task.status !== 'completed')) return rejected();
    if (replay !== null) return boundRecord(replay, authorization.organizationId) && replay.technicianMembershipId === member.membershipId && matches(replay, input) ? {accepted: true, value: replay, replayed: true} : rejected();
    if (await options.store.hasOverlappingWork(authorization.organizationId, member.membershipId, input.startedAt, input.endedAt)) return rejected();
    const inventory = await Promise.all(input.materials.map(material => options.store.getInventoryItem(authorization.organizationId, material.inventoryItemId)));
    const adjustments: InventoryAdjustment[] = [];
    const usages: MaterialUsage[] = [];
    for (const [index, requested] of input.materials.entries()) {
      const item = inventory[index] ?? null;
      if (!boundInventory(item, authorization.organizationId, member.membershipId) || item.status !== 'active' || item.revision !== requested.expectedRevision || item.availableQuantity < requested.quantity) return rejected();
      const after = Object.freeze({...item, availableQuantity: item.availableQuantity - requested.quantity, revision: item.revision + 1});
      adjustments.push(Object.freeze({before: item, after}));
      usages.push(Object.freeze({inventoryItemId: item.inventoryItemId, sku: item.sku, unit: item.unit, quantity: requested.quantity, inventoryRevision: after.revision}));
    }
    const workRecordId = options.createOpaqueId();
    if (!IDENTIFIER.test(workRecordId)) return rejected();
    const value = Object.freeze({workRecordId, organizationId: authorization.organizationId, requestKey: input.requestKey, jobRoomId: input.jobRoomId, technicianTaskId: input.technicianTaskId, technicianMembershipId: member.membershipId, startedAt: input.startedAt, endedAt: input.endedAt, minutes: Math.ceil((input.endedAt - input.startedAt) / 60_000), materials: Object.freeze(usages), recordedAt: now});
    if (!boundRecord(value, authorization.organizationId)) return rejected();
    return await options.store.recordWork(value, Object.freeze(adjustments)) ? {accepted: true, value, replayed: false} : rejected();
  } catch { return rejected(); }
}
