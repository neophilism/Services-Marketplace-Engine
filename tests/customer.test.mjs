import test from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveCustomerAsset,
  createCustomerProfile,
  listCustomerAssets,
  saveCustomerAsset,
  updateCustomerProfile,
} from '../packages/contracts/dist/customer.js';

const state = {
  organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [{subjectId: 'operator-1', organizationId: 'org-1', status: 'active', roleIds: ['agent']}],
  roles: [{
    roleId: 'agent', organizationId: 'org-1',
    permissions: ['customer-profile:write', 'saved-asset:write', 'saved-asset:read'],
  }],
};
const auth = requiredPermission => ({
  subjectId: 'operator-1', organizationId: 'org-1', resourceOrganizationId: 'org-1',
  requiredPermission,
});
const profileInput = {
  customerSubjectId: 'customer-1', displayName: 'Alex Customer', email: 'alex@example.test',
};

function fixture() {
  let sequence = 0;
  let now = 1_000;
  const profiles = new Map();
  const assets = new Map();
  const events = [];
  const store = {
    createProfile: async value => {
      if ([...profiles.values()].some(candidate =>
        candidate.organizationId === value.organizationId &&
        candidate.customerSubjectId === value.customerSubjectId)) return false;
      profiles.set(value.customerProfileId, value);
      return true;
    },
    getProfile: async (organizationId, id) => {
      const value = profiles.get(id);
      return value?.organizationId === organizationId ? value : null;
    },
    replaceProfile: async (current, replacement) => {
      if (profiles.get(current.customerProfileId) !== current) return false;
      profiles.set(current.customerProfileId, replacement);
      return true;
    },
    createSavedAsset: async value => {
      if (assets.has(value.savedAssetId)) return false;
      assets.set(value.savedAssetId, value);
      return true;
    },
    getSavedAsset: async (organizationId, id) => {
      const value = assets.get(id);
      return value?.organizationId === organizationId ? value : null;
    },
    replaceSavedAsset: async (current, replacement) => {
      if (assets.get(current.savedAssetId) !== current) return false;
      assets.set(current.savedAssetId, replacement);
      return true;
    },
    listSavedAssets: async (organizationId, customerProfileId) => [...assets.values()].filter(
      value => value.organizationId === organizationId && value.customerProfileId === customerProfileId,
    ),
  };
  const options = {
    store,
    audit: {
      sink: {append: async event => { events.push(event); }},
      createOpaqueId: () => 'audit-' + (++sequence),
      now: () => now,
    },
    createOpaqueId: () => 'record-' + (++sequence),
    now: () => now,
  };
  return {assets, events, options, profiles, setNow: value => { now = value; }};
}

const createProfile = value => createCustomerProfile(
  1, auth('customer-profile:write'), state, profileInput, value.options,
);

test('creates a tenant-scoped customer profile and rejects duplicate subjects', async () => {
  const value = fixture();
  const created = await createProfile(value);
  assert.equal(created.accepted, true);
  assert.equal(created.value.organizationId, 'org-1');
  assert.equal(created.value.version, 1);
  assert.equal(Object.isFrozen(created.value), true);
  assert.deepEqual(await createProfile(value), {accepted: false, code: 'customer_rejected'});
});

test('invalid versions, fields, permissions and tenants never create a profile', async t => {
  for (const [name, version, authorization, input] of [
    ['contract version', 2, auth('customer-profile:write'), profileInput],
    ['permission', 1, auth('saved-asset:write'), profileInput],
    ['tenant', 1, {...auth('customer-profile:write'), resourceOrganizationId: 'org-2'}, profileInput],
    ['name', 1, auth('customer-profile:write'), {...profileInput, displayName: ' '}],
    ['email', 1, auth('customer-profile:write'), {...profileInput, email: 'not-an-email'}],
  ]) await t.test(name, async () => {
    const value = fixture();
    assert.deepEqual(await createCustomerProfile(version, authorization, state, input, value.options), {
      accepted: false, code: 'customer_rejected',
    });
    assert.equal(value.profiles.size, 0);
  });
});

test('profile updates require the current version and preserve immutable identity', async () => {
  const value = fixture();
  const profile = (await createProfile(value)).value;
  value.setNow(2_000);
  const updated = await updateCustomerProfile(
    auth('customer-profile:write'), state, profile.customerProfileId, 1,
    {...profileInput, displayName: 'Alex Updated'}, value.options,
  );
  assert.equal(updated.accepted, true);
  assert.equal(updated.value.version, 2);
  assert.equal(updated.value.createdAt, profile.createdAt);
  assert.deepEqual(await updateCustomerProfile(
    auth('customer-profile:write'), state, profile.customerProfileId, 1, profileInput, value.options,
  ), {accepted: false, code: 'customer_rejected'});
});

test('saves bounded generic assets only for an active tenant profile', async () => {
  const value = fixture();
  const profile = (await createProfile(value)).value;
  const saved = await saveCustomerAsset(1, auth('saved-asset:write'), state, {
    customerProfileId: profile.customerProfileId, assetType: 'equipment', label: 'Primary unit',
    attributes: {manufacturer: 'Example', model: 'X1'},
  }, value.options);
  assert.equal(saved.accepted, true);
  assert.equal(saved.value.customerProfileId, profile.customerProfileId);
  assert.deepEqual(Object.keys(saved.value.attributes), ['manufacturer', 'model']);
  assert.equal(Object.isFrozen(saved.value.attributes), true);
});

test('asset writes reject missing profiles, unsafe metadata and tenant failures', async () => {
  const value = fixture();
  const profile = (await createProfile(value)).value;
  for (const [authorization, input] of [
    [auth('saved-asset:read'), {customerProfileId: profile.customerProfileId, assetType: 'equipment', label: 'Unit'}],
    [{...auth('saved-asset:write'), resourceOrganizationId: 'org-2'}, {customerProfileId: profile.customerProfileId, assetType: 'equipment', label: 'Unit'}],
    [auth('saved-asset:write'), {customerProfileId: 'missing', assetType: 'equipment', label: 'Unit'}],
    [auth('saved-asset:write'), {customerProfileId: profile.customerProfileId, assetType: 'equipment', label: 'Unit', attributes: {model: ''}}],
  ]) assert.deepEqual(await saveCustomerAsset(1, authorization, state, input, value.options), {
    accepted: false, code: 'customer_rejected',
  });
  assert.equal(value.assets.size, 0);
});

test('listing rejects contaminated adapter results rather than leaking tenants', async () => {
  const value = fixture();
  const profile = (await createProfile(value)).value;
  value.options.store.listSavedAssets = async () => [{
    savedAssetId: 'foreign', organizationId: 'org-2', customerProfileId: profile.customerProfileId,
    assetType: 'equipment', label: 'Foreign', attributes: {}, status: 'active', version: 1,
    createdAt: 1, updatedAt: 1,
  }];
  assert.deepEqual(await listCustomerAssets(
    auth('saved-asset:read'), state, profile.customerProfileId, value.options,
  ), {accepted: false, code: 'customer_rejected'});
});

test('archived assets disappear from active listings and cannot be archived twice', async () => {
  const value = fixture();
  const profile = (await createProfile(value)).value;
  const asset = (await saveCustomerAsset(1, auth('saved-asset:write'), state, {
    customerProfileId: profile.customerProfileId, assetType: 'property', label: 'Site A',
  }, value.options)).value;
  value.setNow(2_000);
  const archived = await archiveCustomerAsset(
    auth('saved-asset:write'), state, asset.savedAssetId, 1, value.options,
  );
  assert.equal(archived.accepted, true);
  assert.equal(archived.value.version, 2);
  assert.deepEqual((await listCustomerAssets(
    auth('saved-asset:read'), state, profile.customerProfileId, value.options,
  )).value, []);
  assert.deepEqual(await archiveCustomerAsset(
    auth('saved-asset:write'), state, asset.savedAssetId, 1, value.options,
  ), {accepted: false, code: 'customer_rejected'});
});

test('auditing failure denies the operation before persistence', async () => {
  const value = fixture();
  value.options.audit.sink.append = async () => { throw Error('unavailable'); };
  assert.deepEqual(await createProfile(value), {accepted: false, code: 'customer_rejected'});
  assert.equal(value.profiles.size, 0);
});
