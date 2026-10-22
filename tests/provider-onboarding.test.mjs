import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProviderOnboarding,
  decideProviderOnboarding,
  getProviderOnboarding,
  replaceProviderAttestations,
  submitProviderOnboarding,
  withdrawProviderOnboarding,
} from '../packages/contracts/dist/provider-onboarding.js';

const permissions = [
  'provider-onboarding:read', 'provider-onboarding:write', 'provider-onboarding:review',
];
const state = {
  organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [{
    subjectId: 'admin-1', organizationId: 'org-1', status: 'active', roleIds: ['admin'],
  }],
  roles: [{roleId: 'admin', organizationId: 'org-1', permissions}],
};
const auth = requiredPermission => ({
  subjectId: 'admin-1',
  organizationId: 'org-1',
  resourceOrganizationId: 'org-1',
  requiredPermission,
});
const affirmations = [
  {key: 'accurate-information', affirmed: true},
  {key: 'authorized-representative', affirmed: true},
];

function fixture() {
  let sequence = 0;
  let now = 1_000;
  const providers = new Map([['org-1:provider-1', {
    providerOrganizationId: 'provider-1', organizationId: 'org-1',
    legalName: 'Provider One LLC', publicName: 'Provider One', status: 'draft',
    version: 1, createdAt: 900, updatedAt: 900,
  }]]);
  const applications = new Map();
  const applicationKey = value => value.organizationId + ':' + value.providerOnboardingId;
  const options = {
    store: {
      getProvider: async (organizationId, providerOrganizationId) =>
        providers.get(organizationId + ':' + providerOrganizationId) ?? null,
      getApplication: async (organizationId, providerOnboardingId) =>
        applications.get(organizationId + ':' + providerOnboardingId) ?? null,
      createApplication: async value => {
        if (applications.has(applicationKey(value))) return false;
        applications.set(applicationKey(value), value);
        return true;
      },
      replaceApplication: async (current, replacement) => {
        if (applications.get(applicationKey(current)) !== current) return false;
        applications.set(applicationKey(current), replacement);
        return true;
      },
      approveApplication: async (current, replacement, provider, activeProvider) => {
        const providerKey = provider.organizationId + ':' + provider.providerOrganizationId;
        if (applications.get(applicationKey(current)) !== current ||
          providers.get(providerKey) !== provider) return false;
        applications.set(applicationKey(current), replacement);
        providers.set(providerKey, activeProvider);
        return true;
      },
    },
    audit: {
      sink: {append: async () => {}},
      createOpaqueId: () => 'audit-' + (++sequence),
      now: () => now,
    },
    attestationCatalog: new Map([
      ['accurate-information', {
        key: 'accurate-information', statementVersion: 1,
        statement: 'The supplied information is accurate.', validityMs: 100,
      }],
      ['authorized-representative', {
        key: 'authorized-representative', statementVersion: 2,
        statement: 'I am authorized to represent this provider.',
      }],
    ]),
    createOpaqueId: () => 'onboarding-' + (++sequence),
    now: () => now,
  };
  return {
    applications, providers, options,
    setNow: value => { now = value; },
  };
}

async function create(value, version = 1, authorization = auth('provider-onboarding:write'), input = affirmations) {
  return createProviderOnboarding(
    version, authorization, state, 'provider-1', input, value.options,
  );
}

async function submit(value, id, version) {
  return submitProviderOnboarding(
    auth('provider-onboarding:write'), state, id, version, value.options,
  );
}

test('captures immutable attestation snapshots and atomically activates an approved provider', async () => {
  const value = fixture();
  const created = await create(value);
  assert.equal(created.accepted, true);
  assert.equal(created.value.status, 'draft');
  assert.equal(Object.isFrozen(created.value.attestations), true);
  assert.deepEqual(created.value.attestations.map(item => item.statementVersion), [1, 2]);

  value.setNow(1_001);
  const submitted = await submit(value, created.value.providerOnboardingId, 1);
  assert.equal(submitted.accepted, true);
  assert.equal(submitted.value.status, 'submitted');

  value.setNow(1_002);
  const approved = await decideProviderOnboarding(
    auth('provider-onboarding:review'), state, created.value.providerOnboardingId,
    2, 'approved', 'Identity and authority verified.', value.options,
  );
  assert.equal(approved.accepted, true);
  assert.equal(approved.value.reviewedBySubjectId, 'admin-1');
  assert.equal(value.providers.get('org-1:provider-1').status, 'active');
  assert.equal(value.providers.get('org-1:provider-1').version, 2);
});

test('requires the exact contract, tenant, permission and complete affirmative catalog', async () => {
  for (const [version, authorization, input] of [
    [2, auth('provider-onboarding:write'), affirmations],
    [1, auth('provider-onboarding:read'), affirmations],
    [1, {...auth('provider-onboarding:write'), resourceOrganizationId: 'org-2'}, affirmations],
    [1, auth('provider-onboarding:write'), affirmations.slice(0, 1)],
    [1, auth('provider-onboarding:write'), affirmations.map((item, index) =>
      index === 0 ? {...item, affirmed: false} : item)],
    [1, auth('provider-onboarding:write'), [...affirmations, {key: 'extra', affirmed: true}]],
  ]) {
    assert.deepEqual(await create(fixture(), version, authorization, input), {
      accepted: false, code: 'provider_onboarding_rejected',
    });
  }
});

test('allows only draft re-attestation and rejects stale optimistic versions', async () => {
  const value = fixture();
  const created = await create(value);
  value.setNow(1_010);
  const replaced = await replaceProviderAttestations(
    auth('provider-onboarding:write'), state, created.value.providerOnboardingId,
    1, affirmations, value.options,
  );
  assert.equal(replaced.accepted, true);
  assert.equal(replaced.value.version, 2);
  assert.equal(replaced.value.attestations[0].affirmedAt, 1_010);
  assert.deepEqual(await replaceProviderAttestations(
    auth('provider-onboarding:write'), state, created.value.providerOnboardingId,
    1, affirmations, value.options,
  ), {accepted: false, code: 'provider_onboarding_rejected'});

  value.setNow(1_011);
  assert.equal((await submit(value, created.value.providerOnboardingId, 2)).accepted, true);
  assert.deepEqual(await replaceProviderAttestations(
    auth('provider-onboarding:write'), state, created.value.providerOnboardingId,
    3, affirmations, value.options,
  ), {accepted: false, code: 'provider_onboarding_rejected'});
});

test('blocks changed or expired statements at submission and review', async () => {
  const changed = fixture();
  const created = await create(changed);
  changed.options.attestationCatalog.set('accurate-information', {
    key: 'accurate-information', statementVersion: 2,
    statement: 'The supplied information remains accurate.', validityMs: 100,
  });
  assert.deepEqual(await submit(changed, created.value.providerOnboardingId, 1), {
    accepted: false, code: 'provider_onboarding_rejected',
  });

  const expired = fixture();
  const second = await create(expired);
  expired.setNow(1_001);
  assert.equal((await submit(expired, second.value.providerOnboardingId, 1)).accepted, true);
  expired.setNow(1_100);
  assert.deepEqual(await decideProviderOnboarding(
    auth('provider-onboarding:review'), state, second.value.providerOnboardingId,
    2, 'approved', 'Approved.', expired.options,
  ), {accepted: false, code: 'provider_onboarding_rejected'});
  assert.equal(expired.providers.get('org-1:provider-1').status, 'draft');
});

test('supports reviewed rejection and applicant withdrawal as terminal transitions', async () => {
  const rejected = fixture();
  const created = await create(rejected);
  rejected.setNow(1_001);
  await submit(rejected, created.value.providerOnboardingId, 1);
  rejected.setNow(1_002);
  const decision = await decideProviderOnboarding(
    auth('provider-onboarding:review'), state, created.value.providerOnboardingId,
    2, 'rejected', 'Required verification did not match.', rejected.options,
  );
  assert.equal(decision.accepted, true);
  assert.equal(decision.value.status, 'rejected');
  assert.equal(rejected.providers.get('org-1:provider-1').status, 'draft');
  assert.deepEqual(await decideProviderOnboarding(
    auth('provider-onboarding:review'), state, created.value.providerOnboardingId,
    3, 'approved', 'Retry.', rejected.options,
  ), {accepted: false, code: 'provider_onboarding_rejected'});

  const withdrawn = fixture();
  const second = await create(withdrawn);
  withdrawn.setNow(1_001);
  await submit(withdrawn, second.value.providerOnboardingId, 1);
  withdrawn.setNow(1_002);
  const result = await withdrawProviderOnboarding(
    auth('provider-onboarding:write'), state, second.value.providerOnboardingId,
    2, withdrawn.options,
  );
  assert.equal(result.accepted, true);
  assert.equal(result.value.status, 'withdrawn');
});

test('rejects adapter contamination and persistence or audit failure uniformly', async () => {
  const contaminated = fixture();
  const created = await create(contaminated);
  contaminated.applications.set('org-1:' + created.value.providerOnboardingId, {
    ...created.value, organizationId: 'org-2',
  });
  assert.deepEqual(await getProviderOnboarding(
    auth('provider-onboarding:read'), state, created.value.providerOnboardingId,
    contaminated.options,
  ), {accepted: false, code: 'provider_onboarding_rejected'});

  const unavailable = fixture();
  unavailable.options.store.createApplication = async () => { throw new Error('unavailable'); };
  assert.deepEqual(await create(unavailable), {
    accepted: false, code: 'provider_onboarding_rejected',
  });

  const unaudited = fixture();
  unaudited.options.audit.sink.append = async () => { throw new Error('audit unavailable'); };
  assert.deepEqual(await create(unaudited), {
    accepted: false, code: 'provider_onboarding_rejected',
  });
});
