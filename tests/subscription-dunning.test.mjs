import test from 'node:test';
import assert from 'node:assert/strict';
import {recordSubscriptionFailure} from '../packages/contracts/dist/subscription-dunning.js';

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
    permissions: ['commerce:subscriptions:dunning'],
  }],
};
const auth = {
  subjectId: 'customer-1',
  organizationId: 'org',
  resourceOrganizationId: 'org',
  requiredPermission: 'commerce:subscriptions:dunning',
};
const command = (changes = {}) => ({
  requestKey: 'request-1',
  subscriptionId: 'subscription-1',
  expectedSubscriptionRevision: 4,
  policyId: 'policy-1',
  expectedPolicyRevision: 2,
  expectedCaseRevision: 0,
  failureId: 'failure-1',
  ...changes,
});

function fixture() {
  const subscription = {
    organizationId: 'org',
    subscriptionId: 'subscription-1',
    revision: 4,
    customerSubjectId: 'customer-1',
    status: 'active',
    currency: 'USD',
    billingAmountMinor: 2500,
    scheduledChargeAt: 900,
  };
  const policy = {
    organizationId: 'org',
    policyId: 'policy-1',
    revision: 2,
    status: 'active',
    retryDelaysMs: [100, 300],
    gracePeriodMs: 500,
  };
  let failure = {
    organizationId: 'org',
    failureId: 'failure-1',
    subscriptionId: 'subscription-1',
    subscriptionRevision: 4,
    customerSubjectId: 'customer-1',
    provider: 'processor-1',
    providerEventReference: 'event-1',
    currency: 'USD',
    amountMinor: 2500,
    scheduledChargeAt: 900,
    failedAt: 1000,
    verified: true,
  };
  let currentCase = null;
  const requests = new Map();
  const failures = new Set();
  let sequence = 0;
  const options = {
    store: {
      getSubscription: async () => subscription,
      getPolicy: async () => policy,
      getFailure: async () => failure,
      getCase: async () => currentCase,
      getCaseByRequestKey: async (_organizationId, key) => requests.get(key) ?? null,
      recordFailure: async (_subscription, _policy, expectedCase, event, nextCase) => {
        if (
          expectedCase !== currentCase ||
          failures.has(event.providerEventReference) ||
          requests.has(nextCase.requestKey)
        ) return false;
        currentCase = nextCase;
        requests.set(nextCase.requestKey, nextCase);
        failures.add(event.providerEventReference);
        return true;
      },
    },
    audit: {
      sink: {append: async () => {}},
      createOpaqueId: () => `audit-${++sequence}`,
      now: () => 1200,
    },
    now: () => 1200,
    createOpaqueId: () => `dunning-${++sequence}`,
  };
  return {
    options,
    policy,
    subscription,
    current: () => currentCase,
    setFailure: value => { failure = value; },
    failure: () => failure,
    fail: () => { options.store.recordFailure = async () => false; },
  };
}

test('records a retry schedule atomically and exactly replays', async () => {
  const f = fixture();
  const input = command();
  const first = await recordSubscriptionFailure(1, auth, state, input, f.options);
  assert.equal(first.accepted, true);
  assert.equal(first.dunningCase.failureNumber, 1);
  assert.equal(first.dunningCase.nextRetryAt, 1100);
  assert.equal(first.dunningCase.graceEndsAt, 1500);
  const replay = await recordSubscriptionFailure(1, auth, state, input, f.options);
  assert.equal(replay.accepted, true);
  assert.equal(replay.replayed, true);
  assert.equal((await recordSubscriptionFailure(
    1,
    auth,
    state,
    command({failureId: 'changed'}),
    f.options,
  )).accepted, false);
});

test('advances a revision-fenced case and exhausts retries at the grace boundary', async () => {
  const f = fixture();
  assert.equal((await recordSubscriptionFailure(1, auth, state, command(), f.options)).accepted, true);
  f.setFailure({
    ...f.failure(),
    failureId: 'failure-2',
    providerEventReference: 'event-2',
    failedAt: 1300,
  });
  f.options.now = () => 1400;
  const second = await recordSubscriptionFailure(
    1,
    auth,
    state,
    command({
      requestKey: 'request-2',
      expectedCaseRevision: 1,
      failureId: 'failure-2',
    }),
    f.options,
  );
  assert.equal(second.accepted, true);
  assert.equal(second.dunningCase.caseRevision, 2);
  assert.equal(second.dunningCase.status, 'exhausted');
  assert.equal(second.dunningCase.nextRetryAt, null);
});

test('rejects unverified, mismatched, stale, and cross-tenant evidence', async () => {
  const unverified = fixture();
  unverified.setFailure({...unverified.failure(), verified: false});
  assert.equal((await recordSubscriptionFailure(1, auth, state, command(), unverified.options)).accepted, false);
  const amount = fixture();
  amount.setFailure({...amount.failure(), amountMinor: 2400});
  assert.equal((await recordSubscriptionFailure(1, auth, state, command(), amount.options)).accepted, false);
  assert.equal((await recordSubscriptionFailure(
    1,
    auth,
    state,
    command({expectedPolicyRevision: 1}),
    fixture().options,
  )).accepted, false);
  const tenant = fixture();
  tenant.options.store.getFailure = async () => ({...tenant.failure(), organizationId: 'other'});
  assert.equal((await recordSubscriptionFailure(1, auth, state, command(), tenant.options)).accepted, false);
});

test('fails closed on authorization, audit, and atomic persistence failures', async () => {
  assert.equal((await recordSubscriptionFailure(
    1,
    {...auth, resourceOrganizationId: 'other'},
    state,
    command(),
    fixture().options,
  )).accepted, false);
  const audit = fixture();
  audit.options.audit.sink.append = async () => { throw Error('down'); };
  assert.equal((await recordSubscriptionFailure(1, auth, state, command(), audit.options)).accepted, false);
  const store = fixture();
  store.fail();
  assert.equal((await recordSubscriptionFailure(1, auth, state, command(), store.options)).accepted, false);
  assert.equal(store.current(), null);
});
