import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createServiceTerritory,
  listServiceTerritories,
  quoteTerritoryTravel,
  updateServiceTerritory,
} from '../packages/contracts/dist/territory.js';

const permissions = ['territory:read', 'territory:write'];
const state = {
  organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [{subjectId: 'operator-1', organizationId: 'org-1', status: 'active', roleIds: ['admin']}],
  roles: [{roleId: 'admin', organizationId: 'org-1', permissions}],
};
const auth = requiredPermission => ({subjectId: 'operator-1', organizationId: 'org-1',
  resourceOrganizationId: 'org-1', requiredPermission});
const input = {
  providerOrganizationId: 'provider-1', providerLocationId: 'location-1', name: 'Metro area',
  centerLatitudeE6: 40_712_800, centerLongitudeE6: -74_006_000, radiusMeters: 50_000,
  travelRules: {maximumDistanceMeters: 25_000, minimumNoticeMinutes: 120,
    baseFeeMinor: 2_000, perKilometerFeeMinor: 150, currency: 'USD'},
};

function fixture() {
  let sequence = 0;
  let now = 1_000;
  const provider = {providerOrganizationId: 'provider-1', organizationId: 'org-1', status: 'active'};
  const location = {providerLocationId: 'location-1', organizationId: 'org-1',
    providerOrganizationId: 'provider-1', serviceModes: ['mobile'], status: 'active'};
  const territories = new Map();
  const options = {
    store: {
      getProvider: async () => provider,
      getLocation: async () => location,
      getTerritory: async (organizationId, id) => territories.get(organizationId + ':' + id) ?? null,
      listTerritories: async (organizationId, providerOrganizationId) => [...territories.values()]
        .filter(value => value.organizationId === organizationId &&
          value.providerOrganizationId === providerOrganizationId),
      createTerritory: async value => {
        const key = value.organizationId + ':' + value.serviceTerritoryId;
        if (territories.has(key)) return false;
        territories.set(key, value);
        return true;
      },
      replaceTerritory: async (current, replacement) => {
        const key = current.organizationId + ':' + current.serviceTerritoryId;
        if (territories.get(key) !== current) return false;
        territories.set(key, replacement);
        return true;
      },
    },
    audit: {sink: {append: async () => {}}, createOpaqueId: () => 'audit-' + (++sequence), now: () => now},
    createOpaqueId: () => 'territory-' + (++sequence),
    now: () => now,
  };
  return {location, options, provider, territories, setNow: value => { now = value; }};
}

const create = (value, changedInput = input, version = 1,
  authorization = auth('territory:write')) => createServiceTerritory(
  version, authorization, state, changedInput, value.options,
);

test('creates an immutable territory for an active mobile location', async () => {
  const value = fixture();
  const result = await create(value);
  assert.equal(result.accepted, true);
  assert.equal(result.value.status, 'active');
  assert.equal(Object.isFrozen(result.value.travelRules), true);
});

test('rejects malformed, unauthorized and non-mobile territory creation', async () => {
  for (const [changedInput, version, authorization] of [
    [input, 2, auth('territory:write')],
    [input, 1, auth('territory:read')],
    [{...input, centerLatitudeE6: 90_000_001}, 1, auth('territory:write')],
    [{...input, travelRules: {...input.travelRules, maximumDistanceMeters: 60_000}}, 1,
      auth('territory:write')],
  ]) assert.deepEqual(await create(fixture(), changedInput, version, authorization), {
    accepted: false, code: 'territory_rejected',
  });
  const noMobile = fixture();
  noMobile.location.serviceModes = ['remote'];
  assert.deepEqual(await create(noMobile), {accepted: false, code: 'territory_rejected'});
  const suspended = fixture();
  suspended.provider.status = 'suspended';
  assert.deepEqual(await create(suspended), {accepted: false, code: 'territory_rejected'});
});

test('quotes deterministic eligible fees and withholds fees outside the travel limit', async () => {
  const value = fixture();
  const created = await create(value);
  const local = await quoteTerritoryTravel(auth('territory:read'), state,
    created.value.serviceTerritoryId, 40_712_800, -74_006_000, value.options);
  assert.deepEqual(local.value, {eligible: true, distanceMeters: 0, feeMinor: 2_000,
    currency: 'USD', minimumNoticeMinutes: 120});
  const outside = await quoteTerritoryTravel(auth('territory:read'), state,
    created.value.serviceTerritoryId, 41_000_000, -74_006_000, value.options);
  assert.equal(outside.value.eligible, false);
  assert.equal(outside.value.feeMinor, null);
});

test('updates with optimistic concurrency and revalidates active parents', async () => {
  const value = fixture();
  const created = await create(value);
  value.setNow(2_000);
  const updated = await updateServiceTerritory(auth('territory:write'), state,
    created.value.serviceTerritoryId, 1, {...input, name: 'Updated metro'}, 'active', value.options);
  assert.equal(updated.value.version, 2);
  assert.deepEqual(await updateServiceTerritory(auth('territory:write'), state,
    created.value.serviceTerritoryId, 1, input, 'inactive', value.options), {
    accepted: false, code: 'territory_rejected',
  });
  assert.deepEqual(await updateServiceTerritory(auth('territory:write'), state,
    created.value.serviceTerritoryId, 2, {...input, providerLocationId: 'location-2'},
    'inactive', value.options), {accepted: false, code: 'territory_rejected'});
  value.location.status = 'inactive';
  value.setNow(3_000);
  assert.deepEqual(await updateServiceTerritory(auth('territory:write'), state,
    created.value.serviceTerritoryId, 2, input, 'active', value.options), {
    accepted: false, code: 'territory_rejected',
  });
});

test('lists suspended-provider evidence and rejects duplicate or contaminated records', async () => {
  const value = fixture();
  const created = await create(value);
  value.provider.status = 'suspended';
  assert.equal((await listServiceTerritories(auth('territory:read'), state,
    'provider-1', value.options)).accepted, true);
  assert.deepEqual(await quoteTerritoryTravel(auth('territory:read'), state,
    created.value.serviceTerritoryId, input.centerLatitudeE6, input.centerLongitudeE6, value.options), {
    accepted: false, code: 'territory_rejected',
  });
  value.provider.status = 'active';
  value.options.store.listTerritories = async () => [created.value, created.value];
  assert.deepEqual(await listServiceTerritories(auth('territory:read'), state,
    'provider-1', value.options), {accepted: false, code: 'territory_rejected'});
  const key = 'org-1:' + created.value.serviceTerritoryId;
  value.territories.set(key, {...created.value, organizationId: 'org-2'});
  assert.deepEqual(await quoteTerritoryTravel(auth('territory:read'), state,
    created.value.serviceTerritoryId, input.centerLatitudeE6, input.centerLongitudeE6, value.options), {
    accepted: false, code: 'territory_rejected',
  });
});

test('fails closed on audit and persistence errors', async () => {
  const audit = fixture();
  audit.options.audit.sink.append = async () => { throw new Error('unavailable'); };
  assert.deepEqual(await create(audit), {accepted: false, code: 'territory_rejected'});
  const persistence = fixture();
  persistence.options.store.createTerritory = async () => { throw new Error('unavailable'); };
  assert.deepEqual(await create(persistence), {accepted: false, code: 'territory_rejected'});
});
