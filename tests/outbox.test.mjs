import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchNextOutboxMessage,
  enqueueOutboxMessage,
} from '../packages/contracts/dist/outbox.js';

const DIGEST_A = 'sha256:' + 'a'.repeat(64);
const DIGEST_B = 'sha256:' + 'b'.repeat(64);

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
  let claimed = null;
  const commands = new Map();
  const events = [];
  const auditEvents = [];
  const deliveries = new Set();
  const transitions = [];

  const store = {
    executeCommand: async (message, operation) => {
      const key = message.organizationId + ':' + message.idempotencyKey;
      const existing = commands.get(key);
      if (existing?.digest !== message.requestDigest) return {status: 'conflict'};
      if (existing) {
        return {
          status: 'replayed',
          messageId: existing.messageId,
          response: existing.response,
        };
      }
      const response = await operation();
      commands.set(key, {
        digest: message.requestDigest,
        messageId: message.messageId,
        response,
      });
      events.push(message);
      return {status: 'committed', messageId: message.messageId, response};
    },
    claimNext: async (_now, leaseExpiresAt) => claimed && ({
      ...claimed,
      leaseExpiresAt,
    }),
    consume: async (consumerId, message, handler) => {
      const key = consumerId + ':' + message.messageId;
      if (deliveries.has(key)) return 'duplicate';
      await handler(message);
      deliveries.add(key);
      return 'processed';
    },
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
      sink: {append: async event => { auditEvents.push(event); }},
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
    auditEvents,
    commands,
    deliveries,
    events,
    options,
    transitions,
    setClaimed: value => { claimed = value; },
  };
}

const request = (overrides = {}) => ({
  contractVersion: 1,
  authorization,
  state,
  idempotencyKey: 'command-1',
  requestDigest: DIGEST_A,
  topic: 'job.created',
  payload: {jobId: 'job-1'},
  operation: async () => ({jobId: 'job-1', revision: 1}),
  ...overrides,
});

function leased(overrides = {}) {
  return {
    contractVersion: 1,
    messageId: 'message-1',
    organizationId: 'org-1',
    idempotencyKey: 'command-1',
    requestDigest: DIGEST_A,
    topic: 'job.created',
    payload: {jobId: 'job-1'},
    createdAt: 900,
    attempt: 1,
    leaseToken: 'lease-1',
    leaseExpiresAt: 0,
    ...overrides,
  };
}

test('same-input replay returns the original response without rerunning the command', async () => {
  const value = fixture();
  let operations = 0;
  const command = request({
    operation: async () => ({jobId: 'job-1', revision: ++operations}),
  });
  const first = await enqueueOutboxMessage(command, value.options);
  const second = await enqueueOutboxMessage(command, value.options);
  assert.deepEqual(first, {
    accepted: true,
    value: {
      messageId: 'message-2',
      created: true,
      response: {jobId: 'job-1', revision: 1},
    },
  });
  assert.deepEqual(second, {
    accepted: true,
    value: {
      messageId: 'message-2',
      created: false,
      response: {jobId: 'job-1', revision: 1},
    },
  });
  assert.equal(operations, 1);
  assert.equal(value.events.length, 1);
});

test('a tenant key reused with a different canonical digest is rejected', async () => {
  const value = fixture();
  await enqueueOutboxMessage(request(), value.options);
  assert.deepEqual(await enqueueOutboxMessage(
    request({requestDigest: DIGEST_B}),
    value.options,
  ), {accepted: false, code: 'outbox_rejected'});
  assert.equal(value.commands.size, 1);
  assert.equal(value.events.length, 1);
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
  assert.equal((await enqueueOutboxMessage(request({
    authorization: {...authorization, organizationId: 'org-2', resourceOrganizationId: 'org-2'},
    state: organizationTwoState,
  }), value.options)).accepted, true);
  assert.equal(value.commands.size, 2);
});

test('rolled-back commands leave no idempotency result or outbound event', async () => {
  const value = fixture();
  assert.deepEqual(await enqueueOutboxMessage(request({
    operation: async () => { throw new Error('rollback'); },
  }), value.options), {accepted: false, code: 'outbox_rejected'});
  assert.equal(value.commands.size, 0);
  assert.equal(value.events.length, 0);
});

test('contract versions, digests, identifiers and authorization fail closed', async t => {
  for (const [name, override] of [
    ['unknown version', {contractVersion: 2}],
    ['malformed digest', {requestDigest: 'not-a-digest'}],
    ['malformed identifier', {idempotencyKey: 'contains spaces'}],
    ['cross tenant', {authorization: {...authorization, resourceOrganizationId: 'org-2'}}],
    ['wrong permission', {authorization: {...authorization, requiredPermission: 'job:read'}}],
  ]) {
    await t.test(name, async () => {
      const value = fixture();
      assert.deepEqual(await enqueueOutboxMessage(request(override), value.options), {
        accepted: false,
        code: 'outbox_rejected',
      });
      assert.equal(value.events.length, 0);
    });
  }
});

test('audit and transactional storage failures use one rejection', async () => {
  const auditFailure = fixture({
    audit: {
      sink: {append: async () => { throw new Error('offline'); }},
      createOpaqueId: () => 'audit-1',
      now: () => 1_000,
    },
  });
  assert.deepEqual(await enqueueOutboxMessage(request(), auditFailure.options), {
    accepted: false,
    code: 'outbox_rejected',
  });

  const storeFailure = fixture();
  storeFailure.options.store.executeCommand = async () => { throw new Error('offline'); };
  assert.deepEqual(await enqueueOutboxMessage(request(), storeFailure.options), {
    accepted: false,
    code: 'outbox_rejected',
  });
});

test('durable consumer deduplication skips a repeated handler and acknowledges it', async () => {
  const value = fixture();
  value.setClaimed(leased());
  let handled = 0;
  const handler = async () => { handled += 1; };
  assert.deepEqual(await dispatchNextOutboxMessage('mailer', handler, value.options), {
    status: 'acknowledged',
    messageId: 'message-1',
  });
  assert.deepEqual(await dispatchNextOutboxMessage('mailer', handler, value.options), {
    status: 'duplicate',
    messageId: 'message-1',
  });
  assert.equal(handled, 1);
  assert.equal(value.deliveries.size, 1);
});

test('handler failure schedules retry and dead-letters at the attempt limit', async () => {
  for (const [attempt, expected, transition] of [
    [2, 'retry_scheduled', 'retry'],
    [3, 'dead_lettered', 'dead'],
  ]) {
    const value = fixture();
    value.setClaimed(leased({attempt}));
    const result = await dispatchNextOutboxMessage(
      'mailer',
      async () => { throw new Error('delivery failed'); },
      value.options,
    );
    assert.equal(result.status, expected);
    assert.equal(value.transitions[0][0], transition);
    assert.equal(value.deliveries.size, 0);
  }
});

test('unknown-version claims and stale lease acknowledgements fail closed', async () => {
  const invalid = fixture();
  invalid.setClaimed(leased({contractVersion: 2}));
  assert.deepEqual(await dispatchNextOutboxMessage('mailer', async () => {}, invalid.options), {
    status: 'failed',
    code: 'outbox_rejected',
  });

  const stale = fixture();
  stale.setClaimed(leased({leaseToken: 'stale'}));
  assert.deepEqual(await dispatchNextOutboxMessage('mailer', async () => {}, stale.options), {
    status: 'failed',
    code: 'outbox_rejected',
  });
});
