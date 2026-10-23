import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const EXTERNAL_PAYMENT_RECORD_CONTRACT_VERSION = 1 as const;
export const EXTERNAL_PAYMENT_RECORD_REJECTED = 'external_payment_record_rejected' as const;

export interface ExternalPaymentRoom {
  readonly organizationId: string;
  readonly jobRoomId: string;
  readonly customerSubjectId: string;
  readonly providerOrganizationId: string;
  readonly status: 'active' | 'completed' | 'closed';
}
export interface ExternalPaymentReporter {
  readonly organizationId: string;
  readonly jobRoomId: string;
  readonly subjectId: string;
  readonly role: 'customer' | 'provider';
  readonly providerOrganizationId: string | null;
  readonly status: 'active' | 'revoked';
}
export interface ExternalPaymentEvidence {
  readonly organizationId: string;
  readonly jobRoomId: string;
  readonly attachmentId: string;
  readonly status: 'clean' | 'quarantined' | 'infected' | 'deleted';
}
export interface ExternalPaymentRecord {
  readonly externalPaymentRecordId: string;
  readonly organizationId: string;
  readonly requestKey: string;
  readonly jobRoomId: string;
  readonly customerSubjectId: string;
  readonly providerOrganizationId: string;
  readonly reporterSubjectId: string;
  readonly reporterRole: 'customer' | 'provider';
  readonly method: 'cash' | 'check' | 'bank_transfer' | 'card' | 'other';
  readonly externalReference: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly paidAt: number;
  readonly evidenceAttachmentId: string;
  readonly status: 'reported';
  readonly createdAt: number;
}
export interface RecordExternalPaymentInput {
  readonly requestKey: string;
  readonly jobRoomId: string;
  readonly method: ExternalPaymentRecord['method'];
  readonly externalReference: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly paidAt: number;
  readonly evidenceAttachmentId: string;
}
export interface ExternalPaymentRecordStore {
  getRoom(organizationId: string, jobRoomId: string): Promise<ExternalPaymentRoom | null>;
  getReporter(organizationId: string, jobRoomId: string, subjectId: string): Promise<ExternalPaymentReporter | null>;
  getEvidence(organizationId: string, attachmentId: string): Promise<ExternalPaymentEvidence | null>;
  getByRequestKey(organizationId: string, requestKey: string): Promise<ExternalPaymentRecord | null>;
  createRecord(value: ExternalPaymentRecord): Promise<boolean>;
}
export interface ExternalPaymentRecordOptions {
  readonly store: ExternalPaymentRecordStore;
  readonly audit: TenantAuditOptions;
  readonly now: () => number;
  readonly createOpaqueId: () => string;
}
export type ExternalPaymentRecordResult =
  | {readonly accepted: true; readonly value: ExternalPaymentRecord; readonly replayed: boolean}
  | {readonly accepted: false; readonly code: typeof EXTERNAL_PAYMENT_RECORD_REJECTED};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CURRENCY = /^[A-Z]{3}$/;
const MAX_AMOUNT_MINOR = 9_999_999_999;
const MAX_DATE = 8_640_000_000_000_000;
const METHODS = new Set<ExternalPaymentRecord['method']>(['cash', 'check', 'bank_transfer', 'card', 'other']);
const integer = (value: number, minimum: number, maximum: number) =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const rejected = (): ExternalPaymentRecordResult => ({
  accepted: false,
  code: EXTERNAL_PAYMENT_RECORD_REJECTED,
});
const boundRecord = (
  value: ExternalPaymentRecord | null,
  organizationId: string,
): value is ExternalPaymentRecord =>
  value?.organizationId === organizationId &&
  ID.test(value.externalPaymentRecordId) &&
  ID.test(value.requestKey) &&
  ID.test(value.jobRoomId) &&
  ID.test(value.customerSubjectId) &&
  ID.test(value.providerOrganizationId) &&
  ID.test(value.reporterSubjectId) &&
  (value.reporterRole === 'customer' || value.reporterRole === 'provider') &&
  METHODS.has(value.method) &&
  ID.test(value.externalReference) &&
  integer(value.amountMinor, 1, MAX_AMOUNT_MINOR) &&
  CURRENCY.test(value.currency) &&
  integer(value.paidAt, 0, MAX_DATE) &&
  ID.test(value.evidenceAttachmentId) &&
  value.status === 'reported' &&
  integer(value.createdAt, value.paidAt, MAX_DATE);

const exactReplay = (
  value: ExternalPaymentRecord,
  input: RecordExternalPaymentInput,
  room: ExternalPaymentRoom,
  reporter: ExternalPaymentReporter,
) =>
  value.requestKey === input.requestKey &&
  value.jobRoomId === room.jobRoomId &&
  value.customerSubjectId === room.customerSubjectId &&
  value.providerOrganizationId === room.providerOrganizationId &&
  value.reporterSubjectId === reporter.subjectId &&
  value.reporterRole === reporter.role &&
  value.method === input.method &&
  value.externalReference === input.externalReference &&
  value.amountMinor === input.amountMinor &&
  value.currency === input.currency &&
  value.paidAt === input.paidAt &&
  value.evidenceAttachmentId === input.evidenceAttachmentId;

export async function recordExternalPayment(
  contractVersion: number,
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  input: RecordExternalPaymentInput,
  options: ExternalPaymentRecordOptions,
): Promise<ExternalPaymentRecordResult> {
  const authorization = await authorizeAndAuditOrganizationAction(
    request,
    state,
    'commerce.external-payment.record',
    options.audit,
  );
  const now = options.now();
  if (
    !authorization.authorized ||
    request.requiredPermission !== 'commerce:external-payments:record' ||
    contractVersion !== EXTERNAL_PAYMENT_RECORD_CONTRACT_VERSION ||
    !integer(now, 0, MAX_DATE) ||
    !ID.test(input.requestKey) ||
    !ID.test(input.jobRoomId) ||
    !METHODS.has(input.method) ||
    !ID.test(input.externalReference) ||
    !integer(input.amountMinor, 1, MAX_AMOUNT_MINOR) ||
    !CURRENCY.test(input.currency) ||
    !integer(input.paidAt, 0, now) ||
    !ID.test(input.evidenceAttachmentId)
  ) return rejected();

  try {
    const [room, reporter, evidence, replay] = await Promise.all([
      options.store.getRoom(authorization.organizationId, input.jobRoomId),
      options.store.getReporter(authorization.organizationId, input.jobRoomId, authorization.subjectId),
      options.store.getEvidence(authorization.organizationId, input.evidenceAttachmentId),
      options.store.getByRequestKey(authorization.organizationId, input.requestKey),
    ]);
    if (
      room?.organizationId !== authorization.organizationId ||
      room.jobRoomId !== input.jobRoomId ||
      (room.status !== 'active' && room.status !== 'completed') ||
      !ID.test(room.customerSubjectId) ||
      !ID.test(room.providerOrganizationId) ||
      reporter?.organizationId !== authorization.organizationId ||
      reporter.jobRoomId !== room.jobRoomId ||
      reporter.subjectId !== authorization.subjectId ||
      reporter.status !== 'active' ||
      (reporter.role === 'customer'
        ? reporter.providerOrganizationId !== null || room.customerSubjectId !== reporter.subjectId
        : reporter.role !== 'provider' || reporter.providerOrganizationId !== room.providerOrganizationId) ||
      evidence?.organizationId !== authorization.organizationId ||
      evidence.jobRoomId !== room.jobRoomId ||
      evidence.attachmentId !== input.evidenceAttachmentId ||
      evidence.status !== 'clean'
    ) return rejected();

    if (replay !== null) {
      return boundRecord(replay, authorization.organizationId) &&
        exactReplay(replay, input, room, reporter)
        ? {accepted: true, value: replay, replayed: true}
        : rejected();
    }

    const externalPaymentRecordId = options.createOpaqueId();
    if (!ID.test(externalPaymentRecordId)) return rejected();
    const value: ExternalPaymentRecord = Object.freeze({
      externalPaymentRecordId,
      organizationId: authorization.organizationId,
      requestKey: input.requestKey,
      jobRoomId: room.jobRoomId,
      customerSubjectId: room.customerSubjectId,
      providerOrganizationId: room.providerOrganizationId,
      reporterSubjectId: reporter.subjectId,
      reporterRole: reporter.role,
      method: input.method,
      externalReference: input.externalReference,
      amountMinor: input.amountMinor,
      currency: input.currency,
      paidAt: input.paidAt,
      evidenceAttachmentId: input.evidenceAttachmentId,
      status: 'reported',
      createdAt: now,
    });
    return boundRecord(value, authorization.organizationId) &&
      await options.store.createRecord(value)
      ? {accepted: true, value, replayed: false}
      : rejected();
  } catch {
    return rejected();
  }
}
