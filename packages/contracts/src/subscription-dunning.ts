import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const SUBSCRIPTION_DUNNING_CONTRACT_VERSION = 1 as const;
export const SUBSCRIPTION_DUNNING_REJECTED = 'subscription_dunning_rejected' as const;

export interface SubscriptionBillingSnapshot {
  readonly organizationId: string;
  readonly subscriptionId: string;
  readonly revision: number;
  readonly customerSubjectId: string;
  readonly status: 'active' | 'past_due' | 'canceled';
  readonly currency: string;
  readonly billingAmountMinor: number;
  readonly scheduledChargeAt: number;
}

export interface DunningPolicy {
  readonly organizationId: string;
  readonly policyId: string;
  readonly revision: number;
  readonly status: 'active' | 'paused' | 'retired';
  readonly retryDelaysMs: readonly number[];
  readonly gracePeriodMs: number;
}

export interface VerifiedSubscriptionChargeFailure {
  readonly organizationId: string;
  readonly failureId: string;
  readonly subscriptionId: string;
  readonly subscriptionRevision: number;
  readonly customerSubjectId: string;
  readonly provider: string;
  readonly providerEventReference: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly scheduledChargeAt: number;
  readonly failedAt: number;
  readonly verified: boolean;
}

export interface SubscriptionDunningCase {
  readonly dunningCaseId: string;
  readonly organizationId: string;
  readonly requestKey: string;
  readonly subscriptionId: string;
  readonly subscriptionRevision: number;
  readonly customerSubjectId: string;
  readonly policyId: string;
  readonly policyRevision: number;
  readonly caseRevision: number;
  readonly failureNumber: number;
  readonly failureId: string;
  readonly provider: string;
  readonly providerEventReference: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly status: 'retry_scheduled' | 'exhausted';
  readonly graceEndsAt: number;
  readonly nextRetryAt: number | null;
  readonly updatedAt: number;
}

export interface RecordSubscriptionFailureInput {
  readonly requestKey: string;
  readonly subscriptionId: string;
  readonly expectedSubscriptionRevision: number;
  readonly policyId: string;
  readonly expectedPolicyRevision: number;
  readonly expectedCaseRevision: number;
  readonly failureId: string;
}

export interface SubscriptionDunningStore {
  getSubscription(
    organizationId: string,
    subscriptionId: string,
  ): Promise<SubscriptionBillingSnapshot | null>;
  getPolicy(organizationId: string, policyId: string): Promise<DunningPolicy | null>;
  getFailure(
    organizationId: string,
    failureId: string,
  ): Promise<VerifiedSubscriptionChargeFailure | null>;
  getCase(
    organizationId: string,
    subscriptionId: string,
  ): Promise<SubscriptionDunningCase | null>;
  getCaseByRequestKey(
    organizationId: string,
    requestKey: string,
  ): Promise<SubscriptionDunningCase | null>;
  recordFailure(
    subscription: SubscriptionBillingSnapshot,
    policy: DunningPolicy,
    expectedCase: SubscriptionDunningCase | null,
    failure: VerifiedSubscriptionChargeFailure,
    nextCase: SubscriptionDunningCase,
  ): Promise<boolean>;
}

export interface SubscriptionDunningOptions {
  readonly store: SubscriptionDunningStore;
  readonly audit: TenantAuditOptions;
  readonly now: () => number;
  readonly createOpaqueId: () => string;
}

export type RecordSubscriptionFailureResult =
  | {readonly accepted: true; readonly dunningCase: SubscriptionDunningCase; readonly replayed: boolean}
  | {readonly accepted: false; readonly code: typeof SUBSCRIPTION_DUNNING_REJECTED};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CURRENCY = /^[A-Z]{3}$/;
const DATE = 8_640_000_000_000_000;
const MAX_MONEY = 9_999_999_999;
const MAX_DELAY = 2_592_000_000;
const MAX_FAILURES = 5;
const integer = (value: number, min: number, max: number): boolean =>
  Number.isSafeInteger(value) && value >= min && value <= max;
const rejected = (): RecordSubscriptionFailureResult => ({
  accepted: false,
  code: SUBSCRIPTION_DUNNING_REJECTED,
});

function validSubscription(
  value: SubscriptionBillingSnapshot | null,
  organizationId: string,
): value is SubscriptionBillingSnapshot {
  return value?.organizationId === organizationId &&
    ID.test(value.subscriptionId) &&
    integer(value.revision, 1, Number.MAX_SAFE_INTEGER) &&
    ID.test(value.customerSubjectId) &&
    ['active', 'past_due', 'canceled'].includes(value.status) &&
    CURRENCY.test(value.currency) &&
    integer(value.billingAmountMinor, 1, MAX_MONEY) &&
    integer(value.scheduledChargeAt, 0, DATE);
}

function validPolicy(value: DunningPolicy | null, organizationId: string): value is DunningPolicy {
  return value?.organizationId === organizationId &&
    ID.test(value.policyId) &&
    integer(value.revision, 1, Number.MAX_SAFE_INTEGER) &&
    ['active', 'paused', 'retired'].includes(value.status) &&
    value.retryDelaysMs.length >= 1 &&
    value.retryDelaysMs.length <= MAX_FAILURES &&
    value.retryDelaysMs.every(delay => integer(delay, 1, MAX_DELAY)) &&
    value.retryDelaysMs.every((delay, index) => index === 0 || delay > value.retryDelaysMs[index - 1]!) &&
    integer(value.gracePeriodMs, 1, MAX_DELAY);
}

function validFailure(
  value: VerifiedSubscriptionChargeFailure | null,
  organizationId: string,
): value is VerifiedSubscriptionChargeFailure {
  return value?.organizationId === organizationId &&
    ID.test(value.failureId) &&
    ID.test(value.subscriptionId) &&
    integer(value.subscriptionRevision, 1, Number.MAX_SAFE_INTEGER) &&
    ID.test(value.customerSubjectId) &&
    ID.test(value.provider) &&
    ID.test(value.providerEventReference) &&
    CURRENCY.test(value.currency) &&
    integer(value.amountMinor, 1, MAX_MONEY) &&
    integer(value.scheduledChargeAt, 0, DATE) &&
    integer(value.failedAt, value.scheduledChargeAt, DATE) &&
    value.verified === true;
}

function validCase(
  value: SubscriptionDunningCase | null,
  organizationId: string,
): value is SubscriptionDunningCase {
  return value?.organizationId === organizationId &&
    ID.test(value.dunningCaseId) &&
    ID.test(value.requestKey) &&
    ID.test(value.subscriptionId) &&
    integer(value.subscriptionRevision, 1, Number.MAX_SAFE_INTEGER) &&
    ID.test(value.customerSubjectId) &&
    ID.test(value.policyId) &&
    integer(value.policyRevision, 1, Number.MAX_SAFE_INTEGER) &&
    integer(value.caseRevision, 1, Number.MAX_SAFE_INTEGER) &&
    integer(value.failureNumber, 1, MAX_FAILURES) &&
    ID.test(value.failureId) &&
    ID.test(value.provider) &&
    ID.test(value.providerEventReference) &&
    CURRENCY.test(value.currency) &&
    integer(value.amountMinor, 1, MAX_MONEY) &&
    (value.status === 'retry_scheduled' || value.status === 'exhausted') &&
    integer(value.graceEndsAt, 1, DATE) &&
    (value.nextRetryAt === null || integer(value.nextRetryAt, 1, value.graceEndsAt - 1)) &&
    (value.status === 'retry_scheduled') === (value.nextRetryAt !== null) &&
    integer(value.updatedAt, 0, DATE);
}

function sameReplay(
  value: SubscriptionDunningCase,
  input: RecordSubscriptionFailureInput,
  customerSubjectId: string,
): boolean {
  return value.requestKey === input.requestKey &&
    value.subscriptionId === input.subscriptionId &&
    value.subscriptionRevision === input.expectedSubscriptionRevision &&
    value.policyId === input.policyId &&
    value.policyRevision === input.expectedPolicyRevision &&
    value.caseRevision === input.expectedCaseRevision + 1 &&
    value.failureId === input.failureId &&
    value.customerSubjectId === customerSubjectId;
}

export async function recordSubscriptionFailure(
  version: number,
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  input: RecordSubscriptionFailureInput,
  options: SubscriptionDunningOptions,
): Promise<RecordSubscriptionFailureResult> {
  const auth = await authorizeAndAuditOrganizationAction(
    request,
    state,
    'commerce.subscription.dunning_failure',
    options.audit,
  );
  const now = options.now();
  if (
    !auth.authorized ||
    request.requiredPermission !== 'commerce:subscriptions:dunning' ||
    version !== SUBSCRIPTION_DUNNING_CONTRACT_VERSION ||
    !integer(now, 0, DATE) ||
    !ID.test(input.requestKey) ||
    !ID.test(input.subscriptionId) ||
    !integer(input.expectedSubscriptionRevision, 1, Number.MAX_SAFE_INTEGER) ||
    !ID.test(input.policyId) ||
    !integer(input.expectedPolicyRevision, 1, Number.MAX_SAFE_INTEGER) ||
    !integer(input.expectedCaseRevision, 0, Number.MAX_SAFE_INTEGER - 1) ||
    !ID.test(input.failureId)
  ) {
    return rejected();
  }
  try {
    const [subscription, policy, failure, currentCase, replay] = await Promise.all([
      options.store.getSubscription(auth.organizationId, input.subscriptionId),
      options.store.getPolicy(auth.organizationId, input.policyId),
      options.store.getFailure(auth.organizationId, input.failureId),
      options.store.getCase(auth.organizationId, input.subscriptionId),
      options.store.getCaseByRequestKey(auth.organizationId, input.requestKey),
    ]);
    if (replay !== null) {
      return validCase(replay, auth.organizationId) &&
        sameReplay(replay, input, auth.subjectId)
        ? {accepted: true, dunningCase: replay, replayed: true}
        : rejected();
    }
    if (
      !validSubscription(subscription, auth.organizationId) ||
      subscription.subscriptionId !== input.subscriptionId ||
      subscription.revision !== input.expectedSubscriptionRevision ||
      !['active', 'past_due'].includes(subscription.status) ||
      subscription.customerSubjectId !== auth.subjectId ||
      !validPolicy(policy, auth.organizationId) ||
      policy.policyId !== input.policyId ||
      policy.revision !== input.expectedPolicyRevision ||
      policy.status !== 'active' ||
      !validFailure(failure, auth.organizationId) ||
      failure.failureId !== input.failureId ||
      failure.subscriptionId !== subscription.subscriptionId ||
      failure.subscriptionRevision !== subscription.revision ||
      failure.customerSubjectId !== auth.subjectId ||
      failure.currency !== subscription.currency ||
      failure.amountMinor !== subscription.billingAmountMinor ||
      failure.scheduledChargeAt !== subscription.scheduledChargeAt ||
      failure.failedAt > now ||
      (currentCase === null
        ? input.expectedCaseRevision !== 0
        : !validCase(currentCase, auth.organizationId) ||
          currentCase.subscriptionId !== subscription.subscriptionId ||
          currentCase.subscriptionRevision !== subscription.revision ||
          currentCase.customerSubjectId !== auth.subjectId ||
          currentCase.policyId !== policy.policyId ||
          currentCase.policyRevision !== policy.revision ||
          currentCase.caseRevision !== input.expectedCaseRevision ||
          currentCase.status === 'exhausted')
    ) {
      return rejected();
    }
    const failureNumber = (currentCase?.failureNumber ?? 0) + 1;
    if (!integer(failureNumber, 1, MAX_FAILURES)) return rejected();
    const graceEndsAt = currentCase?.graceEndsAt ?? failure.failedAt + policy.gracePeriodMs;
    if (!integer(graceEndsAt, failure.failedAt + 1, DATE)) return rejected();
    const retryAt = failure.failedAt + (policy.retryDelaysMs[failureNumber - 1] ?? policy.gracePeriodMs);
    const nextRetryAt = failureNumber <= policy.retryDelaysMs.length && retryAt < graceEndsAt
      ? retryAt
      : null;
    const dunningCaseId = currentCase?.dunningCaseId ?? options.createOpaqueId();
    if (!ID.test(dunningCaseId)) return rejected();
    const nextCase: SubscriptionDunningCase = Object.freeze({
      dunningCaseId,
      organizationId: auth.organizationId,
      requestKey: input.requestKey,
      subscriptionId: subscription.subscriptionId,
      subscriptionRevision: subscription.revision,
      customerSubjectId: auth.subjectId,
      policyId: policy.policyId,
      policyRevision: policy.revision,
      caseRevision: input.expectedCaseRevision + 1,
      failureNumber,
      failureId: failure.failureId,
      provider: failure.provider,
      providerEventReference: failure.providerEventReference,
      currency: failure.currency,
      amountMinor: failure.amountMinor,
      status: nextRetryAt === null ? 'exhausted' : 'retry_scheduled',
      graceEndsAt,
      nextRetryAt,
      updatedAt: now,
    });
    return validCase(nextCase, auth.organizationId) &&
      await options.store.recordFailure(subscription, policy, currentCase, failure, nextCase)
      ? {accepted: true, dunningCase: nextCase, replayed: false}
      : rejected();
  } catch {
    return rejected();
  }
}
