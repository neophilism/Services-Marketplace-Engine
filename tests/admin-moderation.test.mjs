import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_MODERATION_CONTRACT_VERSION,
  recordAdminModerationAction,
} from '../packages/contracts/dist/admin-moderation.js';

const authRequest = {
  subjectId: 'admin-1', organizationId: 'org-1', resourceOrganizationId: 'org-1',
  requiredPermission: 'admin:moderation:write',
};
const authState = {
  organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [{subjectId: 'admin-1', organizationId: 'org-1', status: 'active', roleIds: ['admin']}],
  roles: [{roleId: 'admin', organizationId: 'org-1', permissions: ['admin:moderation:write']}],
};
const input = {
  requestKey: 'request-1', caseId: null, targetType: 'review', targetId: 'review-1',
  action: 'open', reason: 'abuse', evidenceRefs: ['evidence-2', 'evidence-1'], expectedVersion: 0,
};

function fixture() {
  const state = {moderationCase: null, mutations: new Map(), committed: [], audits: []};
  let id = 0;
  const options = {
    now: () => 100,
    createOpaqueId: () => `opaque-${++id}`,
    audit: {now: () => 99, createOpaqueId: () => `audit-${++id}`,
      sink: {append: async event => { state.audits.push(event); }}},
    store: {
      getOperator: async (organizationId, subjectId) => ({
        organizationId, subjectId, status: 'active', permissions: ['admin:moderation:write'],
      }),
      getCase: async () => state.moderationCase,
      getActionByRequestKey: async (_organizationId, requestKey) =>
        state.mutations.get(requestKey) ?? null,
      commit: async (current, mutation) => {
        if (current !== state.moderationCase) return false;
        state.moderationCase = mutation.moderationCase;
        state.mutations.set(mutation.action.requestKey, mutation);
        state.committed.push(mutation);
        return true;
      },
    },
  };
  return {state, options};
}

test('opens and advances a tenant moderation case with immutable actions', async () => {
  const {state, options} = fixture();
  const opened = await recordAdminModerationAction(
    ADMIN_MODERATION_CONTRACT_VERSION, authRequest, authState, input, options);
  assert.equal(opened.accepted, true);
  assert.equal(opened.value.moderationCase.status, 'open');
  assert.deepEqual(opened.value.action.evidenceRefs, ['evidence-1', 'evidence-2']);
  assert.equal(Object.isFrozen(opened.value.action), true);
  const restricted = await recordAdminModerationAction(
    1, authRequest, authState, {
      ...input, requestKey: 'request-2', caseId: opened.value.moderationCase.caseId,
      action: 'restrict', reason: 'safety', evidenceRefs: [], expectedVersion: 1,
    }, options);
  assert.equal(restricted.accepted, true);
  assert.equal(restricted.value.moderationCase.status, 'restricted');
  assert.equal(restricted.value.moderationCase.version, 2);
  assert.equal(state.committed.length, 2);
});

test('accepts only exact request-key replay', async () => {
  const {options} = fixture();
  const created = await recordAdminModerationAction(1, authRequest, authState, input, options);
  assert.equal(created.accepted, true);
  const replayed = await recordAdminModerationAction(1, authRequest, authState, input, options);
  assert.deepEqual(replayed, {accepted: true, value: created.value, replayed: true});
  assert.deepEqual(await recordAdminModerationAction(
    1, authRequest, authState, {...input, reason: 'spam'}, options),
  {accepted: false, code: 'admin_moderation_rejected'});
});

test('rejects authorization, tenant, and operator failures', async t => {
  const cases = [
    ['wrong permission', {...authRequest, requiredPermission: 'admin:read'}, authState, null],
    ['cross tenant', {...authRequest, resourceOrganizationId: 'org-2'}, authState, null],
    ['inactive membership', authRequest, {...authState, memberships: [{...authState.memberships[0], status: 'revoked'}]}, null],
    ['inactive operator', authRequest, authState, {status: 'inactive'}],
    ['operator permission absent', authRequest, authState, {permissions: []}],
  ];
  for (const [name, request, state, operatorPatch] of cases) await t.test(name, async () => {
    const {options} = fixture();
    if (operatorPatch) {
      const original = options.store.getOperator;
      options.store.getOperator = async (...args) => ({...await original(...args), ...operatorPatch});
    }
    assert.deepEqual(await recordAdminModerationAction(1, request, state, input, options),
      {accepted: false, code: 'admin_moderation_rejected'});
  });
});

test('rejects invalid transitions, stale versions, and privacy-unsafe references', async t => {
  const invalid = [
    {...input, action: 'restrict'},
    {...input, expectedVersion: 1},
    {...input, evidenceRefs: ['duplicate', 'duplicate']},
    {...input, evidenceRefs: ['free text is not an opaque reference']},
  ];
  for (const candidate of invalid) await t.test(candidate.action, async () => {
    const {options} = fixture();
    assert.deepEqual(await recordAdminModerationAction(1, authRequest, authState, candidate, options),
      {accepted: false, code: 'admin_moderation_rejected'});
  });
});

test('fails closed when audit or atomic persistence fails', async () => {
  const auditFailure = fixture();
  auditFailure.options.audit.sink.append = async () => { throw new Error('offline'); };
  assert.deepEqual(await recordAdminModerationAction(
    1, authRequest, authState, input, auditFailure.options),
  {accepted: false, code: 'admin_moderation_rejected'});
  const commitFailure = fixture();
  commitFailure.options.store.commit = async () => false;
  assert.deepEqual(await recordAdminModerationAction(
    1, authRequest, authState, input, commitFailure.options),
  {accepted: false, code: 'admin_moderation_rejected'});
});
