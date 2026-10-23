import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const AVAILABILITY_CONTRACT_VERSION = 1 as const;
export const AVAILABILITY_REJECTED = 'availability_rejected' as const;

export interface AvailabilityProvider {
  readonly providerOrganizationId: string;
  readonly organizationId: string;
  readonly status: 'draft' | 'active' | 'suspended' | 'closed';
}

export interface AvailabilityService {
  readonly organizationId: string;
  readonly serviceKey: string;
  readonly revision: number;
  readonly status: 'draft' | 'published' | 'retired';
}

export interface AvailabilityWindow {
  readonly startAt: number;
  readonly endAt: number;
}

export interface AvailabilitySchedule {
  readonly availabilityScheduleId: string;
  readonly organizationId: string;
  readonly providerOrganizationId: string;
  readonly serviceKey: string;
  readonly serviceRevision: number;
  readonly slotDurationMinutes: number;
  readonly minimumNoticeMinutes: number;
  readonly bookingHorizonDays: number;
  readonly windows: readonly AvailabilityWindow[];
  readonly status: 'active' | 'inactive';
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AvailabilityScheduleInput {
  readonly providerOrganizationId: string;
  readonly serviceKey: string;
  readonly slotDurationMinutes: number;
  readonly minimumNoticeMinutes: number;
  readonly bookingHorizonDays: number;
  readonly windows: readonly AvailabilityWindow[];
  readonly status: 'active' | 'inactive';
}

export interface AvailabilityBusyInterval {
  readonly busyIntervalId: string;
  readonly organizationId: string;
  readonly providerOrganizationId: string;
  readonly serviceKey: string;
  readonly startAt: number;
  readonly endAt: number;
}

export interface AppointmentSlotQuery {
  readonly providerOrganizationId: string;
  readonly serviceKey: string;
  readonly startAt: number;
  readonly endAt: number;
  readonly limit: number;
}

export interface AppointmentSlot {
  readonly availabilityScheduleId: string;
  readonly scheduleVersion: number;
  readonly providerOrganizationId: string;
  readonly serviceKey: string;
  readonly serviceRevision: number;
  readonly startAt: number;
  readonly endAt: number;
}

export interface AvailabilityStore {
  getProvider(organizationId: string, providerOrganizationId: string): Promise<AvailabilityProvider | null>;
  getPublishedService(organizationId: string, serviceKey: string): Promise<AvailabilityService | null>;
  getSchedule(organizationId: string, providerOrganizationId: string,
    serviceKey: string): Promise<AvailabilitySchedule | null>;
  replaceSchedule(current: AvailabilitySchedule | null,
    replacement: AvailabilitySchedule): Promise<boolean>;
  listBusyIntervals(organizationId: string, providerOrganizationId: string, serviceKey: string,
    startAt: number, endAt: number): Promise<readonly AvailabilityBusyInterval[]>;
}

export interface AvailabilityOptions {
  readonly store: AvailabilityStore;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
}

export type AvailabilityResult<T> =
  | {readonly accepted: true; readonly value: T}
  | {readonly accepted: false; readonly code: typeof AVAILABILITY_REJECTED};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY = /^[a-z][a-z0-9-]{0,62}$/;
const MINUTE = 60_000;
const DAY = 86_400_000;
const rejected = <T>(): AvailabilityResult<T> =>
  ({accepted: false, code: AVAILABILITY_REJECTED});

function timestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function safeAdd(value: number, increment: number): number | null {
  const result = value + increment;
  return Number.isSafeInteger(result) && result >= value ? result : null;
}

function boundProvider(value: AvailabilityProvider | null, organizationId: string,
  providerOrganizationId: string): value is AvailabilityProvider {
  return value?.organizationId === organizationId &&
    value.providerOrganizationId === providerOrganizationId && value.status === 'active';
}

function boundService(value: AvailabilityService | null, organizationId: string,
  serviceKey: string): value is AvailabilityService {
  return value?.organizationId === organizationId && value.serviceKey === serviceKey &&
    KEY.test(value.serviceKey) && Number.isSafeInteger(value.revision) && value.revision >= 1 &&
    value.status === 'published';
}

function normalizeWindows(values: readonly AvailabilityWindow[], duration: number):
  readonly AvailabilityWindow[] | null {
  if (values.length < 1 || values.length > 64) return null;
  const result = values.map(value => ({startAt: value.startAt, endAt: value.endAt}))
    .sort((left, right) => left.startAt - right.startAt || left.endAt - right.endAt);
  let projectedSlotCount = 0;
  for (let index = 0; index < result.length; index += 1) {
    const value = result[index];
    const previous = result[index - 1];
    if (!value || !timestamp(value.startAt) || !timestamp(value.endAt) ||
      value.endAt <= value.startAt || value.endAt - value.startAt < duration ||
      value.endAt - value.startAt > 366 * DAY ||
      (previous && previous.endAt > value.startAt)) return null;
    projectedSlotCount += Math.floor((value.endAt - value.startAt) / duration);
    if (projectedSlotCount > 10_000) return null;
  }
  return Object.freeze(result.map(value => Object.freeze(value)));
}

function boundSchedule(value: AvailabilitySchedule | null, organizationId: string,
  providerOrganizationId: string, serviceKey: string): value is AvailabilitySchedule {
  if (value?.organizationId !== organizationId ||
    value.providerOrganizationId !== providerOrganizationId || value.serviceKey !== serviceKey ||
    !IDENTIFIER.test(value.availabilityScheduleId) || !KEY.test(value.serviceKey) ||
    !Number.isSafeInteger(value.serviceRevision) || value.serviceRevision < 1 ||
    !Number.isSafeInteger(value.slotDurationMinutes) || value.slotDurationMinutes < 5 ||
    value.slotDurationMinutes > 480 || !Number.isSafeInteger(value.minimumNoticeMinutes) ||
    value.minimumNoticeMinutes < 0 || value.minimumNoticeMinutes > 43_200 ||
    !Number.isSafeInteger(value.bookingHorizonDays) || value.bookingHorizonDays < 1 ||
    value.bookingHorizonDays > 366 || !['active', 'inactive'].includes(value.status) ||
    !Number.isSafeInteger(value.version) || value.version < 1 || !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt) || value.updatedAt < value.createdAt) return false;
  const normalized = normalizeWindows(value.windows, value.slotDurationMinutes * MINUTE);
  return normalized !== null && normalized.every((window, index) =>
    window.startAt === value.windows[index]?.startAt && window.endAt === value.windows[index]?.endAt);
}

function boundBusyInterval(value: AvailabilityBusyInterval, organizationId: string,
  providerOrganizationId: string, serviceKey: string): boolean {
  return value.organizationId === organizationId &&
    value.providerOrganizationId === providerOrganizationId && value.serviceKey === serviceKey &&
    IDENTIFIER.test(value.busyIntervalId) && timestamp(value.startAt) && timestamp(value.endAt) &&
    value.endAt > value.startAt;
}

async function authorize(request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState, permission: string, action: string,
  options: AvailabilityOptions): Promise<string | null> {
  const result = await authorizeAndAuditOrganizationAction(request, state, action, options.audit);
  return result.authorized && request.requiredPermission === permission ? result.organizationId : null;
}

export async function putAvailabilitySchedule(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: AvailabilityScheduleInput, expectedVersion: number, options: AvailabilityOptions):
  Promise<AvailabilityResult<AvailabilitySchedule>> {
  const organizationId = await authorize(request, state, 'availability:write',
    'availability.schedule.put', options);
  const now = options.now();
  const duration = input.slotDurationMinutes * MINUTE;
  const windows = Number.isSafeInteger(duration) ? normalizeWindows(input.windows, duration) : null;
  if (!organizationId || contractVersion !== AVAILABILITY_CONTRACT_VERSION ||
    !IDENTIFIER.test(input.providerOrganizationId) || !KEY.test(input.serviceKey) ||
    !Number.isSafeInteger(input.slotDurationMinutes) || input.slotDurationMinutes < 5 ||
    input.slotDurationMinutes > 480 || !Number.isSafeInteger(input.minimumNoticeMinutes) ||
    input.minimumNoticeMinutes < 0 || input.minimumNoticeMinutes > 43_200 ||
    !Number.isSafeInteger(input.bookingHorizonDays) || input.bookingHorizonDays < 1 ||
    input.bookingHorizonDays > 366 || !['active', 'inactive'].includes(input.status) ||
    !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || !timestamp(now) || !windows) {
    return rejected();
  }
  try {
    const [provider, service, current] = await Promise.all([
      options.store.getProvider(organizationId, input.providerOrganizationId),
      options.store.getPublishedService(organizationId, input.serviceKey),
      options.store.getSchedule(organizationId, input.providerOrganizationId, input.serviceKey),
    ]);
    if (!boundProvider(provider, organizationId, input.providerOrganizationId) ||
      !boundService(service, organizationId, input.serviceKey) ||
      (current !== null && !boundSchedule(current, organizationId,
        input.providerOrganizationId, input.serviceKey)) ||
      (current?.version ?? 0) !== expectedVersion || (current && now < current.updatedAt)) {
      return rejected();
    }
    const availabilityScheduleId = current?.availabilityScheduleId ?? options.createOpaqueId();
    if (!IDENTIFIER.test(availabilityScheduleId)) return rejected();
    const replacement = Object.freeze({
      availabilityScheduleId, organizationId,
      providerOrganizationId: provider.providerOrganizationId, serviceKey: service.serviceKey,
      serviceRevision: service.revision, slotDurationMinutes: input.slotDurationMinutes,
      minimumNoticeMinutes: input.minimumNoticeMinutes,
      bookingHorizonDays: input.bookingHorizonDays, windows, status: input.status,
      version: (current?.version ?? 0) + 1, createdAt: current?.createdAt ?? now, updatedAt: now,
    });
    return await options.store.replaceSchedule(current, replacement)
      ? {accepted: true, value: replacement} : rejected();
  } catch {
    return rejected();
  }
}

export async function listAppointmentSlots(request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState, query: AppointmentSlotQuery,
  options: AvailabilityOptions): Promise<AvailabilityResult<readonly AppointmentSlot[]>> {
  const organizationId = await authorize(request, state, 'availability:read',
    'availability.slots.list', options);
  const now = options.now();
  if (!organizationId || !IDENTIFIER.test(query.providerOrganizationId) ||
    !KEY.test(query.serviceKey) || !timestamp(query.startAt) || !timestamp(query.endAt) ||
    query.endAt <= query.startAt || query.endAt - query.startAt > 366 * DAY ||
    !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 500 || !timestamp(now)) {
    return rejected();
  }
  try {
    const [provider, service, schedule, busyIntervals] = await Promise.all([
      options.store.getProvider(organizationId, query.providerOrganizationId),
      options.store.getPublishedService(organizationId, query.serviceKey),
      options.store.getSchedule(organizationId, query.providerOrganizationId, query.serviceKey),
      options.store.listBusyIntervals(organizationId, query.providerOrganizationId,
        query.serviceKey, query.startAt, query.endAt),
    ]);
    if (!boundProvider(provider, organizationId, query.providerOrganizationId) ||
      !boundService(service, organizationId, query.serviceKey) ||
      !boundSchedule(schedule, organizationId, query.providerOrganizationId, query.serviceKey) ||
      schedule.status !== 'active' || schedule.serviceRevision !== service.revision ||
      busyIntervals.length > 5_000 ||
      new Set(busyIntervals.map(value => value.busyIntervalId)).size !== busyIntervals.length ||
      busyIntervals.some(value => !boundBusyInterval(value, organizationId,
        query.providerOrganizationId, query.serviceKey))) return rejected();
    const noticeStart = safeAdd(now, schedule.minimumNoticeMinutes * MINUTE);
    const horizonEnd = safeAdd(now, schedule.bookingHorizonDays * DAY);
    const duration = schedule.slotDurationMinutes * MINUTE;
    if (noticeStart === null || horizonEnd === null || !Number.isSafeInteger(duration)) return rejected();
    const rangeStart = Math.max(query.startAt, noticeStart);
    const rangeEnd = Math.min(query.endAt, horizonEnd);
    const slots: AppointmentSlot[] = [];
    for (const window of schedule.windows) {
      for (let startAt = window.startAt; startAt < window.endAt && slots.length < query.limit;
        startAt += duration) {
        const endAt = safeAdd(startAt, duration);
        if (endAt === null || endAt > window.endAt || startAt < rangeStart || endAt > rangeEnd) continue;
        if (busyIntervals.some(value => value.startAt < endAt && value.endAt > startAt)) continue;
        slots.push(Object.freeze({
          availabilityScheduleId: schedule.availabilityScheduleId,
          scheduleVersion: schedule.version, providerOrganizationId: schedule.providerOrganizationId,
          serviceKey: schedule.serviceKey, serviceRevision: schedule.serviceRevision, startAt, endAt,
        }));
      }
      if (slots.length >= query.limit) break;
    }
    return {accepted: true, value: Object.freeze(slots)};
  } catch {
    return rejected();
  }
}
