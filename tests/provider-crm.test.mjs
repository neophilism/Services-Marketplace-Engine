import test from 'node:test';
import assert from 'node:assert/strict';
import {upsertProviderCrmRecord} from '../packages/contracts/dist/provider-crm.js';

const state = {
  organizations: [{organizationId: 'market', status: 'active'}],
  memberships: [{subjectId: 'operator', organizationId: 'market', status: 'active', roleIds: ['crm']}],
  roles: [{roleId: 'crm', organizationId: 'market', permissions: ['provider-crm:write']}],
};
const auth = {
  subjectId: 'operator', organizationId: 'market', resourceOrganizationId: 'market',
  requiredPermission: 'provider-crm:write',
};
const input = {
  requestKey: 'crm-request-1', providerOrganizationId: 'provider-1',
  customerProfileId: 'customer-1', expectedVersion: 0, stage: 'lead',
  assignedSubjectId: 'assignee', tags: ['priority', 'residential'],
};

function fixture() {
  let current = null;
  const mutations = new Map();
  let sequence = 0;
  const customer = {organizationId: 'market', customerProfileId: 'customer-1', status: 'active'};
  const provider = {organizationId: 'market', providerOrganizationId: 'provider-1', status: 'active'};
  const operator = subjectId => ({
    organizationId: 'market', providerOrganizationId: 'provider-1', subjectId,
    status: 'active', permissions: subjectId === 'operator' ? ['provider-crm:write'] : [],
  });
  const options = {
    store: {
      getCustomer: async () => customer,
      getProvider: async () => provider,
      getOperator: async (_organizationId, _providerOrganizationId, subjectId) => operator(subjectId),
      getRecord: async () => current,
      getMutationByRequestKey: async (_organizationId, key) => mutations.get(key) ?? null,
      commitMutation: async (expected, mutation) => {
        if (expected !== current || mutations.has(mutation.activity.requestKey)) return false;
        current = mutation.record;
        mutations.set(mutation.activity.requestKey, mutation);
        return true;
      },
    },
    audit: {sink: {append: async () => {}}, createOpaqueId: () => `audit-${++sequence}`, now: () => 1000},
    createOpaqueId: () => `crm-${++sequence}`,
    now: () => 1000,
  };
  return {options, customer, provider, current: () => current};
}

test('creates, exactly replays, and optimistically updates an immutable CRM record', async () => {
  const f = fixture();
  const created = await upsertProviderCrmRecord(1, auth, state, input, f.options);
  assert.equal(created.accepted, true);
  assert.equal(created.replayed, false);
  assert.equal(created.value.record.version, 1);
  assert.deepEqual(created.value.record.tags, ['priority', 'residential']);
  assert.equal(Object.isFrozen(created.value.record), true);
  assert.equal(Object.isFrozen(created.value.activity), true);

  const replay = await upsertProviderCrmRecord(1, auth, state,
    {...input, tags: ['residential', 'priority']}, f.options);
  assert.equal(replay.accepted, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.value.activity.activityId, created.value.activity.activityId);

  const updated = await upsertProviderCrmRecord(1, auth, state, {
    ...input, requestKey: 'crm-request-2', expectedVersion: 1,
    stage: 'qualified', assignedSubjectId: null, tags: ['qualified'],
  }, f.options);
  assert.equal(updated.accepted, true);
  assert.equal(updated.value.record.version, 2);
  assert.equal(updated.value.record.crmRecordId, created.value.record.crmRecordId);
});

test('rejects stale writes, request-key contamination, and duplicate tags', async () => {
  const f = fixture();
  assert.equal((await upsertProviderCrmRecord(1, auth, state, input, f.options)).accepted, true);
  assert.equal((await upsertProviderCrmRecord(1, auth, state,
    {...input, requestKey: 'stale', stage: 'customer'}, f.options)).accepted, false);
  assert.equal((await upsertProviderCrmRecord(1, auth, state,
    {...input, stage: 'qualified'}, f.options)).accepted, false);
  assert.equal((await upsertProviderCrmRecord(1, auth, state, {
    ...input, requestKey: 'duplicate', expectedVersion: 1, tags: ['priority', 'priority'],
  }, f.options)).accepted, false);
});

test('rejects cross-tenant, inactive, and provider-operator contamination', async () => {
  const tenant = fixture();
  tenant.options.store.getCustomer = async () => ({...tenant.customer, organizationId: 'other'});
  assert.equal((await upsertProviderCrmRecord(1, auth, state, input, tenant.options)).accepted, false);

  const provider = fixture();
  provider.provider.status = 'suspended';
  assert.equal((await upsertProviderCrmRecord(1, auth, state, input, provider.options)).accepted, false);

  const operator = fixture();
  operator.options.store.getOperator = async (_organizationId, providerOrganizationId, subjectId) => ({
    organizationId: 'market', providerOrganizationId: providerOrganizationId === 'provider-1'
      ? 'provider-2' : providerOrganizationId, subjectId, status: 'active',
    permissions: ['provider-crm:write'],
  });
  assert.equal((await upsertProviderCrmRecord(1, auth, state, input, operator.options)).accepted, false);
});

test('fails closed on authorization, audit, identifiers, and atomic persistence failures', async () => {
  assert.equal((await upsertProviderCrmRecord(1,
    {...auth, resourceOrganizationId: 'other'}, state, input, fixture().options)).accepted, false);

  const audit = fixture();
  audit.options.audit.sink.append = async () => { throw Error('down'); };
  assert.equal((await upsertProviderCrmRecord(1, auth, state, input, audit.options)).accepted, false);

  assert.equal((await upsertProviderCrmRecord(1, auth, state,
    {...input, requestKey: 'bad key'}, fixture().options)).accepted, false);

  const ids = fixture();
  ids.options.createOpaqueId = () => 'same';
  assert.equal((await upsertProviderCrmRecord(1, auth, state, input, ids.options)).accepted, false);

  const persistence = fixture();
  persistence.options.store.commitMutation = async () => false;
  assert.equal((await upsertProviderCrmRecord(1, auth, state, input, persistence.options)).accepted, false);
  assert.equal(persistence.current(), null);
});
