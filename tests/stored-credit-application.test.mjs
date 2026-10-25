import test from 'node:test';
import assert from 'node:assert/strict';
import {applyStoredCredit} from '../packages/contracts/dist/stored-credit-application.js';

const digest = 'c'.repeat(64);
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
    permissions: ['commerce:stored-credit:apply'],
  }],
};
const auth = {
  subjectId: 'customer-1',
  organizationId: 'org',
  resourceOrganizationId: 'org',
  requiredPermission: 'commerce:stored-credit:apply',
};
const command = (changes = {}) => ({
  requestKey: 'request-1',
  sourceId: 'gift-1',
  expectedSourceRevision: 3,
  claimDigest: digest,
  priceQuoteId: 'quote-1',
  amountMinor: 1200,
  ...changes,
});

function fixture() {
  let source = {
    kind: 'gift_card',
    organizationId: 'org',
    sourceId: 'gift-1',
    revision: 3,
    status: 'active',
    currency: 'USD',
    balanceMinor: 2000,
    claimDigest: digest,
    expiresAt: 2000,
  };
  const quote = {
    organizationId: 'org',
    priceQuoteId: 'quote-1',
    customerSubjectId: 'customer-1',
    providerOrganizationId: 'provider-1',
    currency: 'USD',
    subtotalMinor: 1500,
  };
  const records = new Map();
  const usedQuotes = new Set();
  let sequence = 0;
  const options = {
    store: {
      getSource: async () => source,
      getQuote: async () => quote,
      getApplicationByRequestKey: async (_organizationId, key) => records.get(key) ?? null,
      apply: async (expectedSource, application) => {
        if (
          expectedSource !== source ||
          records.has(application.requestKey) ||
          usedQuotes.has(application.priceQuoteId) ||
          source.balanceMinor < application.appliedMinor
        ) return false;
        source = {
          ...source,
          revision: source.revision + 1,
          balanceMinor: source.balanceMinor - application.appliedMinor,
        };
        records.set(application.requestKey, application);
        usedQuotes.add(application.priceQuoteId);
        return true;
      },
    },
    audit: {
      sink: {append: async () => {}},
      createOpaqueId: () => `audit-${++sequence}`,
      now: () => 1000,
    },
    now: () => 1000,
    createOpaqueId: () => `application-${++sequence}`,
  };
  return {
    options,
    quote,
    source: () => source,
    fail: () => {
      options.store.apply = async () => false;
    },
  };
}

test('atomically applies gift-card value and exactly replays', async () => {
  const f = fixture();
  const input = command();
  const first = await applyStoredCredit(1, auth, state, input, f.options);
  assert.equal(first.accepted, true);
  assert.equal(first.application.remainingSourceBalanceMinor, 800);
  assert.equal(first.application.remainingQuoteSubtotalMinor, 300);
  assert.equal(f.source().balanceMinor, 800);
  const replay = await applyStoredCredit(1, auth, state, input, f.options);
  assert.equal(replay.accepted, true);
  assert.equal(replay.replayed, true);
  assert.equal((await applyStoredCredit(1, auth, state, command({amountMinor: 1100}), f.options)).accepted, false);
});

test('applies only customer-bound loyalty credit without a claim digest', async () => {
  const f = fixture();
  f.options.store.getSource = async () => ({
    kind: 'loyalty_credit',
    organizationId: 'org',
    sourceId: 'gift-1',
    revision: 3,
    status: 'active',
    currency: 'USD',
    balanceMinor: 2000,
    customerSubjectId: 'customer-1',
    expiresAt: null,
  });
  f.options.store.apply = async () => true;
  assert.equal((await applyStoredCredit(
    1,
    auth,
    state,
    command({claimDigest: undefined}),
    f.options,
  )).accepted, true);
  const wrong = fixture();
  wrong.options.store.getSource = async () => ({
    kind: 'loyalty_credit',
    organizationId: 'org',
    sourceId: 'gift-1',
    revision: 3,
    status: 'active',
    currency: 'USD',
    balanceMinor: 2000,
    customerSubjectId: 'other',
    expiresAt: null,
  });
  assert.equal((await applyStoredCredit(
    1,
    auth,
    state,
    command({claimDigest: undefined}),
    wrong.options,
  )).accepted, false);
});

test('rejects overdraft, expired, stale, quote, and cross-tenant records', async () => {
  assert.equal((await applyStoredCredit(
    1,
    auth,
    state,
    command({amountMinor: 2001}),
    fixture().options,
  )).accepted, false);
  const expired = fixture();
  expired.options.now = () => 2000;
  assert.equal((await applyStoredCredit(1, auth, state, command(), expired.options)).accepted, false);
  assert.equal((await applyStoredCredit(
    1,
    auth,
    state,
    command({expectedSourceRevision: 2}),
    fixture().options,
  )).accepted, false);
  const customer = fixture();
  customer.options.store.getQuote = async () => ({...customer.quote, customerSubjectId: 'other'});
  assert.equal((await applyStoredCredit(1, auth, state, command(), customer.options)).accepted, false);
  const tenant = fixture();
  tenant.options.store.getSource = async () => ({...tenant.source(), organizationId: 'other'});
  assert.equal((await applyStoredCredit(1, auth, state, command(), tenant.options)).accepted, false);
});

test('fails closed on authorization, audit, and atomic persistence failures', async () => {
  assert.equal((await applyStoredCredit(
    1,
    {...auth, resourceOrganizationId: 'other'},
    state,
    command(),
    fixture().options,
  )).accepted, false);
  const audit = fixture();
  audit.options.audit.sink.append = async () => { throw Error('down'); };
  assert.equal((await applyStoredCredit(1, auth, state, command(), audit.options)).accepted, false);
  const store = fixture();
  store.fail();
  assert.equal((await applyStoredCredit(1, auth, state, command(), store.options)).accepted, false);
  assert.equal(store.source().balanceMinor, 2000);
});
