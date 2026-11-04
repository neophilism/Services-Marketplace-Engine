import test from 'node:test';
import assert from 'node:assert/strict';
import {reserveAIInvocation} from '../packages/contracts/dist/ai-gateway.js';

const request = {subjectId: 'operator-1', organizationId: 'org-1', resourceOrganizationId: 'org-1', requiredPermission: 'ai-gateway:invoke'};
const authState = {organizations: [{organizationId: 'org-1', status: 'active'}], memberships: [{subjectId: 'operator-1', organizationId: 'org-1', status: 'active', roleIds: ['operator']}], roles: [{roleId: 'operator', organizationId: 'org-1', permissions: ['ai-gateway:invoke']}]};
const input = {requestKey: 'request-1', quotaKey: 'default', modelKey: 'model.small', toolKeys: ['catalog.read'], maximumInputTokens: 100, maximumOutputTokens: 50};

function fixture() {
  const data = {quota: {organizationId: 'org-1', quotaKey: 'default',
    periodStartsAt: 0, periodEndsAt: 1000, revision: 1,
    maximumRequests: 2, maximumInputTokens: 200, maximumOutputTokens: 100,
    maximumInputTokensPerRequest: 100, maximumOutputTokensPerRequest: 50,
    usedRequests: 0, usedInputTokens: 0, usedOutputTokens: 0,
    allowedModelKeys: ['model.small'], allowedToolKeys: ['catalog.read']},
    byRequest: new Map(), audits: []};
  const options = {now: () => 100, createOpaqueId: () => 'reservation-1',
    audit: {now: () => 99, createOpaqueId: () => 'audit-1',
      sink: {append: async event => data.audits.push(event)}},
    store: {
      getOperator: async (organizationId, subjectId) => ({organizationId, subjectId,
        status: 'active', permissions: ['ai-gateway:invoke']}),
      getQuota: async () => data.quota,
      getByRequestKey: async (_organizationId, key) => data.byRequest.get(key) ?? null,
      commit: async (expected, next, reservation) => {
        if (expected !== data.quota) return false;
        data.quota = next; data.byRequest.set(reservation.requestKey, reservation); return true;
      },
    }};
  return {data, options};
}

test('atomically reserves bounded quota and exactly replays a request', async () => {
  const {data, options} = fixture();
  const first = await reserveAIInvocation(1, request, authState, input, options);
  assert.equal(first.accepted, true);
  assert.equal(data.quota.usedRequests, 1);
  assert.equal(data.quota.usedInputTokens, 100);
  assert.equal(data.quota.usedOutputTokens, 50);
  assert.equal(data.quota.revision, 2);
  assert.equal(Object.isFrozen(first.value), true);
  assert.equal(Object.isFrozen(first.value.toolKeys), true);
  assert.deepEqual(await reserveAIInvocation(1, request, authState, input, options),
    {accepted: true, value: first.value, replayed: true});
  assert.equal(data.quota.usedRequests, 1);
});

test('rejects model, tool, per-request, period, and aggregate quota violations', async t => {
  const cases = [
    {modelKey: 'model.large'}, {toolKeys: ['network.fetch']},
    {maximumInputTokens: 101}, {maximumOutputTokens: 51},
  ];
  for (const patch of cases) await t.test(JSON.stringify(patch), async () => {
    const {options} = fixture();
    assert.deepEqual(await reserveAIInvocation(1, request, authState, {...input, ...patch},
      options), {accepted: false, code: 'ai_gateway_rejected'});
  });
  for (const mutate of [
    data => { data.quota = {...data.quota, periodEndsAt: 100}; },
    data => { data.quota = {...data.quota, usedRequests: 2}; },
    data => { data.quota = {...data.quota, usedInputTokens: 101}; },
  ]) {
    const {data, options} = fixture(); mutate(data);
    assert.deepEqual(await reserveAIInvocation(1, request, authState, input, options),
      {accepted: false, code: 'ai_gateway_rejected'});
  }
});

test('rejects authorization, tenant, and operator failures', async t => {
  const cases = [
    ['wrong permission', {...request, requiredPermission: 'ai-gateway:read'}, authState, null],
    ['cross tenant', {...request, resourceOrganizationId: 'org-2'}, authState, null],
    ['revoked membership', request, {...authState, memberships: [{...authState.memberships[0], status: 'revoked'}]}, null],
    ['inactive operator', request, authState, {status: 'inactive'}],
    ['operator permission absent', request, authState, {permissions: []}],
  ];
  for (const [name, candidate, state, operatorPatch] of cases) await t.test(name, async () => {
    const {options} = fixture();
    if (operatorPatch) {
      const original = options.store.getOperator;
      options.store.getOperator = async (...args) => ({...await original(...args),
        ...operatorPatch});
    }
    assert.deepEqual(await reserveAIInvocation(1, candidate, state, input, options),
      {accepted: false, code: 'ai_gateway_rejected'});
  });
});

test('rejects ambiguous tools, corrupt quota, and contaminated replay', async () => {
  const duplicate = fixture();
  assert.deepEqual(await reserveAIInvocation(1, request, authState,
    {...input, toolKeys: ['catalog.read', 'catalog.read']}, duplicate.options),
    {accepted: false, code: 'ai_gateway_rejected'});
  const corrupt = fixture(); corrupt.data.quota = {...corrupt.data.quota,
    allowedModelKeys: ['model.small', 'model.small']};
  assert.deepEqual(await reserveAIInvocation(1, request, authState, input, corrupt.options),
    {accepted: false, code: 'ai_gateway_rejected'});
  const replay = fixture(); replay.data.byRequest.set(input.requestKey,
    {organizationId: 'org-2'});
  assert.deepEqual(await reserveAIInvocation(1, request, authState, input, replay.options),
    {accepted: false, code: 'ai_gateway_rejected'});
});

test('fails closed when audit or atomic persistence fails', async () => {
  const audit = fixture(); audit.options.audit.sink.append = async () => {
    throw new Error('offline');
  };
  assert.deepEqual(await reserveAIInvocation(1, request, authState, input, audit.options),
    {accepted: false, code: 'ai_gateway_rejected'});
  const commit = fixture(); commit.options.store.commit = async () => false;
  assert.deepEqual(await reserveAIInvocation(1, request, authState, input, commit.options),
    {accepted: false, code: 'ai_gateway_rejected'});
  const clock = fixture(); clock.options.now = () => { throw new Error('clock offline'); };
  assert.deepEqual(await reserveAIInvocation(1, request, authState, input, clock.options),
    {accepted: false, code: 'ai_gateway_rejected'});
  const auditId = fixture(); auditId.options.audit.createOpaqueId = () => { throw new Error('id offline'); };
  assert.deepEqual(await reserveAIInvocation(1, request, authState, input, auditId.options),
    {accepted: false, code: 'ai_gateway_rejected'});
  const malformed = fixture();
  assert.deepEqual(await reserveAIInvocation(1, request, authState, null, malformed.options),
    {accepted: false, code: 'ai_gateway_rejected'});
});
