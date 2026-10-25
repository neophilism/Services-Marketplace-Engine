import test from 'node:test';
import assert from 'node:assert/strict';
import {FEATURE_FLAG_CONTRACT_VERSION, configureFeatureFlag, evaluateFeatureFlag} from '../packages/contracts/dist/feature-flag.js';

const authRequest = {subjectId: 'admin-1', organizationId: 'org-1', resourceOrganizationId: 'org-1', requiredPermission: 'feature-flags:write'};
const authState = {
  organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [{subjectId: 'admin-1', organizationId: 'org-1', status: 'active', roleIds: ['admin']}],
  roles: [{roleId: 'admin', organizationId: 'org-1', permissions: ['feature-flags:write']}],
};
const input = {requestKey: 'request-1', flagKey: 'checkout.new-flow', environment: 'staging', enabled: false, variantKey: 'control', expectedRevision: 0};

function fixture() {
  const data = {current: null, byRequest: new Map(), audits: [], committed: []}; let id = 0;
  const options = {
    now: () => 100, createOpaqueId: () => `config-${++id}`,
    audit: {now: () => 99, createOpaqueId: () => `audit-${++id}`, sink: {append: async event => data.audits.push(event)}},
    store: {
      getOperator: async (organizationId, subjectId) => ({organizationId, subjectId, status: 'active', permissions: ['feature-flags:write']}),
      getCurrent: async () => data.current,
      getByRequestKey: async (_organizationId, requestKey) => data.byRequest.get(requestKey) ?? null,
      commit: async (current, configuration) => {
        if (current !== data.current) return false;
        data.current = configuration; data.byRequest.set(configuration.requestKey, configuration); data.committed.push(configuration); return true;
      },
    },
  };
  return {data, options};
}

test('creates, revises, and deterministically evaluates a tenant flag', async () => {
  const {data, options} = fixture();
  const created = await configureFeatureFlag(1, authRequest, authState, input, options);
  assert.equal(created.accepted, true); assert.equal(created.value.revision, 1); assert.equal(Object.isFrozen(created.value), true);
  const revised = await configureFeatureFlag(1, authRequest, authState, {...input, requestKey: 'request-2', enabled: true, variantKey: 'treatment', expectedRevision: 1}, options);
  assert.equal(revised.accepted, true); assert.equal(revised.value.revision, 2); assert.equal(data.committed.length, 2);
  assert.deepEqual(evaluateFeatureFlag(FEATURE_FLAG_CONTRACT_VERSION, 'org-1', 'checkout.new-flow', 'staging', revised.value), {accepted: true, enabled: true, variantKey: 'treatment', revision: 2});
});

test('accepts only exact request replay and rejects corrupted stored replay', async () => {
  const {data, options} = fixture();
  const created = await configureFeatureFlag(1, authRequest, authState, input, options);
  assert.deepEqual(await configureFeatureFlag(1, authRequest, authState, input, options), {accepted: true, value: created.value, replayed: true});
  assert.deepEqual(await configureFeatureFlag(1, authRequest, authState, {...input, enabled: true}, options), {accepted: false, code: 'feature_flag_rejected'});
  data.byRequest.set(input.requestKey, {...created.value, organizationId: 'org-2'});
  assert.deepEqual(await configureFeatureFlag(1, authRequest, authState, input, options), {accepted: false, code: 'feature_flag_rejected'});
});

test('rejects authorization, tenant, and operator failures', async t => {
  const cases = [
    ['wrong permission', {...authRequest, requiredPermission: 'feature-flags:read'}, authState, null],
    ['cross tenant', {...authRequest, resourceOrganizationId: 'org-2'}, authState, null],
    ['inactive membership', authRequest, {...authState, memberships: [{...authState.memberships[0], status: 'revoked'}]}, null],
    ['inactive operator', authRequest, authState, {status: 'inactive'}],
    ['operator grant absent', authRequest, authState, {permissions: []}],
  ];
  for (const [name, request, state, patch] of cases) await t.test(name, async () => {
    const {options} = fixture(); if (patch) { const original = options.store.getOperator; options.store.getOperator = async (...args) => ({...await original(...args), ...patch}); }
    assert.deepEqual(await configureFeatureFlag(1, request, state, input, options), {accepted: false, code: 'feature_flag_rejected'});
  });
});

test('rejects stale revisions, unsafe values, and tenant-contaminated evaluation', async t => {
  const invalid = [
    {...input, expectedRevision: 1},
    {...input, flagKey: 'Checkout New Flow'},
    {...input, environment: 'preview'},
    {...input, variantKey: 'secret value with spaces'},
  ];
  for (const candidate of invalid) await t.test(String(candidate.flagKey), async () => {
    const {options} = fixture(); assert.deepEqual(await configureFeatureFlag(1, authRequest, authState, candidate, options), {accepted: false, code: 'feature_flag_rejected'});
  });
  const {options} = fixture(); const created = await configureFeatureFlag(1, authRequest, authState, input, options);
  assert.deepEqual(evaluateFeatureFlag(1, 'org-2', input.flagKey, input.environment, created.value), {accepted: false, code: 'feature_flag_rejected'});
});

test('fails closed when audit or atomic persistence fails', async () => {
  const auditFailure = fixture(); auditFailure.options.audit.sink.append = async () => { throw new Error('offline'); };
  assert.deepEqual(await configureFeatureFlag(1, authRequest, authState, input, auditFailure.options), {accepted: false, code: 'feature_flag_rejected'});
  const commitFailure = fixture(); commitFailure.options.store.commit = async () => false;
  assert.deepEqual(await configureFeatureFlag(1, authRequest, authState, input, commitFailure.options), {accepted: false, code: 'feature_flag_rejected'});
});
