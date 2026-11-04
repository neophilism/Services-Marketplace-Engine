import test from 'node:test';
import assert from 'node:assert/strict';
import {configureAssistant, resolveActiveAssistant} from '../packages/contracts/dist/assistant-registry.js';

const request = {subjectId: 'operator-1', organizationId: 'org-1',
  resourceOrganizationId: 'org-1', requiredPermission: 'assistant-registry:write'};
const state = {organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [{subjectId: 'operator-1', organizationId: 'org-1', status: 'active',
    roleIds: ['operator']}], roles: [{roleId: 'operator', organizationId: 'org-1',
    permissions: ['assistant-registry:write']}]};
const input = {requestKey: 'request-1', assistantKey: 'support.concierge', status: 'active',
  modelKey: 'model.small', toolKeys: ['catalog.read'],
  instructionTemplateKey: 'support.v1', knowledgeSourceKeys: ['kb.public'],
  expectedRevision: 0};

function fixture() {
  const data = {current: null, byRequest: new Map(), audits: []}; let id = 0;
  const options = {now: () => 100, createOpaqueId: () => `assistant-config-${++id}`,
    audit: {now: () => 99, createOpaqueId: () => `audit-${++id}`,
      sink: {append: async event => data.audits.push(event)}},
    store: {
      getOperator: async (organizationId, subjectId) => ({organizationId, subjectId,
        status: 'active', permissions: ['assistant-registry:write']}),
      getCurrent: async () => data.current,
      getByRequestKey: async (_organizationId, key) => data.byRequest.get(key) ?? null,
      commit: async (current, configuration) => {
        if (current !== data.current) return false;
        data.current = configuration; data.byRequest.set(configuration.requestKey, configuration);
        return true;
      },
    }};
  return {data, options};
}

test('creates, revises, resolves, and exactly replays tenant configuration', async () => {
  const {data, options} = fixture();
  const created = await configureAssistant(1, request, state, input, options);
  assert.equal(created.accepted, true); assert.equal(created.value.revision, 1);
  assert.equal(Object.isFrozen(created.value.toolKeys), true);
  assert.deepEqual(await configureAssistant(1, request, state, input, options),
    {accepted: true, value: created.value, replayed: true});
  assert.equal(resolveActiveAssistant(1, 'org-1', input.assistantKey, created.value).accepted, true);
  const revised = await configureAssistant(1, request, state, {...input,
    requestKey: 'request-2', status: 'disabled', expectedRevision: 1}, options);
  assert.equal(revised.accepted, true); assert.equal(data.current.revision, 2);
  assert.deepEqual(resolveActiveAssistant(1, 'org-1', input.assistantKey, revised.value),
    {accepted: false, code: 'assistant_registry_rejected'});
});

test('rejects authorization, tenant, and operator failures', async t => {
  const cases = [
    ['wrong permission', {...request, requiredPermission: 'assistant-registry:read'}, state, null],
    ['cross tenant', {...request, resourceOrganizationId: 'org-2'}, state, null],
    ['revoked membership', request, {...state, memberships: [{...state.memberships[0], status: 'revoked'}]}, null],
    ['inactive operator', request, state, {status: 'inactive'}],
    ['operator grant absent', request, state, {permissions: []}],
  ];
  for (const [name, candidate, authState, patch] of cases) await t.test(name, async () => {
    const {options} = fixture();
    if (patch) { const original = options.store.getOperator;
      options.store.getOperator = async (...args) => ({...await original(...args), ...patch}); }
    assert.deepEqual(await configureAssistant(1, candidate, authState, input, options),
      {accepted: false, code: 'assistant_registry_rejected'});
  });
});

test('rejects ambiguous arrays, stale revisions, contaminated state, and non-exact replay', async () => {
  for (const patch of [{toolKeys: ['catalog.read', 'catalog.read']},
    {knowledgeSourceKeys: ['KB Secret']}, {expectedRevision: 1}]) {
    const {options} = fixture();
    assert.deepEqual(await configureAssistant(1, request, state, {...input, ...patch}, options),
      {accepted: false, code: 'assistant_registry_rejected'});
  }
  const replay = fixture(); const created = await configureAssistant(1, request, state, input, replay.options);
  assert.equal(created.accepted, true);
  assert.deepEqual(await configureAssistant(1, request, state, {...input, modelKey: 'model.large'}, replay.options),
    {accepted: false, code: 'assistant_registry_rejected'});
  replay.data.byRequest.set(input.requestKey, {...created.value, organizationId: 'org-2'});
  assert.deepEqual(await configureAssistant(1, request, state, input, replay.options),
    {accepted: false, code: 'assistant_registry_rejected'});
  assert.deepEqual(resolveActiveAssistant(1, 'org-2', input.assistantKey, created.value),
    {accepted: false, code: 'assistant_registry_rejected'});
});

test('fails closed when audit or atomic persistence fails', async () => {
  const audit = fixture(); audit.options.audit.sink.append = async () => { throw new Error('offline'); };
  assert.deepEqual(await configureAssistant(1, request, state, input, audit.options),
    {accepted: false, code: 'assistant_registry_rejected'});
  const commit = fixture(); commit.options.store.commit = async () => false;
  assert.deepEqual(await configureAssistant(1, request, state, input, commit.options),
    {accepted: false, code: 'assistant_registry_rejected'});
});
