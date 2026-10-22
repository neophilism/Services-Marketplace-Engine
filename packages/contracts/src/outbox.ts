import {
  authorizeAndAuditOrganizationAction,
  type TenantAuditOptions,
} from './audit.js';
import type {
  OrganizationAuthorizationRequest,
  OrganizationAuthorizationState,
} from './rbac.js';

export const OUTBOX_CONTRACT_VERSION = 1 as const;
export const OUTBOX_REJECTED = 'outbox_rejected' as const;

type CommandResponse = Readonly<Record<string, unknown>>;

export interface OutboxMessage {
  readonly contractVersion: typeof OUTBOX_CONTRACT_VERSION;
  readonly messageId: string;
  readonly organizationId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly topic: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

export interface LeasedOutboxMessage extends OutboxMessage {
  readonly attempt: number;
  readonly leaseToken: string;
  readonly leaseExpiresAt: number;
}

export type CommandCommit<T extends CommandResponse> =
  | {
      readonly status: 'committed' | 'replayed';
      readonly messageId: string;
      readonly response: T;
    }
  | {readonly status: 'conflict'};

export interface OutboxStore {
  executeCommand<T extends CommandResponse>(
    message: OutboxMessage,
    operation: () => Promise<T>,
  ): Promise<CommandCommit<T>>;
  claimNext(now: number, leaseExpiresAt: number): Promise<LeasedOutboxMessage | null>;
  consume(
    consumerId: string,
    message: LeasedOutboxMessage,
    handler: (message: OutboxMessage) => Promise<void>,
  ): Promise<'processed' | 'duplicate'>;
  acknowledge(messageId: string, leaseToken: string): Promise<boolean>;
  retry(messageId: string, leaseToken: string, availableAt: number): Promise<boolean>;
  deadLetter(messageId: string, leaseToken: string): Promise<boolean>;
}

export interface EnqueueOutboxRequest<T extends CommandResponse> {
  readonly contractVersion: number;
  readonly authorization: OrganizationAuthorizationRequest;
  readonly state: OrganizationAuthorizationState;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly topic: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly operation: () => Promise<T>;
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
  | {readonly status: 'duplicate'; readonly messageId: string}
  | {readonly status: 'retry_scheduled'; readonly messageId: string}
  | {readonly status: 'dead_lettered'; readonly messageId: string}
  | {readonly status: 'failed'; readonly code: typeof OUTBOX_REJECTED};

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 10;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

const rejected = <T>(): OutboxResult<T> => ({
  accepted: false,
  code: OUTBOX_REJECTED,
});

function isIdentifier(value: string): boolean {
  return IDENTIFIER.test(value);
}

function isTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isValidLease(message: LeasedOutboxMessage): boolean {
  return (
    message.contractVersion === OUTBOX_CONTRACT_VERSION &&
    isIdentifier(message.messageId) &&
    isIdentifier(message.organizationId) &&
    isIdentifier(message.idempotencyKey) &&
    SHA256_DIGEST.test(message.requestDigest) &&
    isIdentifier(message.topic) &&
    isIdentifier(message.leaseToken) &&
    isTimestamp(message.createdAt) &&
    isTimestamp(message.leaseExpiresAt) &&
    Number.isSafeInteger(message.attempt) &&
    message.attempt > 0
  );
}

export async function enqueueOutboxMessage<T extends CommandResponse>(
  request: EnqueueOutboxRequest<T>,
  options: OutboxOptions,
): Promise<OutboxResult<{
  messageId: string;
  created: boolean;
  response: T;
}>> {
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
    request.contractVersion !== OUTBOX_CONTRACT_VERSION ||
    request.authorization.requiredPermission !== 'outbox:enqueue' ||
    !isIdentifier(request.idempotencyKey) ||
    !SHA256_DIGEST.test(request.requestDigest) ||
    !isIdentifier(request.topic) ||
    !isIdentifier(messageId) ||
    !isTimestamp(createdAt)
  ) {
    return rejected();
  }

  const message = Object.freeze({
    contractVersion: OUTBOX_CONTRACT_VERSION,
    messageId,
    organizationId: authorization.organizationId,
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
    topic: request.topic,
    payload: Object.freeze({...request.payload}),
    createdAt,
  });

  try {
    const result = await options.store.executeCommand(message, request.operation);
    if (result.status === 'conflict' || !isIdentifier(result.messageId)) return rejected();
    return {
      accepted: true,
      value: {
        messageId: result.messageId,
        created: result.status === 'committed',
        response: result.response,
      },
    };
  } catch {
    return rejected();
  }
}

export async function dispatchNextOutboxMessage(
  consumerId: string,
  handler: (message: OutboxMessage) => Promise<void>,
  options: OutboxOptions,
): Promise<DispatchResult> {
  const now = options.now();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (
    !isIdentifier(consumerId) ||
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
    const delivery = await options.store.consume(consumerId, message, handler);
    if (!await options.store.acknowledge(message.messageId, message.leaseToken)) {
      return {status: 'failed', code: OUTBOX_REJECTED};
    }
    return {
      status: delivery === 'duplicate' ? 'duplicate' : 'acknowledged',
      messageId: message.messageId,
    };
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
