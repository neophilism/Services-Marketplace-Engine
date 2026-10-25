import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const STORED_CREDIT_APPLICATION_CONTRACT_VERSION = 1 as const;
export const STORED_CREDIT_APPLICATION_REJECTED = 'stored_credit_application_rejected' as const;

export type StoredCreditSource =
  | {
      readonly kind: 'gift_card';
      readonly organizationId: string;
      readonly sourceId: string;
      readonly revision: number;
      readonly status: 'active' | 'frozen' | 'closed';
      readonly currency: string;
      readonly balanceMinor: number;
      readonly claimDigest: string;
      readonly expiresAt: number | null;
    }
  | {
      readonly kind: 'loyalty_credit';
      readonly organizationId: string;
      readonly sourceId: string;
      readonly revision: number;
      readonly status: 'active' | 'frozen' | 'closed';
      readonly currency: string;
      readonly balanceMinor: number;
      readonly customerSubjectId: string;
      readonly expiresAt: number | null;
    };

export interface StoredCreditQuote {
  readonly organizationId: string;
  readonly priceQuoteId: string;
  readonly customerSubjectId: string;
  readonly providerOrganizationId: string;
  readonly currency: string;
  readonly subtotalMinor: number;
}

export interface StoredCreditApplication {
  readonly applicationId: string;
  readonly organizationId: string;
  readonly requestKey: string;
  readonly sourceKind: StoredCreditSource['kind'];
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly claimDigest: string | null;
  readonly customerSubjectId: string;
  readonly priceQuoteId: string;
  readonly providerOrganizationId: string;
  readonly currency: string;
  readonly quoteSubtotalMinor: number;
  readonly appliedMinor: number;
  readonly remainingSourceBalanceMinor: number;
  readonly remainingQuoteSubtotalMinor: number;
  readonly appliedAt: number;
}

export interface ApplyStoredCreditInput {
  readonly requestKey: string;
  readonly sourceId: string;
  readonly expectedSourceRevision: number;
  readonly claimDigest?: string;
  readonly priceQuoteId: string;
  readonly amountMinor: number;
}

export interface StoredCreditApplicationStore {
  getSource(organizationId: string, sourceId: string): Promise<StoredCreditSource | null>;
  getQuote(organizationId: string, priceQuoteId: string): Promise<StoredCreditQuote | null>;
  getApplicationByRequestKey(
    organizationId: string,
    requestKey: string,
  ): Promise<StoredCreditApplication | null>;
  apply(
    source: StoredCreditSource,
    application: StoredCreditApplication,
  ): Promise<boolean>;
}

export interface StoredCreditApplicationOptions {
  readonly store: StoredCreditApplicationStore;
  readonly audit: TenantAuditOptions;
  readonly now: () => number;
  readonly createOpaqueId: () => string;
}

export type ApplyStoredCreditResult =
  | {readonly accepted: true; readonly application: StoredCreditApplication; readonly replayed: boolean}
  | {readonly accepted: false; readonly code: typeof STORED_CREDIT_APPLICATION_REJECTED};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CURRENCY = /^[A-Z]{3}$/;
const DATE = 8_640_000_000_000_000;
const MAX_MONEY = 9_999_999_999;
const integer = (value: number, min: number, max: number): boolean =>
  Number.isSafeInteger(value) && value >= min && value <= max;
const rejected = (): ApplyStoredCreditResult => ({
  accepted: false,
  code: STORED_CREDIT_APPLICATION_REJECTED,
});

function validSource(
  value: StoredCreditSource | null,
  organizationId: string,
): value is StoredCreditSource {
  if (
    value?.organizationId !== organizationId ||
    !ID.test(value.sourceId) ||
    !integer(value.revision, 1, Number.MAX_SAFE_INTEGER) ||
    !['active', 'frozen', 'closed'].includes(value.status) ||
    !CURRENCY.test(value.currency) ||
    !integer(value.balanceMinor, 1, MAX_MONEY) ||
    (value.expiresAt !== null && !integer(value.expiresAt, 1, DATE))
  ) {
    return false;
  }
  return value.kind === 'gift_card'
    ? DIGEST.test(value.claimDigest)
    : value.kind === 'loyalty_credit' && ID.test(value.customerSubjectId);
}

function validQuote(
  value: StoredCreditQuote | null,
  organizationId: string,
): value is StoredCreditQuote {
  return value?.organizationId === organizationId &&
    ID.test(value.priceQuoteId) &&
    ID.test(value.customerSubjectId) &&
    ID.test(value.providerOrganizationId) &&
    CURRENCY.test(value.currency) &&
    integer(value.subtotalMinor, 1, MAX_MONEY);
}

function validApplication(
  value: StoredCreditApplication | null,
  organizationId: string,
): value is StoredCreditApplication {
  return value?.organizationId === organizationId &&
    ID.test(value.applicationId) &&
    ID.test(value.requestKey) &&
    (value.sourceKind === 'gift_card' || value.sourceKind === 'loyalty_credit') &&
    ID.test(value.sourceId) &&
    integer(value.sourceRevision, 1, Number.MAX_SAFE_INTEGER) &&
    (value.sourceKind === 'gift_card' ? DIGEST.test(value.claimDigest ?? '') : value.claimDigest === null) &&
    ID.test(value.customerSubjectId) &&
    ID.test(value.priceQuoteId) &&
    ID.test(value.providerOrganizationId) &&
    CURRENCY.test(value.currency) &&
    integer(value.quoteSubtotalMinor, 1, MAX_MONEY) &&
    integer(value.appliedMinor, 1, value.quoteSubtotalMinor) &&
    integer(value.remainingSourceBalanceMinor, 0, MAX_MONEY) &&
    value.remainingQuoteSubtotalMinor === value.quoteSubtotalMinor - value.appliedMinor &&
    integer(value.appliedAt, 0, DATE);
}

function sameReplay(
  value: StoredCreditApplication,
  input: ApplyStoredCreditInput,
  customerSubjectId: string,
): boolean {
  return value.requestKey === input.requestKey &&
    value.sourceId === input.sourceId &&
    value.sourceRevision === input.expectedSourceRevision &&
    value.claimDigest === (input.claimDigest ?? null) &&
    value.priceQuoteId === input.priceQuoteId &&
    value.appliedMinor === input.amountMinor &&
    value.customerSubjectId === customerSubjectId;
}

export async function applyStoredCredit(
  version: number,
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  input: ApplyStoredCreditInput,
  options: StoredCreditApplicationOptions,
): Promise<ApplyStoredCreditResult> {
  const auth = await authorizeAndAuditOrganizationAction(
    request,
    state,
    'commerce.stored_credit.apply',
    options.audit,
  );
  const now = options.now();
  if (
    !auth.authorized ||
    request.requiredPermission !== 'commerce:stored-credit:apply' ||
    version !== STORED_CREDIT_APPLICATION_CONTRACT_VERSION ||
    !integer(now, 0, DATE) ||
    !ID.test(input.requestKey) ||
    !ID.test(input.sourceId) ||
    !integer(input.expectedSourceRevision, 1, Number.MAX_SAFE_INTEGER) ||
    !ID.test(input.priceQuoteId) ||
    !integer(input.amountMinor, 1, MAX_MONEY) ||
    (input.claimDigest !== undefined && !DIGEST.test(input.claimDigest))
  ) {
    return rejected();
  }
  try {
    const [source, quote, replay] = await Promise.all([
      options.store.getSource(auth.organizationId, input.sourceId),
      options.store.getQuote(auth.organizationId, input.priceQuoteId),
      options.store.getApplicationByRequestKey(auth.organizationId, input.requestKey),
    ]);
    if (replay !== null) {
      return validApplication(replay, auth.organizationId) &&
        sameReplay(replay, input, auth.subjectId)
        ? {accepted: true, application: replay, replayed: true}
        : rejected();
    }
    if (
      !validSource(source, auth.organizationId) ||
      source.sourceId !== input.sourceId ||
      source.revision !== input.expectedSourceRevision ||
      source.status !== 'active' ||
      (source.expiresAt !== null && now >= source.expiresAt) ||
      !validQuote(quote, auth.organizationId) ||
      quote.priceQuoteId !== input.priceQuoteId ||
      quote.customerSubjectId !== auth.subjectId ||
      quote.currency !== source.currency ||
      input.amountMinor > source.balanceMinor ||
      input.amountMinor > quote.subtotalMinor ||
      (source.kind === 'gift_card'
        ? source.claimDigest !== input.claimDigest
        : source.customerSubjectId !== auth.subjectId || input.claimDigest !== undefined)
    ) {
      return rejected();
    }
    const applicationId = options.createOpaqueId();
    if (!ID.test(applicationId)) return rejected();
    const application: StoredCreditApplication = Object.freeze({
      applicationId,
      organizationId: auth.organizationId,
      requestKey: input.requestKey,
      sourceKind: source.kind,
      sourceId: source.sourceId,
      sourceRevision: source.revision,
      claimDigest: source.kind === 'gift_card' ? source.claimDigest : null,
      customerSubjectId: auth.subjectId,
      priceQuoteId: quote.priceQuoteId,
      providerOrganizationId: quote.providerOrganizationId,
      currency: quote.currency,
      quoteSubtotalMinor: quote.subtotalMinor,
      appliedMinor: input.amountMinor,
      remainingSourceBalanceMinor: source.balanceMinor - input.amountMinor,
      remainingQuoteSubtotalMinor: quote.subtotalMinor - input.amountMinor,
      appliedAt: now,
    });
    return validApplication(application, auth.organizationId) &&
      await options.store.apply(source, application)
      ? {accepted: true, application, replayed: false}
      : rejected();
  } catch {
    return rejected();
  }
}
