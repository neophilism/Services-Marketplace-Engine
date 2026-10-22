import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeAndAuditOrganizationAction} from '../packages/contracts/dist/audit.js';

const request = {
  subjectId: 'subject-1',
  organizationId: 'org-1',
  resourceOrganizationId: 'org-1',
  requiredPermission: 'job:read',
};

const state = {
  organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [{
    subjectId: 'subject-1',
    organizationId: 'org-1',
    status: 'active',
    roleIds: ['operator'],
  }],
  roles: [{roleId: 'operator', organizationId: 'org-1', permissions: ['job:read']}],
};

function fixture(overrides = {}) {
  const events = [];
  return {
    events,
    options: {
      sink: {append: async event => { events.push(event); }},
      createOpaqueId: () => 'audit-1',
      now: () => 1_000,
      ...overrides,
    },
  };
}

test('authorized tenant actions append a structured immutable event', async () => {
  const {events, options} = fixture();
  const result = await authorizeAndAuditOrganizationAction(request, state, 'job.read', options);
  assert.equal(result.authorized, true);
  assert.deepEqual(events, [{
    eventId: 'audit-1',
    occurredAt: 1_000,
    action: 'job.read',
    subjectId: 'subject-1',
    organizationId: 'org-1',
    resourceOrganizationId: 'org-1',
    outcome: 'authorized',
  }]);
  assert.equal(Object.isFrozen(events[0]), true);
});

test('denied cross-tenant attempts are recorded without changing the denial', async () => {
  const {events, options} = fixture();
  const result = await authorizeAndAuditOrganizationAction(
    {...request, resourceOrganizationId: 'org-2'},
    state,
    'job.read',
    options,
  );
  assert.deepEqual(result, {authorized: false, code: 'authorization_denied'});
  assert.equal(events[0].outcome, 'denied');
  assert.equal(events[0].resourceOrganizationId, 'org-2');
});

test('missing identity context is redacted to null in denied events', async () => {
  const {events, options} = fixture();
  await authorizeAndAuditOrganizationAction(
    {...request, subjectId: undefined, organizationId: undefined},
    state,
    'job.read',
    options,
  );
  assert.equal(events[0].subjectId, null);
  assert.equal(events[0].organizationId, null);
  assert.equal(events[0].outcome, 'denied');
});

test('audit sink failure denies an otherwise authorized action', async () => {
  const {options} = fixture({sink: {append: async () => { throw new Error('unavailable'); }}});
  assert.deepEqual(
    await authorizeAndAuditOrganizationAction(request, state, 'job.read', options),
    {authorized: false, code: 'authorization_denied'},
  );
});

test('invalid event metadata fails closed before the sink', async t => {
  for (const [name, action, overrides] of [
    ['missing action', '', {}],
    ['missing event ID', 'job.read', {createOpaqueId: () => ''}],
    ['invalid timestamp', 'job.read', {now: () => -1}],
  ]) {
    await t.test(name, async () => {
      let appends = 0;
      const {options} = fixture({
        sink: {append: async () => { appends += 1; }},
        ...overrides,
      });
      assert.deepEqual(
        await authorizeAndAuditOrganizationAction(request, state, action, options),
        {authorized: false, code: 'authorization_denied'},
      );
      assert.equal(appends, 0);
    });
  }
});
