import test from 'node:test';
import assert from 'node:assert/strict';
import {handleResourceRead} from '../apps/api/dist/index.js';
import {processTask} from '../apps/worker/dist/index.js';

const membership = (organizationId, status, permissions) => ({
  organizationId,
  status,
  permissions,
});

const deniedCases = [
  ['missing tenant', {subjectId: 'subject-1', memberships: []}],
  ['inactive membership', {
    subjectId: 'subject-1',
    organizationId: 'org-1',
    memberships: [membership('org-1', 'inactive', ['resource:read', 'task:execute'])],
  }],
  ['revoked membership', {
    subjectId: 'subject-1',
    organizationId: 'org-1',
    memberships: [membership('org-1', 'revoked', ['resource:read', 'task:execute'])],
  }],
  ['missing permission', {
    subjectId: 'subject-1',
    organizationId: 'org-1',
    memberships: [membership('org-1', 'active', [])],
  }],
  ['cross-tenant resource', {
    subjectId: 'subject-1',
    organizationId: 'org-2',
    memberships: [membership('org-2', 'active', ['resource:read', 'task:execute'])],
  }],
];

test('API denies every tenant boundary case before resource lookup', async t => {
  for (const [name, context] of deniedCases) {
    await t.test(name, async () => {
      let lookups = 0;
      const response = await handleResourceRead(
        {contractVersion: 1, context, organizationId: 'org-1', resourceId: 'resource-1'},
        async () => {
          lookups += 1;
          return {id: 'resource-1'};
        },
      );
      assert.deepEqual(response, {status: 403, body: {code: 'authorization_denied'}});
      assert.equal(lookups, 0);
    });
  }
});

test('worker denies every tenant boundary case before task execution', async t => {
  for (const [name, context] of deniedCases) {
    await t.test(name, async () => {
      let executions = 0;
      const result = await processTask(
        {contractVersion: 1, context, organizationId: 'org-1', taskId: 'task-1'},
        async () => {
          executions += 1;
        },
      );
      assert.deepEqual(result, {accepted: false, code: 'authorization_denied'});
      assert.equal(executions, 0);
    });
  }
});

test('API and worker accept active memberships with explicit permissions', async () => {
  const context = {
    subjectId: 'subject-1',
    organizationId: 'org-1',
    memberships: [membership('org-1', 'active', ['resource:read', 'task:execute'])],
  };
  const response = await handleResourceRead(
    {contractVersion: 1, context, organizationId: 'org-1', resourceId: 'resource-1'},
    async (_organizationId, id) => ({id}),
  );
  const result = await processTask(
    {contractVersion: 1, context, organizationId: 'org-1', taskId: 'task-1'},
    async () => {},
  );

  assert.deepEqual(response, {
    status: 200,
    body: {id: 'resource-1', organizationId: 'org-1'},
  });
  assert.deepEqual(result, {accepted: true});
});

test('API and worker reject unsupported contract versions before side effects', async () => {
  const context = {memberships: []};
  const api = await handleResourceRead(
    {contractVersion: 2, context, organizationId: 'org-1', resourceId: 'resource-1'},
    async () => assert.fail('resource lookup must not run'),
  );
  const worker = await processTask(
    {contractVersion: 2, context, organizationId: 'org-1', taskId: 'task-1'},
    async () => assert.fail('task must not run'),
  );

  assert.deepEqual(api, {status: 400, body: {code: 'unsupported_contract_version'}});
  assert.deepEqual(worker, {accepted: false, code: 'unsupported_contract_version'});
});
