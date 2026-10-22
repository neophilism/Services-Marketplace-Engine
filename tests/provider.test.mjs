import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProviderLocation,
  createProviderOrganization,
  getProviderOrganization,
  listProviderLocations,
  setProviderLocationStatus,
  updateProviderOrganization,
} from '../packages/contracts/dist/provider.js';

const permissions = ['provider:read', 'provider:write', 'provider-location:read', 'provider-location:write'];
const state = {
  organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [{subjectId: 'operator-1', organizationId: 'org-1', status: 'active', roleIds: ['provider-admin']}],
  roles: [{roleId: 'provider-admin', organizationId: 'org-1', permissions}],
};
const auth = requiredPermission => ({
  subjectId: 'operator-1', organizationId: 'org-1', resourceOrganizationId: 'org-1', requiredPermission,
});
const providerInput = {legalName: 'Example Services Incorporated', publicName: 'Example Services'};
const locationInput = providerOrganizationId => ({
  providerOrganizationId,
  name: 'Downtown office',
  addressLines: ['100 Example Street'],
  locality: 'Example City',
  administrativeArea: 'NY',
  postalCode: '10001',
  countryCode: 'US',
  timeZone: 'America/New_York',
  serviceModes: ['remote', 'on_site', 'remote'],
});

function fixture() {
  let sequence = 0;
  let now = 1_000;
  const providers = new Map();
  const locations = new Map();
  const events = [];
  const store = {
    createProvider: async value => {
      if ([...providers.values()].some(candidate =>
        candidate.organizationId === value.organizationId && candidate.legalName === value.legalName)) return false;
      providers.set(value.providerOrganizationId, value);
      return true;
    },
    getProvider: async (organizationId, id) => {
      const value = providers.get(id);
      return value?.organizationId === organizationId ? value : null;
    },
    replaceProvider: async (current, replacement) => {
      if (providers.get(current.providerOrganizationId) !== current) return false;
      providers.set(current.providerOrganizationId, replacement);
      return true;
    },
    createLocation: async value => {
      if (locations.has(value.providerLocationId)) return false;
      locations.set(value.providerLocationId, value);
      return true;
    },
    getLocation: async (organizationId, id) => {
      const value = locations.get(id);
      return value?.organizationId === organizationId ? value : null;
    },
    replaceLocation: async (current, replacement) => {
      if (locations.get(current.providerLocationId) !== current) return false;
      locations.set(current.providerLocationId, replacement);
      return true;
    },
    listLocations: async (organizationId, providerOrganizationId) => [...locations.values()].filter(
      value => value.organizationId === organizationId && value.providerOrganizationId === providerOrganizationId,
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
  return {events, locations, options, providers, setNow: value => { now = value; }};
}

const createProvider = value => createProviderOrganization(
  1, auth('provider:write'), state, providerInput, value.options,
);

test('creates a draft tenant provider without claiming onboarding', async () => {
  const value = fixture();
  const result = await createProvider(value);
  assert.equal(result.accepted, true);
  assert.equal(result.value.status, 'draft');
  assert.equal(result.value.organizationId, 'org-1');
  assert.equal(Object.isFrozen(result.value), true);
});

test('provider creation rejects contract, field, permission and tenant failures', async t => {
  for (const [name, version, authorization, input] of [
    ['contract', 2, auth('provider:write'), providerInput],
    ['permission', 1, auth('provider:read'), providerInput],
    ['tenant', 1, {...auth('provider:write'), resourceOrganizationId: 'org-2'}, providerInput],
    ['legal name', 1, auth('provider:write'), {...providerInput, legalName: ' '}],
  ]) await t.test(name, async () => {
    const value = fixture();
    assert.deepEqual(await createProviderOrganization(version, authorization, state, input, value.options), {
      accepted: false, code: 'provider_rejected',
    });
    assert.equal(value.providers.size, 0);
  });
});

test('reads and optimistic updates require exact permissions and versions', async () => {
  const value = fixture();
  const provider = (await createProvider(value)).value;
  assert.deepEqual(await getProviderOrganization(
    auth('provider:read'), state, provider.providerOrganizationId, value.options,
  ), {accepted: true, value: provider});
  assert.deepEqual(await getProviderOrganization(
    auth('provider:write'), state, provider.providerOrganizationId, value.options,
  ), {accepted: false, code: 'provider_rejected'});
  value.setNow(2_000);
  const updated = await updateProviderOrganization(
    auth('provider:write'), state, provider.providerOrganizationId, 1,
    {...providerInput, publicName: 'Updated Services'}, value.options,
  );
  assert.equal(updated.accepted, true);
  assert.equal(updated.value.version, 2);
  assert.equal(updated.value.status, 'draft');
  assert.deepEqual(await updateProviderOrganization(
    auth('provider:write'), state, provider.providerOrganizationId, 1, providerInput, value.options,
  ), {accepted: false, code: 'provider_rejected'});
});

test('creates normalized service locations without territory or coordinate claims', async () => {
  const value = fixture();
  const provider = (await createProvider(value)).value;
  const result = await createProviderLocation(
    1, auth('provider-location:write'), state,
    locationInput(provider.providerOrganizationId), value.options,
  );
  assert.equal(result.accepted, true);
  assert.deepEqual(result.value.serviceModes, ['on_site', 'remote']);
  assert.equal(Object.isFrozen(result.value.addressLines), true);
  assert.equal('latitude' in result.value, false);
});

test('location creation rejects missing parents, malformed addresses and wrong authority', async () => {
  const value = fixture();
  const provider = (await createProvider(value)).value;
  for (const [authorization, input] of [
    [auth('provider-location:read'), locationInput(provider.providerOrganizationId)],
    [{...auth('provider-location:write'), resourceOrganizationId: 'org-2'}, locationInput(provider.providerOrganizationId)],
    [auth('provider-location:write'), locationInput('missing')],
    [auth('provider-location:write'), {...locationInput(provider.providerOrganizationId), countryCode: 'usa'}],
    [auth('provider-location:write'), {...locationInput(provider.providerOrganizationId), serviceModes: []}],
  ]) assert.deepEqual(await createProviderLocation(1, authorization, state, input, value.options), {
    accepted: false, code: 'provider_rejected',
  });
  assert.equal(value.locations.size, 0);
});

test('suspended providers cannot receive locations', async () => {
  const value = fixture();
  const provider = (await createProvider(value)).value;
  value.providers.set(provider.providerOrganizationId, {...provider, status: 'suspended'});
  assert.deepEqual(await createProviderLocation(
    1, auth('provider-location:write'), state,
    locationInput(provider.providerOrganizationId), value.options,
  ), {accepted: false, code: 'provider_rejected'});
});

test('location listing rejects cross-tenant contamination', async () => {
  const value = fixture();
  const provider = (await createProvider(value)).value;
  value.options.store.listLocations = async () => [{
    providerLocationId: 'foreign', organizationId: 'org-2',
    providerOrganizationId: provider.providerOrganizationId, name: 'Foreign',
    addressLines: ['Other'], locality: 'Other', administrativeArea: 'Other', postalCode: '1',
    countryCode: 'US', timeZone: 'UTC', serviceModes: ['remote'], status: 'active',
    version: 1, createdAt: 1, updatedAt: 1,
  }];
  assert.deepEqual(await listProviderLocations(
    auth('provider-location:read'), state, provider.providerOrganizationId, value.options,
  ), {accepted: false, code: 'provider_rejected'});
});

test('location status changes use compare-and-swap and preserve identity', async () => {
  const value = fixture();
  const provider = (await createProvider(value)).value;
  const location = (await createProviderLocation(
    1, auth('provider-location:write'), state,
    locationInput(provider.providerOrganizationId), value.options,
  )).value;
  value.setNow(2_000);
  const inactive = await setProviderLocationStatus(
    auth('provider-location:write'), state, location.providerLocationId, 1, 'inactive', value.options,
  );
  assert.equal(inactive.accepted, true);
  assert.equal(inactive.value.version, 2);
  assert.deepEqual(await setProviderLocationStatus(
    auth('provider-location:write'), state, location.providerLocationId, 1, 'active', value.options,
  ), {accepted: false, code: 'provider_rejected'});
});

test('suspension permits location deactivation but blocks reactivation', async () => {
  const value = fixture();
  const provider = (await createProvider(value)).value;
  const location = (await createProviderLocation(
    1, auth('provider-location:write'), state,
    locationInput(provider.providerOrganizationId), value.options,
  )).value;
  value.providers.set(provider.providerOrganizationId, {...provider, status: 'suspended'});
  value.setNow(2_000);
  const inactive = await setProviderLocationStatus(
    auth('provider-location:write'), state, location.providerLocationId, 1, 'inactive', value.options,
  );
  assert.equal(inactive.accepted, true);
  assert.deepEqual(await setProviderLocationStatus(
    auth('provider-location:write'), state, location.providerLocationId, 2, 'active', value.options,
  ), {accepted: false, code: 'provider_rejected'});
});

test('audit persistence failure prevents provider writes', async () => {
  const value = fixture();
  value.options.audit.sink.append = async () => { throw Error('unavailable'); };
  assert.deepEqual(await createProvider(value), {accepted: false, code: 'provider_rejected'});
  assert.equal(value.providers.size, 0);
});
