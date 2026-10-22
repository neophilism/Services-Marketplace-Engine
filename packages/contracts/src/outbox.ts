import {
  authorizeAndAuditOrganizationAction,
  type TenantAuditOptions,
} from './audit.js';
import type {
  OrganizationAuthorizationRequest,
  OrganizationAuthorizationState,
} from './rbac.js';

export const OUTBOX_REJECTED = 'outbox_rejected' as const;

export interface OutboxMessage {
  readonly messageId: string;
  readonly organizationId: string;
  readonly idempotencyKey: string;
  readonly topic: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

export interface LeasedOutboxMessage extends OutboxMessage {
  readonly attempt: number;
  readonly leaseToken: string;
  readonly leaseExpiresAt: number;
}

export interface OutboxStore {
  enqueueUnique(message: OutboxMessage): Promise<{
    readonly created: boolean;
    readonly messageId: string;
  }>;
  claimNext(now: number, leaseExpiresAt: number): Promise<LeasedOutboxMessage | null>;
  acknowledge(messageId: string, leaseToken: string): Promise<boolean>;
  retry(messageId: string, leaseToken: string, availableAt: number): Promise<boolean>;
  deadLetter(messageId: string, leaseToken: string): Promise<boolean>;
}

export interface EnqueueOutboxRequest {
  readonly authorization: OrganizationAuthorizationRequest;
  readonly state: OrganizationAuthorizationState;
  readonly idempotencyKey: string;
  readonly topic: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface OutboxOptions {
  readonly store: OutboxStore;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
  readonly leaseMs?: number;
  readonly retryDelayMs?: number;
  readonly maxAttempts?: number;
}

export type OutboxResult<T> =
  | {readonly accepted: true; readonly value: T}
  | {readonly accepted: false; readonly code: typeof OUTBOX_REJECTED};

export type DispatchResult =
  | {readonly status: 'idle'}
  | {readonly status: 'acknowledged'; readonly messageId: string}
  | {readonly status: 'retry_scheduled'; readonly messageId: string}
  | {readonly status: 'dead_lettered'; readonly messageId: string}
  | {readonly status: 'failed'; readonly code: typeof OUTBOX_REJECTED};

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 10;

const rejected = <T>(): OutboxResult<T> => ({
  accepted: false,
  code: OUTBOX_REJECTED,
});

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function isTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isValidLease(message: LeasedOutboxMessage): boolean {
  return (
    isNonEmpty(message.messageId) &&
    isNonEmpty(message.organizationId) &&
    isNonEmpty(message.idempotencyKey) &&
    isNonEmpty(message.topic) &&
    isNonEmpty(message.leaseToken) &&
    isTimestamp(message.createdAt) &&
    isTimestamp(message.leaseExpiresAt) &&
    Number.isSafeInteger(message.attempt) &&
    message.attempt > 0
  );
}

export async function enqueueOutboxMessage(
  request: EnqueueOutboxRequest,
  options: OutboxOptions,
): Promise<OutboxResult<{messageId: string; created: boolean}>> {
  const authorization = await authorizeAndAuditOrganizationAction(
    request.authorization,
    request.state,
    'outbox.enqueue',
    options.audit,
  );
  if (!authorization.authorized) return rejected();

  const createdAt = options.now();
  const messageId = options.createOpaqueId();
  if (
    request.authorization.requiredPermission !== 'outbox:enqueue' ||
    !isNonEmpty(request.idempotencyKey) ||
    !isNonEmpty(request.topic) ||
    !isNonEmpty(messageId) ||
    !isTimestamp(createdAt)
  ) {
    return rejected();
  }

  const message = Object.freeze({
    messageId,
    organizationId: authorization.organizationId,
    idempotencyKey: request.idempotencyKey,
    topic: request.topic,
    payload: Object.freeze({...request.payload}),
    createdAt,
  });

  try {
    const result = await options.store.enqueueUnique(message);
    if (!isNonEmpty(result.messageId)) return rejected();
    return {accepted: true, value: {messageId: result.messageId, created: result.created}};
  } catch {
    return rejected();
  }
}

export async function dispatchNextOutboxMessage(
  handler: (message: OutboxMessage) => Promise<void>,
  options: OutboxOptions,
): Promise<DispatchResult> {
  const now = options.now();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (
    !isTimestamp(now) ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs <= 0 ||
    !Number.isSafeInteger(retryDelayMs) ||
    retryDelayMs <= 0 ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts <= 0
  ) {
    return {status: 'failed', code: OUTBOX_REJECTED};
  }

  let message: LeasedOutboxMessage | null;
  try {
    message = await options.store.claimNext(now, now + leaseMs);
  } catch {
    return {status: 'failed', code: OUTBOX_REJECTED};
  }
  if (!message) return {status: 'idle'};
  if (!isValidLease(message) || message.leaseExpiresAt !== now + leaseMs) {
    return {status: 'failed', code: OUTBOX_REJECTED};
  }

  try {
    await handler(message);
    if (!await options.store.acknowledge(message.messageId, message.leaseToken)) {
      return {status: 'failed', code: OUTBOX_REJECTED};
    }
    return {status: 'acknowledged', messageId: message.messageId};
  } catch {
    try {
      if (message.attempt >= maxAttempts) {
        if (!await options.store.deadLetter(message.messageId, message.leaseToken)) {
          return {status: 'failed', code: OUTBOX_REJECTED};
        }
        return {status: 'dead_lettered', messageId: message.messageId};
      }
      if (!await options.store.retry(
        message.messageId,
        message.leaseToken,
        now + retryDelayMs,
      )) {
        return {status: 'failed', code: OUTBOX_REJECTED};
      }
      return {status: 'retry_scheduled', messageId: message.messageId};
    } catch {
      return {status: 'failed', code: OUTBOX_REJECTED};
    }
  }
}
