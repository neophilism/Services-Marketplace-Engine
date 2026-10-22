import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDraftServiceDefinition,
  listPublishedServiceDefinitions,
  publishServiceDefinition,
  retireServiceDefinition,
  validateServiceIntake,
} from '../packages/contracts/dist/service-taxonomy.js';

const permissions = [
  'service-taxonomy:read', 'service-taxonomy:write', 'service-intake:submit',
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
const input = {
  serviceKey: 'general-repair',
  revision: 1,
  title: 'General repair',
  description: 'A reusable service category.',
  fields: [
    {key: 'summary', label: 'Summary', kind: 'text', required: true, minimum: 3, maximum: 80},
    {key: 'priority', label: 'Priority', kind: 'choice', required: true, options: ['normal', 'urgent']},
    {key: 'units', label: 'Units', kind: 'integer', required: false, minimum: 1, maximum: 100},
    {key: 'flexible', label: 'Flexible date', kind: 'boolean', required: false},
    {key: 'visit-date', label: 'Visit date', kind: 'date', required: false},
  ],
};

function fixture() {
  let sequence = 0;
  let now = 1_000;
  const definitions = new Map();
  const key = value => value.organizationId + ':' + value.serviceKey + ':' + value.revision;
  const options = {
    store: {
      getDefinition: async (organizationId, serviceKey, revision) =>
        definitions.get(organizationId + ':' + serviceKey + ':' + revision) ?? null,
      getPublishedDefinition: async (organizationId, serviceKey) =>
        [...definitions.values()]
          .filter(value => value.organizationId === organizationId &&
            value.serviceKey === serviceKey && value.status === 'published')
          .sort((left, right) => right.revision - left.revision)[0] ?? null,
      createDefinition: async value => {
        if (definitions.has(key(value))) return false;
        definitions.set(key(value), value);
        return true;
      },
      replaceDefinition: async (current, replacement) => {
        if (definitions.get(key(current)) !== current) return false;
        definitions.set(key(current), replacement);
        return true;
      },
      listPublishedDefinitions: async organizationId =>
        [...definitions.values()].filter(value =>
          value.organizationId === organizationId && value.status === 'published'),
    },
    audit: {
      sink: {append: async () => {}},
      createOpaqueId: () => 'audit-' + (++sequence),
      now: () => now,
    },
    createOpaqueId: () => 'definition-' + (++sequence),
    now: () => now,
  };
  return {
    definitions,
    options,
    setNow: value => { now = value; },
  };
}

async function create(value, draft = input, authorization = auth('service-taxonomy:write')) {
  return createDraftServiceDefinition(1, authorization, state, draft, value.options);
}

async function publish(value, revision = 1, expectedRecordVersion = 1) {
  return publishServiceDefinition(
    auth('service-taxonomy:write'), state, input.serviceKey,
    revision, expectedRecordVersion, value.options,
  );
}

test('creates and publishes an immutable bounded service revision', async () => {
  const value = fixture();
  const draft = await create(value);
  assert.equal(draft.accepted, true);
  assert.equal(draft.value.status, 'draft');
  assert.equal(Object.isFrozen(draft.value.fields), true);
  assert.equal(Object.isFrozen(draft.value.fields[1].options), true);

  value.setNow(1_001);
  const published = await publish(value);
  assert.equal(published.accepted, true);
  assert.equal(published.value.status, 'published');
  assert.equal(published.value.recordVersion, 2);

  assert.deepEqual(await publish(value), {
    accepted: false, code: 'service_taxonomy_rejected',
  });
});

test('requires exact contract, tenant, permission and bounded schema vocabulary', async () => {
  for (const [version, authorization, draft] of [
    [2, auth('service-taxonomy:write'), input],
    [1, auth('service-taxonomy:read'), input],
    [1, {...auth('service-taxonomy:write'), resourceOrganizationId: 'org-2'}, input],
    [1, auth('service-taxonomy:write'), {...input, serviceKey: 'Bad Key'}],
    [1, auth('service-taxonomy:write'), {...input, fields: []}],
    [1, auth('service-taxonomy:write'), {
      ...input,
      fields: [{key: 'choice', label: 'Choice', kind: 'choice', required: true, options: ['same', 'same']}],
    }],
    [1, auth('service-taxonomy:write'), {
      ...input,
      fields: [{key: 'flag', label: 'Flag', kind: 'boolean', required: true, minimum: 0}],
    }],
    [1, auth('service-taxonomy:write'), {
      ...input,
      fields: [{key: 'summary', label: 'Summary', kind: 'text', required: 'yes'}],
    }],
    [1, auth('service-taxonomy:write'), {
      ...input,
      fields: [{key: 'units', label: 'Units', kind: 'integer', required: false, minimum: 1.5}],
    }],
    [1, auth('service-taxonomy:write'), {
      ...input,
      fields: [
        {key: 'duplicate', label: 'First', kind: 'text', required: true},
        {key: 'duplicate', label: 'Second', kind: 'text', required: true},
      ],
    }],
  ]) {
    const value = fixture();
    assert.deepEqual(
      await createDraftServiceDefinition(version, authorization, state, draft, value.options),
      {accepted: false, code: 'service_taxonomy_rejected'},
    );
  }
});

test('requires a published prior revision and an active published parent', async () => {
  const value = fixture();
  assert.deepEqual(await create(value, {...input, revision: 2}), {
    accepted: false, code: 'service_taxonomy_rejected',
  });
  assert.deepEqual(await create(value, {...input, parentServiceKey: 'parent'}), {
    accepted: false, code: 'service_taxonomy_rejected',
  });

  const parent = {...input, serviceKey: 'parent', title: 'Parent'};
  assert.equal((await create(value, parent)).accepted, true);
  value.setNow(1_001);
  assert.equal((await publishServiceDefinition(
    auth('service-taxonomy:write'), state, 'parent', 1, 1, value.options,
  )).accepted, true);

  value.setNow(1_002);
  assert.equal((await create(value, {...input, parentServiceKey: 'parent'})).accepted, true);
  value.setNow(1_003);
  assert.equal((await publish(value)).accepted, true);
  value.setNow(1_004);
  assert.equal((await create(value, {...input, revision: 2})).accepted, true);
});

test('children remain retireable after their parent is retired', async () => {
  const value = fixture();
  const parent = {...input, serviceKey: 'parent', title: 'Parent'};
  await create(value, parent);
  value.setNow(1_001);
  await publishServiceDefinition(
    auth('service-taxonomy:write'), state, 'parent', 1, 1, value.options,
  );
  value.setNow(1_002);
  await create(value, {...input, parentServiceKey: 'parent'});
  value.setNow(1_003);
  await publish(value);
  value.setNow(1_004);
  assert.equal((await retireServiceDefinition(
    auth('service-taxonomy:write'), state, 'parent', 1, 2, value.options,
  )).accepted, true);
  value.setNow(1_005);
  assert.equal((await retireServiceDefinition(
    auth('service-taxonomy:write'), state, input.serviceKey, 1, 2, value.options,
  )).accepted, true);
});

test('validates answers against an exact published revision', async () => {
  const value = fixture();
  await create(value);
  value.setNow(1_001);
  await publish(value);

  const accepted = await validateServiceIntake(
    auth('service-intake:submit'), state, input.serviceKey, 1,
    {priority: 'normal', summary: 'Fix the issue', units: 2, flexible: true}, value.options,
  );
  assert.deepEqual(accepted, {
    accepted: true,
    value: {summary: 'Fix the issue', priority: 'normal', units: 2, flexible: true},
  });
  assert.equal(Object.isFrozen(accepted.value), true);
});

test('rejects draft, missing, additional, mistyped and out-of-bounds answers', async () => {
  const value = fixture();
  await create(value);
  assert.equal((await validateServiceIntake(
    auth('service-intake:submit'), state, input.serviceKey, 1,
    {summary: 'Fix it', priority: 'normal'}, value.options,
  )).accepted, false);
  value.setNow(1_001);
  await publish(value);

  for (const answers of [
    {priority: 'normal'},
    {summary: 'Fix it', priority: 'normal', extra: 'hidden'},
    {summary: 'x', priority: 'normal'},
    {summary: 'Fix it', priority: 'invalid'},
    {summary: 'Fix it', priority: 'normal', units: 1.5},
    {summary: 'Fix it', priority: 'normal', flexible: 'yes'},
    {summary: 'Fix it', priority: 'normal', 'visit-date': '2026-02-31'},
  ]) {
    assert.deepEqual(await validateServiceIntake(
      auth('service-intake:submit'), state, input.serviceKey, 1, answers, value.options,
    ), {accepted: false, code: 'service_taxonomy_rejected'});
  }
});

test('retires definitions and excludes them from new submissions and listings', async () => {
  const value = fixture();
  await create(value);
  value.setNow(1_001);
  await publish(value);
  assert.equal((await listPublishedServiceDefinitions(
    auth('service-taxonomy:read'), state, value.options,
  )).value.length, 1);

  value.setNow(1_002);
  const retired = await retireServiceDefinition(
    auth('service-taxonomy:write'), state, input.serviceKey, 1, 2, value.options,
  );
  assert.equal(retired.accepted, true);
  assert.equal(retired.value.status, 'retired');
  assert.equal((await validateServiceIntake(
    auth('service-intake:submit'), state, input.serviceKey, 1,
    {summary: 'Fix it', priority: 'normal'}, value.options,
  )).accepted, false);
});

test('rejects contaminated adapter results and stale writes', async () => {
  const value = fixture();
  await create(value);
  const originalGet = value.options.store.getDefinition;
  value.options.store.getDefinition = async () => ({
    ...input,
    serviceDefinitionId: 'other',
    organizationId: 'org-2',
    status: 'draft',
    recordVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  assert.equal((await publish(value)).accepted, false);
  value.options.store.getDefinition = originalGet;
  assert.equal((await publish(value, 1, 2)).accepted, false);

  value.options.store.listPublishedDefinitions = async () => [{
    ...value.definitions.values().next().value,
    organizationId: 'org-2',
    status: 'published',
  }];
  assert.equal((await listPublishedServiceDefinitions(
    auth('service-taxonomy:read'), state, value.options,
  )).accepted, false);
});

test('fails closed on audit and persistence failures', async () => {
  const value = fixture();
  value.options.audit.sink.append = async () => { throw Error('audit unavailable'); };
  assert.equal((await create(value)).accepted, false);

  const second = fixture();
  second.options.store.createDefinition = async () => { throw Error('store unavailable'); };
  assert.equal((await create(second)).accepted, false);
});
