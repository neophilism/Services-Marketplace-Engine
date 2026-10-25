import test from 'node:test';
import assert from 'node:assert/strict';
import {dispatchNotification} from '../packages/contracts/dist/notification-adapter.js';

const request = {subjectId: 'worker-1', organizationId: 'org-1', resourceOrganizationId: 'org-1', requiredPermission: 'notifications:dispatch'};
const authState = {organizations: [{organizationId: 'org-1', status: 'active'}], memberships: [{subjectId: 'worker-1', organizationId: 'org-1', status: 'active', roleIds: ['sender']}], roles: [{roleId: 'sender', organizationId: 'org-1', permissions: ['notifications:dispatch']} ]};
const intent = {intentId: 'intent-1', organizationId: 'org-1', status: 'ready', channel: 'email', recipientReference: 'recipient-1', templateKey: 'job.confirmed', payloadReference: 'payload-1', notBefore: 90, expiresAt: 200};
const input = {requestKey: 'request-1', intentId: 'intent-1'};

function fixture() {
  const data = {intent, deliveries: new Map(), sent: [], audits: []}; let id = 0;
  const options = {
    now: () => 100, createOpaqueId: () => `delivery-${++id}`,
    audit: {now: () => 99, createOpaqueId: () => `audit-${++id}`, sink: {append: async event => data.audits.push(event)}},
    adapters: {
      email: {send: async command => { data.sent.push(command); return {providerMessageId: 'provider-1'}; }},
      push: {send: async command => { data.sent.push(command); return {providerMessageId: 'provider-2'}; }},
      sms: {send: async command => { data.sent.push(command); return {providerMessageId: 'provider-3'}; }},
    },
    store: {
      getOperator: async (organizationId, subjectId) => ({organizationId, subjectId, status: 'active', permissions: ['notifications:dispatch']}),
      getIntent: async () => data.intent,
      getDeliveryByRequestKey: async (_organizationId, key) => data.deliveries.get(key) ?? null,
      commit: async (expected, delivery) => { if (expected !== data.intent) return false; data.deliveries.set(delivery.requestKey, delivery); return true; },
    },
  };
  return {data, options};
}

test('dispatches metadata-only intents through each channel adapter', async t => {
  for (const channel of ['email', 'push', 'sms']) await t.test(channel, async () => {
    const {data, options} = fixture(); data.intent = {...intent, channel};
    const result = await dispatchNotification(1, request, authState, input, options);
    assert.equal(result.accepted, true); assert.equal(result.value.channel, channel);
    assert.deepEqual(data.sent[0], {organizationId: 'org-1', requestKey: 'request-1', intentId: 'intent-1', recipientReference: 'recipient-1', templateKey: 'job.confirmed', payloadReference: 'payload-1'});
    assert.equal(Object.isFrozen(result.value), true);
  });
});

test('replays exactly without calling the provider twice', async () => {
  const {data, options} = fixture(); const first = await dispatchNotification(1, request, authState, input, options);
  assert.deepEqual(await dispatchNotification(1, request, authState, input, options), {accepted: true, value: first.value, replayed: true}); assert.equal(data.sent.length, 1);
  assert.deepEqual(await dispatchNotification(1, request, authState, {...input, intentId: 'intent-2'}, options), {accepted: false, code: 'notification_adapter_rejected'});
});

test('rejects authorization, tenant, and operator failures', async t => {
  const cases = [
    ['wrong permission', {...request, requiredPermission: 'notifications:read'}, authState, null],
    ['cross tenant', {...request, resourceOrganizationId: 'org-2'}, authState, null],
    ['inactive membership', request, {...authState, memberships: [{...authState.memberships[0], status: 'revoked'}]}, null],
    ['inactive operator', request, authState, {status: 'inactive'}],
    ['operator grant absent', request, authState, {permissions: []}],
  ];
  for (const [name, candidate, state, patch] of cases) await t.test(name, async () => {
    const {options} = fixture(); if (patch) { const original = options.store.getOperator; options.store.getOperator = async (...args) => ({...await original(...args), ...patch}); }
    assert.deepEqual(await dispatchNotification(1, candidate, state, input, options), {accepted: false, code: 'notification_adapter_rejected'});
  });
});

test('rejects cancelled, premature, expired, contaminated, and unsupported intents', async t => {
  const cases = [
    {status: 'cancelled'}, {notBefore: 101}, {expiresAt: 100},
    {organizationId: 'org-2'}, {recipientReference: 'raw address with spaces'}, {channel: 'fax'},
  ];
  for (const patch of cases) await t.test(JSON.stringify(patch), async () => {
    const {data, options} = fixture(); data.intent = {...intent, ...patch};
    assert.deepEqual(await dispatchNotification(1, request, authState, input, options), {accepted: false, code: 'notification_adapter_rejected'});
  });
});

test('fails closed for missing adapters, provider errors, invalid receipts, audit, and commit failures', async t => {
  const cases = [
    options => { options.adapters = {}; },
    options => { options.adapters.email.send = async () => { throw new Error('provider'); }; },
    options => { options.adapters.email.send = async () => ({providerMessageId: 'unsafe id'}); },
    options => { options.audit.sink.append = async () => { throw new Error('audit'); }; },
    options => { options.store.commit = async () => false; },
  ];
  for (const mutate of cases) await t.test(String(cases.indexOf(mutate)), async () => {
    const {options} = fixture(); mutate(options);
    assert.deepEqual(await dispatchNotification(1, request, authState, input, options), {accepted: false, code: 'notification_adapter_rejected'});
  });
});
