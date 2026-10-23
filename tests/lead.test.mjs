import test from 'node:test';
import assert from 'node:assert/strict';
import {createMatchedLead} from '../packages/contracts/dist/lead.js';

const permissions = ['leads:create'];
const state = {
  organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [{subjectId: 'operator-1', organizationId: 'org-1', status: 'active',
    roleIds: ['admin']}],
  roles: [{roleId: 'admin', organizationId: 'org-1', permissions}],
};
const auth = requiredPermission => ({subjectId: 'operator-1', organizationId: 'org-1',
  resourceOrganizationId: 'org-1', requiredPermission});
const input = {requestKey: 'request-1', customerProfileId: 'customer-1',
  serviceKey: 'pipe-repair', summary: 'Replace a leaking supply line.',
  requestedStartAt: 2_000_000, requestedEndAt: 3_000_000, maximumMatches: 2};

function fixture() {
  let sequence = 0;
  let now = 1_000_000;
  let existing = null;
  let committed = null;
  const customer = {customerProfileId: 'customer-1', organizationId: 'org-1',
    status: 'active'};
  const service = {organizationId: 'org-1', serviceKey: 'pipe-repair', revision: 4,
    status: 'published'};
  let candidates = [
    {organizationId: 'org-1', providerOrganizationId: 'provider-b',
      serviceKey: 'pipe-repair', serviceRevision: 4, status: 'active', eligible: true,
      rankScore: 900, notificationRecipientId: 'recipient-b'},
    {organizationId: 'org-1', providerOrganizationId: 'provider-a',
      serviceKey: 'pipe-repair', serviceRevision: 4, status: 'active', eligible: true,
      rankScore: 900, notificationRecipientId: 'recipient-a'},
    {organizationId: 'org-1', providerOrganizationId: 'provider-c',
      serviceKey: 'pipe-repair', serviceRevision: 4, status: 'active', eligible: true,
      rankScore: 800, notificationRecipientId: 'recipient-c'},
  ];
  const options = {
    store: {
      getCustomer: async () => customer,
      getPublishedService: async () => service,
      getLeadByRequestKey: async () => existing,
      listMatchingCandidates: async () => candidates,
      createLead: async (lead, notifications) => {
        if (committed !== null) return false;
        committed = {lead, notifications};
        return true;
      },
    },
    audit: {sink: {append: async () => {}}, createOpaqueId: () => 'audit-' + (++sequence),
      now: () => now},
    createOpaqueId: () => 'opaque-' + (++sequence),
    now: () => now,
  };
  return {options, customer, service, setCandidates: value => { candidates = value; },
    setExisting: value => { existing = value; }, getCommitted: () => committed,
    setNow: value => { now = value; }};
}

const create = (value, changedInput = input, authorization = auth('leads:create'), version = 1) =>
  createMatchedLead(version, authorization, state, changedInput, value.options);

test('creates an immutable lead, stable matches and metadata-only notifications atomically', async () => {
  const value = fixture();
  const result = await create(value);
  assert.equal(result.accepted, true);
  assert.equal(result.value.replayed, false);
  assert.deepEqual(result.value.lead.matches.map(match => match.providerOrganizationId),
    ['provider-a', 'provider-b']);
  assert.deepEqual(result.value.notifications.map(notification => notification.recipientId),
    ['recipient-a', 'recipient-b']);
  assert.equal('summary' in result.value.notifications[0], false);
  assert.equal(Object.isFrozen(result.value.lead), true);
  assert.equal(Object.isFrozen(result.value.lead.matches), true);
  assert.equal(value.getCommitted().lead, result.value.lead);
  assert.equal(value.getCommitted().notifications, result.value.notifications);
});

test('replays an exact request without matching, mutation or duplicate notifications', async () => {
  const value = fixture();
  const created = await create(value);
  value.setExisting(created.value.lead);
  value.options.store.listMatchingCandidates = async () => { throw new Error('must not run'); };
  value.options.store.createLead = async () => { throw new Error('must not run'); };
  const replay = await create(value);
  assert.equal(replay.accepted, true);
  assert.equal(replay.value.replayed, true);
  assert.equal(replay.value.lead, created.value.lead);
  assert.deepEqual(replay.value.notifications, []);
});

test('rejects unauthorized, malformed, expired and mismatched replay requests', async () => {
  assert.deepEqual(await create(fixture(), input, auth('leads:read')),
    {accepted: false, code: 'lead_rejected'});
  assert.deepEqual(await create(fixture(), {...input, summary: ' padded '}),
    {accepted: false, code: 'lead_rejected'});
  assert.deepEqual(await create(fixture(), {...input, requestedStartAt: 500_000}),
    {accepted: false, code: 'lead_rejected'});
  assert.deepEqual(await create(fixture(), input, auth('leads:create'), 2),
    {accepted: false, code: 'lead_rejected'});
  const replay = fixture();
  const created = await create(replay);
  replay.setExisting({...created.value.lead, summary: 'Different request'});
  assert.deepEqual(await create(replay), {accepted: false, code: 'lead_rejected'});
  const matchLimit = fixture();
  const limited = await create(matchLimit);
  matchLimit.setExisting(limited.value.lead);
  assert.deepEqual(await create(matchLimit, {...input, maximumMatches: 3}),
    {accepted: false, code: 'lead_rejected'});
});

test('requires active tenant-bound canonical customer and published service revision', async () => {
  const customer = fixture();
  customer.customer.status = 'inactive';
  assert.deepEqual(await create(customer), {accepted: false, code: 'lead_rejected'});
  const service = fixture();
  service.service.status = 'retired';
  assert.deepEqual(await create(service), {accepted: false, code: 'lead_rejected'});
  const contaminated = fixture();
  contaminated.service.organizationId = 'org-2';
  assert.deepEqual(await create(contaminated), {accepted: false, code: 'lead_rejected'});
});

test('fails closed on contaminated, stale, duplicate and oversized matcher output', async () => {
  const contaminated = fixture();
  contaminated.setCandidates([{organizationId: 'org-2', providerOrganizationId: 'provider-a',
    serviceKey: 'pipe-repair', serviceRevision: 4, status: 'active', eligible: true,
    rankScore: 900, notificationRecipientId: 'recipient-a'}]);
  assert.deepEqual(await create(contaminated), {accepted: false, code: 'lead_rejected'});
  const stale = fixture();
  stale.setCandidates([{organizationId: 'org-1', providerOrganizationId: 'provider-a',
    serviceKey: 'pipe-repair', serviceRevision: 3, status: 'active', eligible: true,
    rankScore: 900, notificationRecipientId: 'recipient-a'}]);
  assert.deepEqual(await create(stale), {accepted: false, code: 'lead_rejected'});
  const duplicate = fixture();
  duplicate.setCandidates([
    {organizationId: 'org-1', providerOrganizationId: 'provider-a',
      serviceKey: 'pipe-repair', serviceRevision: 4, status: 'active', eligible: true,
      rankScore: 900, notificationRecipientId: 'recipient-a'},
    {organizationId: 'org-1', providerOrganizationId: 'provider-a',
      serviceKey: 'pipe-repair', serviceRevision: 4, status: 'active', eligible: true,
      rankScore: 800, notificationRecipientId: 'recipient-b'},
  ]);
  assert.deepEqual(await create(duplicate), {accepted: false, code: 'lead_rejected'});
  const oversized = fixture();
  oversized.setCandidates(Array.from({length: 1_001}, (_, index) => ({
    organizationId: 'org-1', providerOrganizationId: 'provider-' + index,
    serviceKey: 'pipe-repair', serviceRevision: 4, status: 'active', eligible: true,
    rankScore: 1, notificationRecipientId: 'recipient-' + index,
  })));
  assert.deepEqual(await create(oversized), {accepted: false, code: 'lead_rejected'});
});

test('accepts no matches and fails closed on audit, matcher and transaction failures', async () => {
  const empty = fixture();
  empty.setCandidates([]);
  const result = await create(empty);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.value.lead.matches, []);
  assert.deepEqual(result.value.notifications, []);
  const audit = fixture();
  audit.options.audit.sink.append = async () => { throw new Error('unavailable'); };
  assert.deepEqual(await create(audit), {accepted: false, code: 'lead_rejected'});
  const matcher = fixture();
  matcher.options.store.listMatchingCandidates = async () => { throw new Error('unavailable'); };
  assert.deepEqual(await create(matcher), {accepted: false, code: 'lead_rejected'});
  const transaction = fixture();
  transaction.options.store.createLead = async () => false;
  assert.deepEqual(await create(transaction), {accepted: false, code: 'lead_rejected'});
  const duplicateIds = fixture();
  duplicateIds.options.createOpaqueId = () => 'same-id';
  assert.deepEqual(await create(duplicateIds), {accepted: false, code: 'lead_rejected'});
});
