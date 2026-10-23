import test from 'node:test';
import assert from 'node:assert/strict';
import {createRepeatRequest, saveProvider} from '../packages/contracts/dist/saved-provider.js';

const state = {
  organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [{subjectId: 'customer-1', organizationId: 'org-1', status: 'active',
    roleIds: ['customer-role']}],
  roles: [{roleId: 'customer-role', organizationId: 'org-1',
    permissions: ['saved-providers:write', 'repeat-requests:create']}],
};
const auth = permission => ({subjectId: 'customer-1', organizationId: 'org-1',
  resourceOrganizationId: 'org-1', requiredPermission: permission});
const saveInput = {requestKey: 'save-1', customerProfileId: 'customer-profile-1',
  providerOrganizationId: 'provider-1'};
const repeatInput = {requestKey: 'repeat-1', savedProviderId: 'saved-1',
  sourceEngagementId: 'engagement-1', summary: 'Repeat the completed service.',
  requestedStartAt: 2_000_000, requestedEndAt: 2_100_000};

function fixture() {
  let sequence = 0;
  let savedReplay = null;
  let duplicate = null;
  let repeatReplay = null;
  let committed = null;
  const saved = {savedProviderId: 'saved-1', organizationId: 'org-1',
    requestKey: 'save-existing', customerProfileId: 'customer-profile-1',
    customerSubjectId: 'customer-1', providerOrganizationId: 'provider-1', createdAt: 900_000};
  const options = {
    store: {
      getCustomer: async () => ({organizationId: 'org-1',
        customerProfileId: 'customer-profile-1', customerSubjectId: 'customer-1',
        status: 'active'}),
      getProvider: async () => ({organizationId: 'org-1',
        providerOrganizationId: 'provider-1', status: 'active'}),
      getSavedProvider: async () => saved,
      getSavedProviderByRequestKey: async () => savedReplay,
      getSavedProviderByCustomerAndProvider: async () => duplicate,
      createSavedProvider: async value => { committed = value; return true; },
      getCompletedEngagement: async () => ({organizationId: 'org-1',
        engagementId: 'engagement-1', customerProfileId: 'customer-profile-1',
        customerSubjectId: 'customer-1', providerOrganizationId: 'provider-1',
        serviceKey: 'engine-repair', status: 'completed', completedAt: 800_000}),
      getPublishedService: async () => ({organizationId: 'org-1',
        providerOrganizationId: 'provider-1', serviceKey: 'engine-repair', revision: 3,
        status: 'published'}),
      getRepeatRequestByRequestKey: async () => repeatReplay,
      createRepeatRequest: async value => { committed = value; return true; },
    },
    audit: {sink: {append: async () => {}}, createOpaqueId: () => 'audit-' + (++sequence),
      now: () => 1_000_000},
    createOpaqueId: () => 'opaque-' + (++sequence),
    now: () => 1_000_000,
  };
  return {options, saved, committed: () => committed,
    setSavedReplay: value => { savedReplay = value; },
    setDuplicate: value => { duplicate = value; },
    setRepeatReplay: value => { repeatReplay = value; }};
}

test('saves one active provider for the authenticated customer and replays exactly', async () => {
  const value = fixture();
  const created = await saveProvider(1, auth('saved-providers:write'), state,
    saveInput, value.options);
  assert.equal(created.accepted, true);
  assert.equal(created.replayed, false);
  assert.equal(created.value.customerSubjectId, 'customer-1');
  assert.equal(Object.isFrozen(created.value), true);
  assert.equal(value.committed(), created.value);
  value.setSavedReplay(created.value);
  const replay = await saveProvider(1, auth('saved-providers:write'), state,
    saveInput, value.options);
  assert.equal(replay.accepted, true);
  assert.equal(replay.replayed, true);
});

test('rejects unauthorized, inactive, duplicate, conflicting, and contaminated saves', async () => {
  assert.deepEqual(await saveProvider(1, auth('repeat-requests:create'), state,
    saveInput, fixture().options), {accepted: false, code: 'saved_provider_rejected'});
  const inactive = fixture();
  inactive.options.store.getProvider = async () => ({organizationId: 'org-1',
    providerOrganizationId: 'provider-1', status: 'suspended'});
  assert.deepEqual(await saveProvider(1, auth('saved-providers:write'), state,
    saveInput, inactive.options), {accepted: false, code: 'saved_provider_rejected'});
  const duplicate = fixture(); duplicate.setDuplicate(duplicate.saved);
  assert.deepEqual(await saveProvider(1, auth('saved-providers:write'), state,
    saveInput, duplicate.options), {accepted: false, code: 'saved_provider_rejected'});
  const conflict = fixture(); conflict.setSavedReplay({...conflict.saved, requestKey: 'save-1',
    providerOrganizationId: 'provider-2'});
  assert.deepEqual(await saveProvider(1, auth('saved-providers:write'), state,
    saveInput, conflict.options), {accepted: false, code: 'saved_provider_rejected'});
  const contaminated = fixture();
  contaminated.options.store.getCustomer = async () => ({organizationId: 'org-2',
    customerProfileId: 'customer-profile-1', customerSubjectId: 'customer-1', status: 'active'});
  assert.deepEqual(await saveProvider(1, auth('saved-providers:write'), state,
    saveInput, contaminated.options), {accepted: false, code: 'saved_provider_rejected'});
});

test('creates a draft repeat request from a matching completed engagement', async () => {
  const value = fixture();
  const created = await createRepeatRequest(1, auth('repeat-requests:create'), state,
    repeatInput, value.options);
  assert.equal(created.accepted, true);
  assert.equal(created.replayed, false);
  assert.equal(created.value.serviceRevision, 3);
  assert.equal(created.value.status, 'draft');
  assert.equal(value.committed(), created.value);
  value.setRepeatReplay(created.value);
  const replay = await createRepeatRequest(1, auth('repeat-requests:create'), state,
    repeatInput, value.options);
  assert.equal(replay.accepted, true);
  assert.equal(replay.replayed, true);
});

test('rejects identity confusion, mismatched history, retired service, conflicts, and bad windows', async () => {
  const identity = fixture();
  identity.options.store.getSavedProvider = async () => ({...identity.saved,
    customerSubjectId: 'customer-2'});
  assert.deepEqual(await createRepeatRequest(1, auth('repeat-requests:create'), state,
    repeatInput, identity.options), {accepted: false, code: 'saved_provider_rejected'});
  const mismatch = fixture();
  mismatch.options.store.getCompletedEngagement = async () => ({organizationId: 'org-1',
    engagementId: 'engagement-1', customerProfileId: 'customer-profile-1',
    customerSubjectId: 'customer-1', providerOrganizationId: 'provider-2',
    serviceKey: 'engine-repair', status: 'completed', completedAt: 800_000});
  assert.deepEqual(await createRepeatRequest(1, auth('repeat-requests:create'), state,
    repeatInput, mismatch.options), {accepted: false, code: 'saved_provider_rejected'});
  const retired = fixture();
  retired.options.store.getPublishedService = async () => ({organizationId: 'org-1',
    providerOrganizationId: 'provider-1', serviceKey: 'engine-repair', revision: 3,
    status: 'retired'});
  assert.deepEqual(await createRepeatRequest(1, auth('repeat-requests:create'), state,
    repeatInput, retired.options), {accepted: false, code: 'saved_provider_rejected'});
  const conflict = fixture();
  conflict.setRepeatReplay({repeatRequestId: 'repeat-existing', organizationId: 'org-1',
    requestKey: 'repeat-1', savedProviderId: 'saved-1', sourceEngagementId: 'engagement-1',
    customerProfileId: 'customer-profile-1', customerSubjectId: 'customer-1',
    providerOrganizationId: 'provider-1', serviceKey: 'engine-repair', serviceRevision: 3,
    summary: 'Different work.', requestedStartAt: 2_000_000,
    requestedEndAt: 2_100_000, status: 'draft', createdAt: 1_000_000});
  assert.deepEqual(await createRepeatRequest(1, auth('repeat-requests:create'), state,
    repeatInput, conflict.options), {accepted: false, code: 'saved_provider_rejected'});
  assert.deepEqual(await createRepeatRequest(1, auth('repeat-requests:create'), state,
    {...repeatInput, requestedStartAt: 2_000_000, requestedEndAt: null}, fixture().options),
  {accepted: false, code: 'saved_provider_rejected'});
});

test('fails closed for audit and storage failure', async () => {
  const audit = fixture();
  audit.options.audit.sink.append = async () => { throw new Error('unavailable'); };
  assert.deepEqual(await saveProvider(1, auth('saved-providers:write'), state,
    saveInput, audit.options), {accepted: false, code: 'saved_provider_rejected'});
  const store = fixture(); store.options.store.createRepeatRequest = async () => false;
  assert.deepEqual(await createRepeatRequest(1, auth('repeat-requests:create'), state,
    repeatInput, store.options), {accepted: false, code: 'saved_provider_rejected'});
});
