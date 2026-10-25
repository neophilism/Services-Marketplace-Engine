import test from 'node:test';
import assert from 'node:assert/strict';
import {redeemCoupon} from '../packages/contracts/dist/coupon-redemption.js';

const digest = 'a'.repeat(64);
const state = {
  organizations: [{organizationId: 'org', status: 'active'}],
  memberships: [{
    subjectId: 'customer-1',
    organizationId: 'org',
    status: 'active',
    roleIds: ['customer'],
  }],
  roles: [{
    roleId: 'customer',
    organizationId: 'org',
    permissions: ['commerce:coupons:redeem'],
  }],
};
const auth = {
  subjectId: 'customer-1',
  organizationId: 'org',
  resourceOrganizationId: 'org',
  requiredPermission: 'commerce:coupons:redeem',
};
const input = (changes = {}) => ({
  requestKey: 'request-1',
  couponId: 'coupon-1',
  expectedCouponRevision: 2,
  codeDigest: digest,
  priceQuoteId: 'quote-1',
  ...changes,
});

function fixture() {
  let coupon = {
    organizationId: 'org',
    couponId: 'coupon-1',
    revision: 2,
    codeDigest: digest,
    status: 'active',
    discountKind: 'percent_basis_points',
    discountValue: 2500,
    maxDiscountMinor: 2000,
    currency: 'USD',
    minimumSubtotalMinor: 1000,
    startsAt: 500,
    endsAt: 2000,
    maxTotalRedemptions: 3,
    totalRedemptions: 0,
    maxRedemptionsPerCustomer: 1,
  };
  const quote = {
    organizationId: 'org',
    priceQuoteId: 'quote-1',
    customerSubjectId: 'customer-1',
    providerOrganizationId: 'provider-1',
    currency: 'USD',
    subtotalMinor: 5000,
  };
  const redemptions = new Map();
  const redeemedQuotes = new Set();
  let customerCount = 0;
  let sequence = 0;
  const options = {
    store: {
      getCoupon: async () => coupon,
      getQuote: async () => quote,
      getCustomerRedemptionCount: async () => customerCount,
      getRedemptionByRequestKey: async (_organizationId, key) => redemptions.get(key) ?? null,
      redeemCoupon: async (expectedCoupon, expectedCustomerCount, redemption) => {
        if (
          expectedCoupon !== coupon ||
          expectedCustomerCount !== customerCount ||
          redemptions.has(redemption.requestKey) ||
          redeemedQuotes.has(redemption.priceQuoteId) ||
          coupon.totalRedemptions >= coupon.maxTotalRedemptions
        ) return false;
        coupon = {...coupon, totalRedemptions: coupon.totalRedemptions + 1};
        customerCount += 1;
        redemptions.set(redemption.requestKey, redemption);
        redeemedQuotes.add(redemption.priceQuoteId);
        return true;
      },
    },
    audit: {
      sink: {append: async () => {}},
      createOpaqueId: () => `audit-${++sequence}`,
      now: () => 1000,
    },
    now: () => 1000,
    createOpaqueId: () => `redemption-${++sequence}`,
  };
  return {
    options,
    coupon: () => coupon,
    quote,
    fail: () => { options.store.redeemCoupon = async () => false; },
  };
}

test('atomically redeems an exact quote and replays the result', async () => {
  const fixtureValue = fixture();
  const command = input();
  const first = await redeemCoupon(1, auth, state, command, fixtureValue.options);
  assert.equal(first.accepted, true);
  assert.equal(first.redemption.discountMinor, 1250);
  assert.equal(first.redemption.discountedSubtotalMinor, 3750);
  assert.equal(fixtureValue.coupon().totalRedemptions, 1);
  const replay = await redeemCoupon(1, auth, state, command, fixtureValue.options);
  assert.equal(replay.accepted, true);
  assert.equal(replay.replayed, true);
  assert.equal((await redeemCoupon(1, auth, state, input({priceQuoteId: 'quote-2'}), fixtureValue.options)).accepted, false);
  assert.equal((await redeemCoupon(1, auth, state, input({requestKey: 'request-2'}), fixtureValue.options)).accepted, false);
});

test('enforces customer, currency, revision, digest, time, and redemption limits', async () => {
  const customer = fixture();
  customer.options.store.getQuote = async () => ({...customer.quote, customerSubjectId: 'other'});
  assert.equal((await redeemCoupon(1, auth, state, input(), customer.options)).accepted, false);
  const currency = fixture();
  currency.options.store.getQuote = async () => ({...currency.quote, currency: 'CAD'});
  assert.equal((await redeemCoupon(1, auth, state, input(), currency.options)).accepted, false);
  assert.equal((await redeemCoupon(1, auth, state, input({expectedCouponRevision: 1}), fixture().options)).accepted, false);
  assert.equal((await redeemCoupon(1, auth, state, input({codeDigest: 'b'.repeat(64)}), fixture().options)).accepted, false);
  const ended = fixture();
  ended.options.now = () => 2000;
  assert.equal((await redeemCoupon(1, auth, state, input(), ended.options)).accepted, false);
  const limited = fixture();
  limited.options.store.getCustomerRedemptionCount = async () => 1;
  assert.equal((await redeemCoupon(1, auth, state, input(), limited.options)).accepted, false);
});

test('rejects unauthorized and contaminated coupon records', async () => {
  assert.equal((await redeemCoupon(1, {...auth, resourceOrganizationId: 'other'}, state, input(), fixture().options)).accepted, false);
  const tenant = fixture();
  tenant.options.store.getCoupon = async () => ({...tenant.coupon(), organizationId: 'other'});
  assert.equal((await redeemCoupon(1, auth, state, input(), tenant.options)).accepted, false);
  const paused = fixture();
  paused.options.store.getCoupon = async () => ({...paused.coupon(), status: 'paused'});
  assert.equal((await redeemCoupon(1, auth, state, input(), paused.options)).accepted, false);
  const replay = fixture();
  const first = await redeemCoupon(1, auth, state, input(), replay.options);
  replay.options.store.getRedemptionByRequestKey = async () => ({
    ...first.redemption,
    customerSubjectId: 'other',
  });
  assert.equal((await redeemCoupon(1, auth, state, input(), replay.options)).accepted, false);
});

test('fails closed on audit and atomic redemption failures', async () => {
  const audit = fixture();
  audit.options.audit.sink.append = async () => { throw Error('down'); };
  assert.equal((await redeemCoupon(1, auth, state, input(), audit.options)).accepted, false);
  const store = fixture();
  store.fail();
  assert.equal((await redeemCoupon(1, auth, state, input(), store.options)).accepted, false);
  assert.equal(store.coupon().totalRedemptions, 0);
});
