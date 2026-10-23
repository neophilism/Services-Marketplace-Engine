import test from 'node:test';
import assert from 'node:assert/strict';
import {indexSearchDocument, searchIndex} from '../packages/contracts/dist/search.js';

const permissions = ['search:read', 'search:write'];
const state = {
  organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [{subjectId: 'operator-1', organizationId: 'org-1', status: 'active', roleIds: ['admin']}],
  roles: [{roleId: 'admin', organizationId: 'org-1', permissions}],
};
const auth = requiredPermission => ({subjectId: 'operator-1', organizationId: 'org-1',
  resourceOrganizationId: 'org-1', requiredPermission});

function fixture() {
  let sequence = 0;
  let now = 1_000;
  const documents = new Map();
  const provider = {providerOrganizationId: 'provider-1', organizationId: 'org-1',
    publicName: 'Acme Plumbing', status: 'active'};
  const service = {organizationId: 'org-1', serviceKey: 'pipe-repair', revision: 2,
    title: 'Emergency pipe repair', description: 'Repair leaking and burst household pipes.',
    status: 'published'};
  const options = {
    store: {
      getProvider: async () => provider,
      getPublishedService: async () => service,
      getDocument: async (organizationId, providerOrganizationId, serviceKey) =>
        documents.get([organizationId, providerOrganizationId, serviceKey].join(':')) ?? null,
      replaceDocument: async (current, replacement) => {
        const key = [replacement.organizationId, replacement.providerOrganizationId,
          replacement.serviceKey].join(':');
        if ((documents.get(key) ?? null) !== current) return false;
        documents.set(key, replacement);
        return true;
      },
      listDocuments: async organizationId => [...documents.values()]
        .filter(value => value.organizationId === organizationId),
    },
    audit: {sink: {append: async () => {}}, createOpaqueId: () => 'audit-' + (++sequence), now: () => now},
    createOpaqueId: () => 'search-' + (++sequence),
    now: () => now,
  };
  return {documents, options, provider, service, setNow: value => { now = value; }};
}

const input = {providerOrganizationId: 'provider-1', serviceKey: 'pipe-repair',
  keywords: ['emergency', 'plumbing'], qualityScore: 800};
const index = (value, changedInput = input, expectedVersion = 0,
  authorization = auth('search:write'), version = 1) =>
  indexSearchDocument(version, authorization, state, changedInput, expectedVersion, value.options);

test('indexes only canonical active provider and published service fields', async () => {
  const value = fixture();
  const result = await index(value);
  assert.equal(result.accepted, true);
  assert.equal(result.value.publicName, value.provider.publicName);
  assert.equal(result.value.title, value.service.title);
  assert.deepEqual(result.value.keywords, ['emergency', 'plumbing']);
  assert.equal(Object.isFrozen(result.value), true);
});

test('rejects unauthorized, malformed and inactive source indexing', async () => {
  assert.deepEqual(await index(fixture(), input, 0, auth('search:read')),
    {accepted: false, code: 'search_rejected'});
  assert.deepEqual(await index(fixture(), {...input, keywords: ['Pipe']}),
    {accepted: false, code: 'search_rejected'});
  assert.deepEqual(await index(fixture(), {...input, qualityScore: 1001}),
    {accepted: false, code: 'search_rejected'});
  assert.deepEqual(await index(fixture(), input, 0, auth('search:write'), 2),
    {accepted: false, code: 'search_rejected'});
  const inactive = fixture();
  inactive.provider.status = 'suspended';
  assert.deepEqual(await index(inactive), {accepted: false, code: 'search_rejected'});
  const draft = fixture();
  draft.service.status = 'draft';
  assert.deepEqual(await index(draft), {accepted: false, code: 'search_rejected'});
});

test('updates with optimistic concurrency and refreshes canonical revisions', async () => {
  const value = fixture();
  const created = await index(value);
  value.service.revision = 3;
  value.service.title = 'Priority pipe repair';
  value.setNow(2_000);
  const updated = await index(value, {...input, qualityScore: 900}, 1);
  assert.equal(updated.value.version, 2);
  assert.equal(updated.value.serviceRevision, 3);
  assert.equal(updated.value.title, 'Priority pipe repair');
  assert.deepEqual(await index(value, input, 1), {accepted: false, code: 'search_rejected'});
  assert.equal(created.value.searchDocumentId, updated.value.searchDocumentId);
});

test('ranks deterministically by coverage, weighted fields, quality and stable ties', async () => {
  const value = fixture();
  const first = await index(value);
  const second = {...first.value, searchDocumentId: 'search-z', providerOrganizationId: 'provider-2',
    publicName: 'Beta Services', title: 'Pipe inspection', keywords: ['inspection'], qualityScore: 100};
  value.documents.set('org-1:provider-2:pipe-repair', second);
  const result = await searchIndex(auth('search:read'), state,
    {text: 'emergency pipe', limit: 10}, value.options);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.value.map(hit => hit.searchDocumentId),
    [first.value.searchDocumentId, second.searchDocumentId]);
  assert.deepEqual(result.value[0].matchedTerms, ['emergency', 'pipe']);
  assert.ok(result.value[0].score > result.value[1].score);
});

test('enforces query bounds and tenant isolation without returning descriptions', async () => {
  const value = fixture();
  await index(value);
  assert.deepEqual(await searchIndex(auth('search:write'), state, {text: 'pipe', limit: 10}, value.options),
    {accepted: false, code: 'search_rejected'});
  assert.deepEqual(await searchIndex(auth('search:read'), state, {text: ' ', limit: 10}, value.options),
    {accepted: false, code: 'search_rejected'});
  assert.deepEqual(await searchIndex(auth('search:read'), state, {text: 'pipe', limit: 101}, value.options),
    {accepted: false, code: 'search_rejected'});
  const result = await searchIndex(auth('search:read'), state, {text: 'leaking', limit: 1}, value.options);
  assert.equal('description' in result.value[0], false);
});

test('fails closed on duplicate, cross-tenant, audit and persistence records', async () => {
  const duplicate = fixture();
  const created = await index(duplicate);
  duplicate.options.store.listDocuments = async () => [created.value, created.value];
  assert.deepEqual(await searchIndex(auth('search:read'), state, {text: 'pipe', limit: 10},
    duplicate.options), {accepted: false, code: 'search_rejected'});
  const contaminated = fixture();
  const indexed = await index(contaminated);
  contaminated.options.store.listDocuments = async () => [{...indexed.value, organizationId: 'org-2'}];
  assert.deepEqual(await searchIndex(auth('search:read'), state, {text: 'pipe', limit: 10},
    contaminated.options), {accepted: false, code: 'search_rejected'});
  const audit = fixture();
  audit.options.audit.sink.append = async () => { throw new Error('unavailable'); };
  assert.deepEqual(await index(audit), {accepted: false, code: 'search_rejected'});
  const persistence = fixture();
  persistence.options.store.replaceDocument = async () => { throw new Error('unavailable'); };
  assert.deepEqual(await index(persistence), {accepted: false, code: 'search_rejected'});
});
