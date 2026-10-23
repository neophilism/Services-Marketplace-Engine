import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const SCHEDULING_CONTRACT_VERSION = 1 as const;
export const SCHEDULING_REJECTED = 'scheduling_rejected' as const;

export interface SchedulingRoom {
  readonly organizationId: string;
  readonly jobRoomId: string;
  readonly status: 'active' | 'closed';
}

export interface SchedulingMember {
  readonly membershipId: string;
  readonly organizationId: string;
  readonly jobRoomId: string;
  readonly subjectId: string;
  readonly role: 'customer' | 'provider';
}

export interface SignedContract {
  readonly organizationId: string;
  readonly jobRoomId: string;
  readonly envelopeId: string;
  readonly status: 'pending' | 'signed';
}

export interface SchedulingHold {
  readonly schedulingHoldId: string;
  readonly organizationId: string;
  readonly requestKey: string;
  readonly jobRoomId: string;
  readonly contractEnvelopeId: string;
  readonly providerMembershipId: string;
  readonly summary: string;
  readonly startAt: number;
  readonly endAt: number;
  readonly expiresAt: number;
  readonly status: 'held' | 'confirmed';
  readonly createdAt: number;
  readonly confirmedAt: number | null;
}

export interface SchedulingStore {
  getRoom(organizationId: string, jobRoomId: string): Promise<SchedulingRoom | null>;
  getMembership(organizationId: string, jobRoomId: string,
    subjectId: string): Promise<SchedulingMember | null>;
  getSignedContract(organizationId: string, jobRoomId: string,
    envelopeId: string): Promise<SignedContract | null>;
  getHoldByRequestKey(organizationId: string, requestKey: string): Promise<SchedulingHold | null>;
  getHold(organizationId: string, schedulingHoldId: string): Promise<SchedulingHold | null>;
  createHoldIfNoConflict(value: SchedulingHold, now: number): Promise<boolean>;
  confirmHold(value: SchedulingHold, expectedStatus: 'held', now: number): Promise<boolean>;
}

export interface SchedulingOptions {
  readonly store: SchedulingStore;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
}

export type SchedulingResult<T> =
  | {readonly accepted: true; readonly value: T; readonly replayed: boolean}
  | {readonly accepted: false; readonly code: typeof SCHEDULING_REJECTED};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SUMMARY = /^[\x20-\x7e]{1,80}$/;
const MINUTE = 60_000;
const DAY = 86_400_000;
const MAX_DATE = 8_640_000_000_000_000;
const rejected = <T>(): SchedulingResult<T> =>
  ({accepted: false, code: SCHEDULING_REJECTED});

function timestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE;
}

function boundHold(value: SchedulingHold | null, organizationId: string): value is SchedulingHold {
  return value?.organizationId === organizationId && IDENTIFIER.test(value.schedulingHoldId) &&
    IDENTIFIER.test(value.requestKey) && IDENTIFIER.test(value.jobRoomId) &&
    IDENTIFIER.test(value.contractEnvelopeId) && IDENTIFIER.test(value.providerMembershipId) &&
    SUMMARY.test(value.summary) && timestamp(value.startAt) && timestamp(value.endAt) &&
    value.endAt > value.startAt && value.endAt - value.startAt <= 30 * DAY &&
    timestamp(value.expiresAt) && timestamp(value.createdAt) && value.expiresAt > value.createdAt &&
    value.expiresAt <= value.startAt && ((value.status === 'held' && value.confirmedAt === null) ||
      (value.status === 'confirmed' && value.confirmedAt !== null &&
        timestamp(value.confirmedAt) && value.confirmedAt >= value.createdAt &&
        value.confirmedAt < value.startAt));
}

async function authorize(request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState, action: string,
  options: SchedulingOptions): Promise<{organizationId: string; subjectId: string} | null> {
  const result = await authorizeAndAuditOrganizationAction(request, state, action, options.audit);
  return result.authorized && request.requiredPermission === 'job-rooms:scheduling:write'
    ? {organizationId: result.organizationId, subjectId: result.subjectId} : null;
}

export async function createSchedulingHold(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: {requestKey: string; jobRoomId: string; contractEnvelopeId: string;
    summary: string; startAt: number; endAt: number; holdMinutes: number},
  options: SchedulingOptions): Promise<SchedulingResult<SchedulingHold>> {
  const who = await authorize(request, state, 'job-room.schedule.hold', options);
  const now = options.now();
  if (!who || contractVersion !== SCHEDULING_CONTRACT_VERSION || !timestamp(now) ||
    !IDENTIFIER.test(input.requestKey) || !IDENTIFIER.test(input.jobRoomId) ||
    !IDENTIFIER.test(input.contractEnvelopeId) || !SUMMARY.test(input.summary) ||
    !timestamp(input.startAt) || !timestamp(input.endAt) || input.startAt <= now ||
    input.endAt <= input.startAt || input.endAt - input.startAt > 30 * DAY ||
    !Number.isSafeInteger(input.holdMinutes) || input.holdMinutes < 5 ||
    input.holdMinutes > 1_440) return rejected();
  const requestedExpiry = now + input.holdMinutes * MINUTE;
  if (!Number.isSafeInteger(requestedExpiry)) return rejected();
  try {
    const [room, membership, contract, replay] = await Promise.all([
      options.store.getRoom(who.organizationId, input.jobRoomId),
      options.store.getMembership(who.organizationId, input.jobRoomId, who.subjectId),
      options.store.getSignedContract(who.organizationId, input.jobRoomId,
        input.contractEnvelopeId),
      options.store.getHoldByRequestKey(who.organizationId, input.requestKey),
    ]);
    if (room?.organizationId !== who.organizationId || room.jobRoomId !== input.jobRoomId ||
      room.status !== 'active' || membership?.organizationId !== who.organizationId ||
      membership.jobRoomId !== input.jobRoomId || membership.subjectId !== who.subjectId ||
      membership.role !== 'provider' || !IDENTIFIER.test(membership.membershipId) ||
      contract?.organizationId !== who.organizationId || contract.jobRoomId !== input.jobRoomId ||
      contract.envelopeId !== input.contractEnvelopeId || contract.status !== 'signed') {
      return rejected();
    }
    if (replay !== null) {
      const exact = boundHold(replay, who.organizationId) &&
        replay.requestKey === input.requestKey && replay.jobRoomId === input.jobRoomId &&
        replay.contractEnvelopeId === input.contractEnvelopeId &&
        replay.providerMembershipId === membership.membershipId &&
        replay.summary === input.summary && replay.startAt === input.startAt &&
        replay.endAt === input.endAt && (replay.status === 'confirmed' || replay.expiresAt > now);
      return exact ? {accepted: true, value: replay, replayed: true} : rejected();
    }
    const schedulingHoldId = options.createOpaqueId();
    const expiresAt = Math.min(requestedExpiry, input.startAt);
    if (!IDENTIFIER.test(schedulingHoldId) || expiresAt <= now) return rejected();
    const value = Object.freeze({
      schedulingHoldId, organizationId: who.organizationId, requestKey: input.requestKey,
      jobRoomId: input.jobRoomId, contractEnvelopeId: input.contractEnvelopeId,
      providerMembershipId: membership.membershipId, summary: input.summary,
      startAt: input.startAt, endAt: input.endAt, expiresAt, status: 'held' as const,
      createdAt: now, confirmedAt: null,
    });
    return await options.store.createHoldIfNoConflict(value, now)
      ? {accepted: true, value, replayed: false} : rejected();
  } catch {
    return rejected();
  }
}

export async function confirmSchedulingHold(request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState, schedulingHoldId: string,
  options: SchedulingOptions): Promise<SchedulingResult<{hold: SchedulingHold; ics: string}>> {
  const who = await authorize(request, state, 'job-room.schedule.confirm', options);
  const now = options.now();
  if (!who || !IDENTIFIER.test(schedulingHoldId) || !timestamp(now)) return rejected();
  try {
    const current = await options.store.getHold(who.organizationId, schedulingHoldId);
    if (!boundHold(current, who.organizationId)) return rejected();
    const [room, membership, contract] = await Promise.all([
      options.store.getRoom(who.organizationId, current.jobRoomId),
      options.store.getMembership(who.organizationId, current.jobRoomId, who.subjectId),
      options.store.getSignedContract(who.organizationId, current.jobRoomId,
        current.contractEnvelopeId),
    ]);
    if (room?.organizationId !== who.organizationId || room.jobRoomId !== current.jobRoomId ||
      room.status !== 'active' || membership?.organizationId !== who.organizationId ||
      membership.jobRoomId !== current.jobRoomId || membership.subjectId !== who.subjectId ||
      membership.role !== 'provider' || membership.membershipId !== current.providerMembershipId ||
      contract?.organizationId !== who.organizationId || contract.jobRoomId !== current.jobRoomId ||
      contract.envelopeId !== current.contractEnvelopeId || contract.status !== 'signed') {
      return rejected();
    }
    if (current.status === 'confirmed') {
      return {accepted: true, value: Object.freeze({hold: current,
        ics: renderSchedulingIcs(current)}), replayed: true};
    }
    if (current.expiresAt <= now || now >= current.startAt) return rejected();
    const confirmed = Object.freeze({...current, status: 'confirmed' as const, confirmedAt: now});
    if (!await options.store.confirmHold(confirmed, 'held', now)) return rejected();
    return {accepted: true, value: Object.freeze({hold: confirmed,
      ics: renderSchedulingIcs(confirmed)}), replayed: false};
  } catch {
    return rejected();
  }
}

function icsTimestamp(value: number): string {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function escapeIcs(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

function foldIcs(line: string): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < line.length; offset += 73) {
    chunks.push((offset === 0 ? '' : ' ') + line.slice(offset, offset + 73));
  }
  return chunks.join('\r\n');
}

export function renderSchedulingIcs(hold: SchedulingHold): string {
  if (!boundHold(hold, hold.organizationId) || hold.status !== 'confirmed' ||
    hold.confirmedAt === null) throw Error(SCHEDULING_REJECTED);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Services Marketplace Engine//Scheduling//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${hold.schedulingHoldId}@services-marketplace-engine`,
    `DTSTAMP:${icsTimestamp(hold.confirmedAt)}`, `DTSTART:${icsTimestamp(hold.startAt)}`,
    `DTEND:${icsTimestamp(hold.endAt)}`, `SUMMARY:${escapeIcs(hold.summary)}`,
    `X-SME-JOB-ROOM-ID:${hold.jobRoomId}`, 'STATUS:CONFIRMED', 'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.map(foldIcs).join('\r\n') + '\r\n';
}
