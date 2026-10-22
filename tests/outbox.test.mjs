import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchNextOutboxMessage,
  enqueueOutboxMessage,
} from '../packages/contracts/dist/outbox.js';

const authorization = {
  subjectId: 'subject-1',
  organizationId: 'org-1',
  resourceOrganizationId: 'org-1',
  requiredPermission: 'outbox:enqueue',
};

const state = {
  organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [{
    subjectId: 'subject-1',
    organizationId: 'org-1',
    status: 'active',
    roleIds: ['publisher'],
  }],
  roles: [{
    roleId: 'publisher',
    organizationId: 'org-1',
    permissions: ['outbox:enqueue'],
  }],
};

function fixture(overrides = {}) {
  let sequence = 0;
  let now = 1_000;
  const records = new Map();
  const events = [];
  const transitions = [];
  let claimed = null;
  const store = {
    enqueueUnique: async message => {
      const key = message.organizationId + ':' + message.idempotencyKey;
      const existing = records.get(key);
      if (existing) return {created: false, messageId: existing.messageId};
      records.set(key, message);
      return {created: true, messageId: message.messageId};
    },
    claimNext: async (_now, leaseExpiresAt) => claimed && ({
      ...claimed,
      leaseExpiresAt,
    }),
    acknowledge: async (messageId, leaseToken) => {
      transitions.push(['ack', messageId, leaseToken]);
      return leaseToken === 'lease-1';
    },
    retry: async (messageId, leaseToken, availableAt) => {
      transitions.push(['retry', messageId, leaseToken, availableAt]);
      return leaseToken === 'lease-1';
    },
    deadLetter: async (messageId, leaseToken) => {
      transitions.push(['dead', messageId, leaseToken]);
      return leaseToken === 'lease-1';
    },
  };
  const options = {
    store,
    audit: {
      sink: {append: async event => { events.push(event); }},
      createOpaqueId: () => 'audit-' + (++sequence),
      now: () => now,
    },
    createOpaqueId: () => 'message-' + (++sequence),
    now: () => now,
    leaseMs: 100,
    retryDelayMs: 25,
    maxAttempts: 3,
    ...overrides,
  };
  return {
    events,
    options,
    records,
    transitions,
    setClaimed: value => { claimed = value; },
    setNow: value => { now = value; },
  };
}

const request = (overrides = {}) => ({
  authorization,
  state,
  idempotencyKey: 'command-1',
  topic: 'job.created',
  payload: {jobId: 'job-1'},
  ...overrides,
});

test('tenant-scoped idempotency returns the original message without a second insert', async () => {
  const value = fixture();
  const first = await enqueueOutboxMessage(request(), value.options);
  const second = await enqueueOutboxMessage(request(), value.options);
  assert.deepEqual(first, {accepted: true, value: {messageId: 'message-2', created: true}});
  assert.deepEqual(second, {accepted: true, value: {messageId: 'message-2', created: false}});
  assert.equal(value.records.size, 1);
  assert.equal(value.events.length, 2);
  assert.equal(Object.isFrozen([...value.records.values()][0]), true);
});

test('the same idempotency key is independent across organizations', async () => {
  const value = fixture();
  await enqueueOutboxMessage(request(), value.options);
  const organizationTwoState = {
    organizations: [{organizationId: 'org-2', status: 'active'}],
    memberships: [{
      subjectId: 'subject-1',
      organizationId: 'org-2',
      status: 'active',
      roleIds: ['publisher'],
    }],
    roles: [{
      roleId: 'publisher',
      organizationId: 'org-2',
      permissions: ['outbox:enqueue'],
    }],
  };
  const second = await enqueueOutboxMessage(request({
    authorization: {...authorization, organizationId: 'org-2', resourceOrganizationId: 'org-2'},
    state: organizationTwoState,
  }), value.options);
  assert.equal(second.accepted, true);
  assert.equal(value.records.size, 2);
});

test('cross-tenant and missing-permission attempts are audited and never reach storage', async t => {
  for (const [name, candidate] of [
    ['cross tenant', {...authorization, resourceOrganizationId: 'org-2'}],
    ['wrong permission', {...authorization, requiredPermission: 'job:read'}],
  ]) {
    await t.test(name, async () => {
      let writes = 0;
      const value = fixture({
        store: {
          ...fixture().options.store,
          enqueueUnique: async () => { writes += 1; throw new Error('unexpected'); },
        },
      });
      assert.deepEqual(await enqueueOutboxMessage(
        request({authorization: candidate}),
        value.options,
      ), {accepted: false, code: 'outbox_rejected'});
      assert.equal(writes, 0);
      assert.equal(value.events.length, 1);
    });
  }
});

test('audit and outbox storage failures reject without disclosing infrastructure state', async () => {
  let writes = 0;
  const auditFailure = fixture({
    audit: {
      sink: {append: async () => { throw new Error('offline'); }},
      createOpaqueId: () => 'audit-1',
      now: () => 1_000,
    },
    store: {
      ...fixture().options.store,
      enqueueUnique: async () => { writes += 1; throw new Error('unexpected'); },
    },
  });
  assert.deepEqual(await enqueueOutboxMessage(request(), auditFailure.options), {
    accepted: false,
    code: 'outbox_rejected',
  });
  assert.equal(writes, 0);

  const storeFailure = fixture();
  storeFailure.options.store.enqueueUnique = async () => { throw new Error('offline'); };
  assert.deepEqual(await enqueueOutboxMessage(request(), storeFailure.options), {
    accepted: false,
    code: 'outbox_rejected',
  });
});

test('successful delivery acknowledges with the active lease token', async () => {
  const value = fixture();
  value.setClaimed({
    messageId: 'message-1',
    organizationId: 'org-1',
    idempotencyKey: 'command-1',
    topic: 'job.created',
    payload: {jobId: 'job-1'},
    createdAt: 900,
    attempt: 1,
    leaseToken: 'lease-1',
    leaseExpiresAt: 0,
  });
  assert.deepEqual(
    await dispatchNextOutboxMessage(async () => {}, value.options),
    {status: 'acknowledged', messageId: 'message-1'},
  );
  assert.deepEqual(value.transitions, [['ack', 'message-1', 'lease-1']]);
});

test('handler failure schedules a retry and dead-letters at the attempt limit', async () => {
  for (const [attempt, expected, transition] of [
    [2, 'retry_scheduled', 'retry'],
    [3, 'dead_lettered', 'dead'],
  ]) {
    const value = fixture();
    value.setClaimed({
      messageId: 'message-1',
      organizationId: 'org-1',
      idempotencyKey: 'command-1',
      topic: 'job.created',
      payload: {},
      createdAt: 900,
      attempt,
      leaseToken: 'lease-1',
      leaseExpiresAt: 0,
    });
    const result = await dispatchNextOutboxMessage(
      async () => { throw new Error('delivery failed'); },
      value.options,
    );
    assert.equal(result.status, expected);
    assert.equal(value.transitions[0][0], transition);
  }
});

test('malformed claims and stale lease acknowledgements fail closed', async () => {
  const malformed = fixture();
  malformed.setClaimed({
    messageId: '',
    organizationId: 'org-1',
    idempotencyKey: 'command-1',
    topic: 'job.created',
    payload: {},
    createdAt: 900,
    attempt: 1,
    leaseToken: 'lease-1',
    leaseExpiresAt: 0,
  });
  assert.deepEqual(await dispatchNextOutboxMessage(async () => {}, malformed.options), {
    status: 'failed',
    code: 'outbox_rejected',
  });

  const stale = fixture();
  stale.setClaimed({
    messageId: 'message-1',
    organizationId: 'org-1',
    idempotencyKey: 'command-1',
    topic: 'job.created',
    payload: {},
    createdAt: 900,
    attempt: 1,
    leaseToken: 'stale',
    leaseExpiresAt: 0,
  });
  assert.deepEqual(await dispatchNextOutboxMessage(async () => {}, stale.options), {
    status: 'failed',
    code: 'outbox_rejected',
  });
});
