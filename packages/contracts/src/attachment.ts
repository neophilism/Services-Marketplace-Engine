import {
  authorizeAndAuditOrganizationAction,
  type TenantAuditOptions,
} from './audit.js';
import type {
  OrganizationAuthorizationRequest,
  OrganizationAuthorizationState,
} from './rbac.js';

export const ATTACHMENT_CONTRACT_VERSION = 1 as const;
export const ATTACHMENT_REJECTED = 'attachment_rejected' as const;

export interface Attachment {
  readonly attachmentId: string;
  readonly organizationId: string;
  readonly objectKey: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly status: 'quarantined' | 'clean' | 'infected';
  readonly createdAt: number;
}

export interface AttachmentStore {
  createQuarantined(attachment: Attachment): Promise<void>;
  get(organizationId: string, attachmentId: string): Promise<Attachment | null>;
  applyVerifiedVerdict(
    attachment: Attachment,
    verdict: 'clean' | 'infected',
    scannedAt: number,
  ): Promise<boolean>;
}

export interface QuarantineObjectStore {
  createUploadUrl(objectKey: string, contentType: string, sizeBytes: number): Promise<string>;
  createDownloadUrl(objectKey: string): Promise<string>;
  delete(objectKey: string): Promise<void>;
}

export interface ScanResult {
  readonly contractVersion: number;
  readonly attachmentId: string;
  readonly organizationId: string;
  readonly objectKey: string;
  readonly sha256: string;
  readonly verdict: 'clean' | 'infected' | 'error';
  readonly scannedAt: number;
  readonly evidence: unknown;
}

export interface AttachmentOptions {
  readonly store: AttachmentStore;
  readonly objects: QuarantineObjectStore;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
  readonly allowedContentTypes: ReadonlySet<string>;
  readonly maxSizeBytes: number;
  readonly verifyScanResult: (result: ScanResult) => Promise<boolean>;
}

export type AttachmentResult<T> =
  | {readonly accepted: true; readonly value: T}
  | {readonly accepted: false; readonly code: typeof ATTACHMENT_REJECTED};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const rejected = <T>(): AttachmentResult<T> => ({
  accepted: false,
  code: ATTACHMENT_REJECTED,
});

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validOptions(options: AttachmentOptions): boolean {
  return (
    Number.isSafeInteger(options.maxSizeBytes) &&
    options.maxSizeBytes > 0 &&
    options.allowedContentTypes.size > 0
  );
}

export async function beginAttachmentUpload(
  contractVersion: number,
  authorization: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  metadata: {contentType: string; sizeBytes: number; sha256: string},
  options: AttachmentOptions,
): Promise<AttachmentResult<{attachment: Attachment; uploadUrl: string}>> {
  const authorized = await authorizeAndAuditOrganizationAction(
    authorization,
    state,
    'attachment.upload',
    options.audit,
  );
  if (!authorized.authorized) return rejected();

  const attachmentId = options.createOpaqueId();
  const createdAt = options.now();
  if (
    contractVersion !== ATTACHMENT_CONTRACT_VERSION ||
    authorization.requiredPermission !== 'attachment:write' ||
    !validOptions(options) ||
    !IDENTIFIER.test(attachmentId) ||
    !options.allowedContentTypes.has(metadata.contentType) ||
    !Number.isSafeInteger(metadata.sizeBytes) ||
    metadata.sizeBytes <= 0 ||
    metadata.sizeBytes > options.maxSizeBytes ||
    !SHA256.test(metadata.sha256) ||
    !validTimestamp(createdAt)
  ) {
    return rejected();
  }

  const objectKey = `quarantine/${authorized.organizationId}/${attachmentId}`;
  const attachment = Object.freeze({
    attachmentId,
    organizationId: authorized.organizationId,
    objectKey,
    contentType: metadata.contentType,
    sizeBytes: metadata.sizeBytes,
    sha256: metadata.sha256,
    status: 'quarantined' as const,
    createdAt,
  });
  try {
    await options.store.createQuarantined(attachment);
    const uploadUrl = await options.objects.createUploadUrl(
      objectKey,
      metadata.contentType,
      metadata.sizeBytes,
    );
    if (!uploadUrl.startsWith('https://')) return rejected();
    return {accepted: true, value: {attachment, uploadUrl}};
  } catch {
    return rejected();
  }
}

export async function recordAttachmentScan(
  result: ScanResult,
  options: AttachmentOptions,
): Promise<AttachmentResult<{status: 'quarantined' | 'clean' | 'infected'}>> {
  if (
    result.contractVersion !== ATTACHMENT_CONTRACT_VERSION ||
    !IDENTIFIER.test(result.attachmentId) ||
    !IDENTIFIER.test(result.organizationId) ||
    !result.objectKey.startsWith(`quarantine/${result.organizationId}/`) ||
    !SHA256.test(result.sha256) ||
    !validTimestamp(result.scannedAt)
  ) {
    return rejected();
  }

  try {
    if (!await options.verifyScanResult(result)) return rejected();
    const attachment = await options.store.get(result.organizationId, result.attachmentId);
    if (
      !attachment ||
      attachment.status !== 'quarantined' ||
      attachment.objectKey !== result.objectKey ||
      attachment.sha256 !== result.sha256
    ) {
      return rejected();
    }
    if (result.verdict === 'error') {
      return {accepted: true, value: {status: 'quarantined'}};
    }
    if (!await options.store.applyVerifiedVerdict(attachment, result.verdict, result.scannedAt)) {
      return rejected();
    }
    if (result.verdict === 'infected') await options.objects.delete(attachment.objectKey);
    return {accepted: true, value: {status: result.verdict}};
  } catch {
    return rejected();
  }
}

export async function createAttachmentDownload(
  authorization: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  attachmentId: string,
  options: AttachmentOptions,
): Promise<AttachmentResult<{downloadUrl: string}>> {
  const authorized = await authorizeAndAuditOrganizationAction(
    authorization,
    state,
    'attachment.download',
    options.audit,
  );
  if (
    !authorized.authorized ||
    authorization.requiredPermission !== 'attachment:read' ||
    !IDENTIFIER.test(attachmentId)
  ) {
    return rejected();
  }

  try {
    const attachment = await options.store.get(authorized.organizationId, attachmentId);
    if (!attachment || attachment.status !== 'clean') return rejected();
    const downloadUrl = await options.objects.createDownloadUrl(attachment.objectKey);
    if (!downloadUrl.startsWith('https://')) return rejected();
    return {accepted: true, value: {downloadUrl}};
  } catch {
    return rejected();
  }
}
