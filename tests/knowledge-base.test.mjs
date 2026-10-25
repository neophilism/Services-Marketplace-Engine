import test from 'node:test';
import assert from 'node:assert/strict';
import {resolvePublishedKnowledgeBaseArticle, reviseKnowledgeBaseArticle} from '../packages/contracts/dist/knowledge-base.js';

const request = {subjectId: 'editor-1', organizationId: 'org-1', resourceOrganizationId: 'org-1', requiredPermission: 'knowledge-base:write'};
const authState = {organizations: [{organizationId: 'org-1', status: 'active'}], memberships: [{subjectId: 'editor-1', organizationId: 'org-1', status: 'active', roleIds: ['editor']}], roles: [{roleId: 'editor', organizationId: 'org-1', permissions: ['knowledge-base:write']}]};
const digest = 'a'.repeat(64);
const input = {requestKey: 'request-1', articleKey: 'booking-help', locale: 'en-US', title: 'Booking help', contentReference: 'content-1', contentDigest: digest, status: 'draft', expectedRevision: 0};

function fixture() {
  const data = {current: null, byRequest: new Map(), audits: []}; let id = 0;
  const options = {
    now: () => 100, createOpaqueId: () => `revision-${++id}`,
    audit: {now: () => 99, createOpaqueId: () => `audit-${++id}`, sink: {append: async event => data.audits.push(event)}},
    store: {
      getOperator: async (organizationId, subjectId) => ({organizationId, subjectId, status: 'active', permissions: ['knowledge-base:write']}),
      getCurrent: async () => data.current,
      getByRequestKey: async (_organizationId, key) => data.byRequest.get(key) ?? null,
      commit: async (expected, revision) => { if (expected !== data.current) return false; data.current = revision; data.byRequest.set(revision.requestKey, revision); return true; },
    },
  };
  return {data, options};
}

test('creates immutable drafts and replays the exact request', async () => {
  const {data, options} = fixture();
  const first = await reviseKnowledgeBaseArticle(1, request, authState, input, options);
  assert.equal(first.accepted, true); assert.equal(first.value.revision, 1);
  assert.equal(Object.isFrozen(first.value), true);
  assert.deepEqual(await reviseKnowledgeBaseArticle(1, request, authState, input, options), {accepted: true, value: first.value, replayed: true});
  assert.equal(data.byRequest.size, 1);
});

test('publishes and archives through revision-fenced transitions', async () => {
  const {data, options} = fixture();
  const draft = await reviseKnowledgeBaseArticle(1, request, authState, input, options);
  options.now = () => 110;
  const publishInput = {...input, requestKey: 'request-2', status: 'published', expectedRevision: 1};
  const published = await reviseKnowledgeBaseArticle(1, request, authState, publishInput, options);
  assert.equal(published.accepted, true); assert.equal(published.value.publishedAt, 110);
  assert.deepEqual(resolvePublishedKnowledgeBaseArticle(1, 'org-1', 'booking-help', 'en-US', published.value), {accepted: true, value: published.value});
  options.now = () => 120;
  const archived = await reviseKnowledgeBaseArticle(1, request, authState, {...publishInput, requestKey: 'request-3', status: 'archived', expectedRevision: 2}, options);
  assert.equal(archived.accepted, true); assert.equal(archived.value.publishedAt, null);
  assert.deepEqual(resolvePublishedKnowledgeBaseArticle(1, 'org-1', 'booking-help', 'en-US', archived.value), {accepted: false, code: 'knowledge_base_rejected'});
  assert.notEqual(draft.value, data.current);
});

test('rejects authorization, tenant, and operator failures', async t => {
  const cases = [
    ['wrong permission', {...request, requiredPermission: 'knowledge-base:read'}, authState, null],
    ['cross tenant', {...request, resourceOrganizationId: 'org-2'}, authState, null],
    ['inactive membership', request, {...authState, memberships: [{...authState.memberships[0], status: 'revoked'}]}, null],
    ['inactive operator', request, authState, {status: 'inactive'}],
    ['operator grant absent', request, authState, {permissions: []}],
  ];
  for (const [name, candidate, state, patch] of cases) await t.test(name, async () => {
    const {options} = fixture(); if (patch) { const original = options.store.getOperator; options.store.getOperator = async (...args) => ({...await original(...args), ...patch}); }
    assert.deepEqual(await reviseKnowledgeBaseArticle(1, candidate, state, input, options), {accepted: false, code: 'knowledge_base_rejected'});
  });
});

test('rejects invalid content metadata, stale writes, and unsafe transitions', async t => {
  const invalid = [
    {articleKey: 'Unsafe Key'}, {locale: 'EN_us'}, {title: '<script>'},
    {contentReference: 'raw reference'}, {contentDigest: 'not-a-digest'}, {status: 'published'},
  ];
  for (const patch of invalid) await t.test(JSON.stringify(patch), async () => {
    const {options} = fixture();
    assert.deepEqual(await reviseKnowledgeBaseArticle(1, request, authState, {...input, ...patch}, options), {accepted: false, code: 'knowledge_base_rejected'});
  });
  const {data, options} = fixture(); await reviseKnowledgeBaseArticle(1, request, authState, input, options);
  assert.deepEqual(await reviseKnowledgeBaseArticle(1, request, authState, {...input, requestKey: 'request-2'}, options), {accepted: false, code: 'knowledge_base_rejected'});
  data.current = {...data.current, organizationId: 'org-2'};
  assert.deepEqual(await reviseKnowledgeBaseArticle(1, request, authState, {...input, requestKey: 'request-3', expectedRevision: 1}, options), {accepted: false, code: 'knowledge_base_rejected'});
});

test('fails closed for replay contamination, audit failure, and failed persistence', async t => {
  const cases = [
    options => { options.store.getByRequestKey = async () => ({organizationId: 'org-2'}); },
    options => { options.audit.sink.append = async () => { throw new Error('audit'); }; },
    options => { options.store.commit = async () => false; },
  ];
  for (const mutate of cases) await t.test(String(cases.indexOf(mutate)), async () => {
    const {options} = fixture(); mutate(options);
    assert.deepEqual(await reviseKnowledgeBaseArticle(1, request, authState, input, options), {accepted: false, code: 'knowledge_base_rejected'});
  });
});
