import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const COUPON_REDEMPTION_CONTRACT_VERSION = 1 as const;
export const COUPON_REDEMPTION_REJECTED = 'coupon_redemption_rejected' as const;

export interface CouponPolicy {
  readonly organizationId: string;
  readonly couponId: string;
  readonly revision: number;
  readonly codeDigest: string;
  readonly status: 'active' | 'paused' | 'retired';
  readonly discountKind: 'fixed_minor' | 'percent_basis_points';
  readonly discountValue: number;
  readonly maxDiscountMinor: number;
  readonly currency: string;
  readonly minimumSubtotalMinor: number;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly maxTotalRedemptions: number;
  readonly totalRedemptions: number;
  readonly maxRedemptionsPerCustomer: number;
}

export interface CouponQuote {
  readonly organizationId: string;
  readonly priceQuoteId: string;
  readonly customerSubjectId: string;
  readonly providerOrganizationId: string;
  readonly currency: string;
  readonly subtotalMinor: number;
}

export interface CouponRedemption {
  readonly redemptionId: string;
  readonly organizationId: string;
  readonly requestKey: string;
  readonly couponId: string;
  readonly couponRevision: number;
  readonly codeDigest: string;
  readonly priceQuoteId: string;
  readonly customerSubjectId: string;
  readonly providerOrganizationId: string;
  readonly currency: string;
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly discountedSubtotalMinor: number;
  readonly totalRedemptionNumber: number;
  readonly customerRedemptionNumber: number;
  readonly redeemedAt: number;
}

export interface RedeemCouponInput {
  readonly requestKey: string;
  readonly couponId: string;
  readonly expectedCouponRevision: number;
  readonly codeDigest: string;
  readonly priceQuoteId: string;
}

export interface CouponRedemptionStore {
  getCoupon(organizationId: string, couponId: string): Promise<CouponPolicy | null>;
  getQuote(organizationId: string, priceQuoteId: string): Promise<CouponQuote | null>;
  getCustomerRedemptionCount(
    organizationId: string,
    couponId: string,
    customerSubjectId: string,
  ): Promise<number>;
  getRedemptionByRequestKey(
    organizationId: string,
    requestKey: string,
  ): Promise<CouponRedemption | null>;
  redeemCoupon(
    coupon: CouponPolicy,
    expectedCustomerRedemptions: number,
    redemption: CouponRedemption,
  ): Promise<boolean>;
}

export interface CouponRedemptionOptions {
  readonly store: CouponRedemptionStore;
  readonly audit: TenantAuditOptions;
  readonly now: () => number;
  readonly createOpaqueId: () => string;
}

export type RedeemCouponResult =
  | {readonly accepted: true; readonly redemption: CouponRedemption; readonly replayed: boolean}
  | {readonly accepted: false; readonly code: typeof COUPON_REDEMPTION_REJECTED};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CURRENCY = /^[A-Z]{3}$/;
const DATE = 8_640_000_000_000_000;
const MAX_MONEY = 9_999_999_999;
const MAX_REDEMPTIONS = 1_000_000_000;
const integer = (value: number, min: number, max: number): boolean =>
  Number.isSafeInteger(value) && value >= min && value <= max;
const rejected = (): RedeemCouponResult => ({
  accepted: false,
  code: COUPON_REDEMPTION_REJECTED,
});

function validCoupon(value: CouponPolicy | null, organizationId: string): value is CouponPolicy {
  if (
    value?.organizationId !== organizationId ||
    !ID.test(value.couponId) ||
    !integer(value.revision, 1, Number.MAX_SAFE_INTEGER) ||
    !DIGEST.test(value.codeDigest) ||
    !['active', 'paused', 'retired'].includes(value.status) ||
    !['fixed_minor', 'percent_basis_points'].includes(value.discountKind) ||
    !CURRENCY.test(value.currency) ||
    !integer(value.minimumSubtotalMinor, 1, MAX_MONEY) ||
    !integer(value.maxDiscountMinor, 1, MAX_MONEY) ||
    !integer(value.startsAt, 0, DATE) ||
    !integer(value.endsAt, value.startsAt + 1, DATE) ||
    !integer(value.maxTotalRedemptions, 1, MAX_REDEMPTIONS) ||
    !integer(value.totalRedemptions, 0, value.maxTotalRedemptions) ||
    !integer(value.maxRedemptionsPerCustomer, 1, value.maxTotalRedemptions)
  ) {
    return false;
  }
  return value.discountKind === 'fixed_minor'
    ? integer(value.discountValue, 1, MAX_MONEY) && value.discountValue === value.maxDiscountMinor
    : integer(value.discountValue, 1, 10_000);
}

function validQuote(value: CouponQuote | null, organizationId: string): value is CouponQuote {
  return value?.organizationId === organizationId &&
    ID.test(value.priceQuoteId) &&
    ID.test(value.customerSubjectId) &&
    ID.test(value.providerOrganizationId) &&
    CURRENCY.test(value.currency) &&
    integer(value.subtotalMinor, 1, MAX_MONEY);
}

function validRedemption(
  value: CouponRedemption | null,
  organizationId: string,
): value is CouponRedemption {
  return value?.organizationId === organizationId &&
    ID.test(value.redemptionId) &&
    ID.test(value.requestKey) &&
    ID.test(value.couponId) &&
    integer(value.couponRevision, 1, Number.MAX_SAFE_INTEGER) &&
    DIGEST.test(value.codeDigest) &&
    ID.test(value.priceQuoteId) &&
    ID.test(value.customerSubjectId) &&
    ID.test(value.providerOrganizationId) &&
    CURRENCY.test(value.currency) &&
    integer(value.subtotalMinor, 1, MAX_MONEY) &&
    integer(value.discountMinor, 1, value.subtotalMinor) &&
    value.discountedSubtotalMinor === value.subtotalMinor - value.discountMinor &&
    integer(value.totalRedemptionNumber, 1, MAX_REDEMPTIONS) &&
    integer(value.customerRedemptionNumber, 1, MAX_REDEMPTIONS) &&
    integer(value.redeemedAt, 0, DATE);
}

function sameReplay(
  value: CouponRedemption,
  input: RedeemCouponInput,
  customerSubjectId: string,
): boolean {
  return value.requestKey === input.requestKey &&
    value.couponId === input.couponId &&
    value.couponRevision === input.expectedCouponRevision &&
    value.codeDigest === input.codeDigest &&
    value.priceQuoteId === input.priceQuoteId &&
    value.customerSubjectId === customerSubjectId;
}

function calculateDiscount(coupon: CouponPolicy, subtotalMinor: number): number {
  if (coupon.discountKind === 'fixed_minor') return Math.min(coupon.discountValue, subtotalMinor);
  return Math.min(
    Math.floor(subtotalMinor * coupon.discountValue / 10_000),
    coupon.maxDiscountMinor,
    subtotalMinor,
  );
}

export async function redeemCoupon(
  version: number,
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  input: RedeemCouponInput,
  options: CouponRedemptionOptions,
): Promise<RedeemCouponResult> {
  const auth = await authorizeAndAuditOrganizationAction(
    request,
    state,
    'commerce.coupon.redeem',
    options.audit,
  );
  const now = options.now();
  if (
    !auth.authorized ||
    request.requiredPermission !== 'commerce:coupons:redeem' ||
    version !== COUPON_REDEMPTION_CONTRACT_VERSION ||
    !integer(now, 0, DATE) ||
    !ID.test(input.requestKey) ||
    !ID.test(input.couponId) ||
    !integer(input.expectedCouponRevision, 1, Number.MAX_SAFE_INTEGER) ||
    !DIGEST.test(input.codeDigest) ||
    !ID.test(input.priceQuoteId)
  ) {
    return rejected();
  }
  try {
    const [coupon, quote, replay] = await Promise.all([
      options.store.getCoupon(auth.organizationId, input.couponId),
      options.store.getQuote(auth.organizationId, input.priceQuoteId),
      options.store.getRedemptionByRequestKey(auth.organizationId, input.requestKey),
    ]);
    if (replay !== null) {
      return validRedemption(replay, auth.organizationId) &&
        sameReplay(replay, input, auth.subjectId)
        ? {accepted: true, redemption: replay, replayed: true}
        : rejected();
    }
    if (
      !validCoupon(coupon, auth.organizationId) ||
      coupon.couponId !== input.couponId ||
      coupon.revision !== input.expectedCouponRevision ||
      coupon.codeDigest !== input.codeDigest ||
      coupon.status !== 'active' ||
      now < coupon.startsAt ||
      now >= coupon.endsAt ||
      coupon.totalRedemptions >= coupon.maxTotalRedemptions ||
      !validQuote(quote, auth.organizationId) ||
      quote.priceQuoteId !== input.priceQuoteId ||
      quote.customerSubjectId !== auth.subjectId ||
      quote.currency !== coupon.currency ||
      quote.subtotalMinor < coupon.minimumSubtotalMinor
    ) {
      return rejected();
    }
    const customerCount = await options.store.getCustomerRedemptionCount(
      auth.organizationId,
      coupon.couponId,
      auth.subjectId,
    );
    if (
      !integer(customerCount, 0, coupon.maxRedemptionsPerCustomer) ||
      customerCount >= coupon.maxRedemptionsPerCustomer
    ) {
      return rejected();
    }
    const discountMinor = calculateDiscount(coupon, quote.subtotalMinor);
    const redemptionId = options.createOpaqueId();
    if (!ID.test(redemptionId) || !integer(discountMinor, 1, quote.subtotalMinor)) return rejected();
    const redemption: CouponRedemption = Object.freeze({
      redemptionId,
      organizationId: auth.organizationId,
      requestKey: input.requestKey,
      couponId: coupon.couponId,
      couponRevision: coupon.revision,
      codeDigest: coupon.codeDigest,
      priceQuoteId: quote.priceQuoteId,
      customerSubjectId: quote.customerSubjectId,
      providerOrganizationId: quote.providerOrganizationId,
      currency: quote.currency,
      subtotalMinor: quote.subtotalMinor,
      discountMinor,
      discountedSubtotalMinor: quote.subtotalMinor - discountMinor,
      totalRedemptionNumber: coupon.totalRedemptions + 1,
      customerRedemptionNumber: customerCount + 1,
      redeemedAt: now,
    });
    return validRedemption(redemption, auth.organizationId) &&
      await options.store.redeemCoupon(coupon, customerCount, redemption)
      ? {accepted: true, redemption, replayed: false}
      : rejected();
  } catch {
    return rejected();
  }
}
