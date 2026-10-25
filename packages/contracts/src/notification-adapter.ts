import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const NOTIFICATION_ADAPTER_CONTRACT_VERSION = 1 as const;
export const NOTIFICATION_ADAPTER_REJECTED = 'notification_adapter_rejected' as const;

export type NotificationChannel = 'email' | 'push' | 'sms';

export interface NotificationOperator {
  readonly organizationId: string;
  readonly subjectId: string;
  readonly status: 'active' | 'inactive';
  readonly permissions: readonly string[];
}

export interface NotificationIntent {
  readonly intentId: string;
  readonly organizationId: string;
  readonly status: 'ready' | 'cancelled';
  readonly channel: NotificationChannel;
  readonly recipientReference: string;
  readonly templateKey: string;
  readonly payloadReference: string;
  readonly notBefore: number;
  readonly expiresAt: number;
}

export interface NotificationDelivery {
  readonly deliveryId: string;
  readonly organizationId: string;
  readonly requestKey: string;
  readonly intentId: string;
  readonly channel: NotificationChannel;
  readonly recipientReference: string;
  readonly templateKey: string;
  readonly payloadReference: string;
  readonly providerMessageId: string;
  readonly actorSubjectId: string;
  readonly dispatchedAt: number;
}

export interface NotificationDeliveryCommand {
  readonly organizationId: string;
  readonly requestKey: string;
  readonly intentId: string;
  readonly recipientReference: string;
  readonly templateKey: string;
  readonly payloadReference: string;
}

export interface NotificationChannelAdapter {
  send(command: NotificationDeliveryCommand): Promise<{readonly providerMessageId: string}>;
}

export interface NotificationAdapterStore {
  getOperator(organizationId: string, subjectId: string): Promise<NotificationOperator | null>;
  getIntent(organizationId: string, intentId: string): Promise<NotificationIntent | null>;
  getDeliveryByRequestKey(organizationId: string, requestKey: string):
    Promise<NotificationDelivery | null>;
  commit(intent: NotificationIntent, delivery: NotificationDelivery): Promise<boolean>;
}

export interface DispatchNotificationInput {
  readonly requestKey: string;
  readonly intentId: string;
}

export interface NotificationAdapterOptions {
  readonly store: NotificationAdapterStore;
  readonly adapters: Readonly<Partial<Record<NotificationChannel, NotificationChannelAdapter>>>;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
}

export type NotificationAdapterResult =
  | {readonly accepted: true; readonly value: NotificationDelivery; readonly replayed: boolean}
  | {readonly accepted: false; readonly code: typeof NOTIFICATION_ADAPTER_REJECTED};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CHANNELS = new Set<NotificationChannel>(['email', 'push', 'sms']);
const DATE = 8_640_000_000_000_000;
const rejected = (): NotificationAdapterResult =>
  ({accepted: false, code: NOTIFICATION_ADAPTER_REJECTED});
const timestamp = (value: number): boolean => Number.isSafeInteger(value) && value >= 0 && value <= DATE;

function validIntent(value: NotificationIntent | null, organizationId: string): value is NotificationIntent {
  return value?.organizationId === organizationId && ID.test(value.intentId) &&
    (value.status === 'ready' || value.status === 'cancelled') && CHANNELS.has(value.channel) &&
    ID.test(value.recipientReference) && ID.test(value.templateKey) &&
    ID.test(value.payloadReference) && timestamp(value.notBefore) &&
    timestamp(value.expiresAt) && value.expiresAt > value.notBefore;
}

function validDelivery(value: NotificationDelivery | null,
  organizationId: string): value is NotificationDelivery {
  return value?.organizationId === organizationId && ID.test(value.deliveryId) &&
    ID.test(value.requestKey) && ID.test(value.intentId) && CHANNELS.has(value.channel) &&
    ID.test(value.recipientReference) && ID.test(value.templateKey) &&
    ID.test(value.payloadReference) && ID.test(value.providerMessageId) &&
    ID.test(value.actorSubjectId) && timestamp(value.dispatchedAt);
}

function exactReplay(value: NotificationDelivery, input: DispatchNotificationInput,
  intent: NotificationIntent): boolean {
  return value.requestKey === input.requestKey && value.intentId === input.intentId &&
    value.channel === intent.channel && value.recipientReference === intent.recipientReference &&
    value.templateKey === intent.templateKey && value.payloadReference === intent.payloadReference;
}

export async function dispatchNotification(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: DispatchNotificationInput, options: NotificationAdapterOptions):
  Promise<NotificationAdapterResult> {
  const authorization = await authorizeAndAuditOrganizationAction(
    request, state, 'notifications.dispatch', options.audit);
  const now = options.now();
  if (!authorization.authorized || request.requiredPermission !== 'notifications:dispatch' ||
    contractVersion !== NOTIFICATION_ADAPTER_CONTRACT_VERSION ||
    !ID.test(input.requestKey) || !ID.test(input.intentId) || !timestamp(now)) return rejected();

  try {
    const [operator, intent, replay] = await Promise.all([
      options.store.getOperator(authorization.organizationId, authorization.subjectId),
      options.store.getIntent(authorization.organizationId, input.intentId),
      options.store.getDeliveryByRequestKey(authorization.organizationId, input.requestKey),
    ]);
    if (operator?.organizationId !== authorization.organizationId ||
      operator.subjectId !== authorization.subjectId || operator.status !== 'active' ||
      !operator.permissions.includes('notifications:dispatch') ||
      !validIntent(intent, authorization.organizationId) || intent.intentId !== input.intentId ||
      intent.status !== 'ready' || now < intent.notBefore || now >= intent.expiresAt) return rejected();
    if (replay !== null) return validDelivery(replay, authorization.organizationId) &&
      replay.actorSubjectId === authorization.subjectId && exactReplay(replay, input, intent)
      ? {accepted: true, value: replay, replayed: true} : rejected();
    const adapter = options.adapters[intent.channel];
    if (!adapter) return rejected();
    const receipt = await adapter.send(Object.freeze({
      organizationId: authorization.organizationId, requestKey: input.requestKey,
      intentId: intent.intentId, recipientReference: intent.recipientReference,
      templateKey: intent.templateKey, payloadReference: intent.payloadReference,
    }));
    const deliveryId = options.createOpaqueId();
    if (!ID.test(deliveryId) || !ID.test(receipt.providerMessageId)) return rejected();
    const delivery = Object.freeze({
      deliveryId, organizationId: authorization.organizationId, requestKey: input.requestKey,
      intentId: intent.intentId, channel: intent.channel,
      recipientReference: intent.recipientReference, templateKey: intent.templateKey,
      payloadReference: intent.payloadReference, providerMessageId: receipt.providerMessageId,
      actorSubjectId: authorization.subjectId, dispatchedAt: now,
    });
    return validDelivery(delivery, authorization.organizationId) &&
      await options.store.commit(intent, delivery)
      ? {accepted: true, value: delivery, replayed: false} : rejected();
  } catch {
    return rejected();
  }
}
