import test from 'node:test';
import assert from 'node:assert/strict';
import {createLeadQuote, triageMatchedLead} from './lead-workflow.ts';

const state = {
  organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [{subjectId: 'operator-1', organizationId: 'org-1', status: 'active',
    roleIds: ['provider-role']}],
  roles: [{roleId: 'provider-role', organizationId: 'org-1',
    permissions: ['leads:triage', 'quotes:create']}],
};
const auth = permission => ({subjectId: 'operator-1', organizationId: 'org-1',
  resourceOrganizationId: 'org-1', requiredPermission: permission});
const triageInput = {requestKey: 'triage-1', leadId: 'lead-1',
  providerOrganizationId: 'provider-1', decision: 'interested', declineReasonCode: null};
const quoteInput = {requestKey: 'quote-1', leadId: 'lead-1',
  providerOrganizationId: 'provider-1', currency: 'USD',
  lineItems: [{label: 'Labor', amountMinor: 12_500}, {label: 'Parts', amountMinor: 3_500}],
  validUntil: 2_000_000};

function fixture() {
  let sequence = 0;
  let now = 1_000_000;
  let currentTriage = {triageId: 'triage-existing', organizationId: 'org-1',
    requestKey: 'triage-existing', leadId: 'lead-1', providerOrganizationId: 'provider-1',
    decision: 'interested', declineReasonCode: null, createdAt: 900_000};
  let triageReplay = null;
  let quoteReplay = null;
  let latestQuote = null;
  let committedTriage = null;
  let committedQuote = null;
  const options = {
    store: {
      getMatchedLead: async () => ({organizationId: 'org-1', leadId: 'lead-1',
        providerOrganizationId: 'provider-1', serviceRevision: 4, status: 'open'}),
      getProviderOperator: async () => ({organizationId: 'org-1',
        providerOrganizationId: 'provider-1', subjectId: 'operator-1', status: 'active',
        permissions: ['leads:triage', 'quotes:create']}),
      getTriageByRequestKey: async () => triageReplay,
      getCurrentTriage: async () => currentTriage,
      createTriage: async value => { committedTriage = value; currentTriage = value; return true; },
      getQuoteByRequestKey: async () => quoteReplay,
      getLatestQuote: async () => latestQuote,
      createQuote: async value => { committedQuote = value; latestQuote = value; return true; },
    },
    audit: {sink: {append: async () => {}}, createOpaqueId: () => 'audit-' + (++sequence),
      now: () => now},
    createOpaqueId: () => 'opaque-' + (++sequence),
    now: () => now,
  };
  return {options, setCurrentTriage: value => { currentTriage = value; },
    setTriageReplay: value => { triageReplay = value; },
    setQuoteReplay: value => { quoteReplay = value; },
    setLatestQuote: value => { latestQuote = value; },
    getCommittedTriage: () => committedTriage, getCommittedQuote: () => committedQuote,
    setNow: value => { now = value; }};
}

test('records one provider-bound triage decision with exact replay', async () => {
  const value = fixture();
  value.setCurrentTriage(null);
  const created = await triageMatchedLead(1, auth('leads:triage'), state, triageInput,
    value.options);
  assert.equal(created.accepted, true);
  assert.equal(created.replayed, false);
  assert.equal(Object.isFrozen(created.value), true);
  assert.equal(value.getCommittedTriage(), created.value);
  value.setTriageReplay(created.value);
  const replay = await triageMatchedLead(1, auth('leads:triage'), state, triageInput,
    value.options);
  assert.equal(replay.accepted, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.value, created.value);
});

test('requires valid decline reasons and rejects conflicting triage', async () => {
  const malformed = fixture();
  malformed.setCurrentTriage(null);
  assert.deepEqual(await triageMatchedLead(1, auth('leads:triage'), state,
    {...triageInput, decision: 'declined', declineReasonCode: null}, malformed.options),
  {accepted: false, code: 'lead_workflow_rejected'});
  const conflict = fixture();
  const existing = {...triageInput, triageId: 'triage-2', organizationId: 'org-1',
    decision: 'declined', declineReasonCode: 'capacity', createdAt: 900_000};
  conflict.setTriageReplay(existing);
  assert.deepEqual(await triageMatchedLead(1, auth('leads:triage'), state, triageInput,
    conflict.options), {accepted: false, code: 'lead_workflow_rejected'});
});

test('creates immutable minor-unit quotes and deterministic versions', async () => {
  const value = fixture();
  const first = await createLeadQuote(1, auth('quotes:create'), state, quoteInput, value.options);
  assert.equal(first.accepted, true);
  assert.equal(first.value.totalMinor, 16_000);
  assert.equal(first.value.version, 1);
  assert.equal(first.value.supersedesQuoteId, null);
  assert.equal(Object.isFrozen(first.value.lineItems), true);
  assert.equal(value.getCommittedQuote(), first.value);
  const second = await createLeadQuote(1, auth('quotes:create'), state,
    {...quoteInput, requestKey: 'quote-2', lineItems: [{label: 'Revised', amountMinor: 10_000}]},
    value.options);
  assert.equal(second.accepted, true);
  assert.equal(second.value.version, 2);
  assert.equal(second.value.supersedesQuoteId, first.value.quoteId);
});

test('replays an exact quote and rejects changed input for the same key', async () => {
  const value = fixture();
  const created = await createLeadQuote(1, auth('quotes:create'), state, quoteInput,
    value.options);
  value.setQuoteReplay(created.value);
  const replay = await createLeadQuote(1, auth('quotes:create'), state, quoteInput, value.options);
  assert.equal(replay.accepted, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.value, created.value);
  assert.deepEqual(await createLeadQuote(1, auth('quotes:create'), state,
    {...quoteInput, currency: 'CAD'}, value.options),
  {accepted: false, code: 'lead_workflow_rejected'});
});

test('rejects unauthorized, unmatched, cross-provider and untriaged quote attempts', async () => {
  assert.deepEqual(await createLeadQuote(1, auth('leads:triage'), state, quoteInput,
    fixture().options), {accepted: false, code: 'lead_workflow_rejected'});
  const unmatched = fixture();
  unmatched.options.store.getMatchedLead = async () => null;
  assert.deepEqual(await createLeadQuote(1, auth('quotes:create'), state, quoteInput,
    unmatched.options), {accepted: false, code: 'lead_workflow_rejected'});
  const provider = fixture();
  provider.options.store.getProviderOperator = async () => ({organizationId: 'org-1',
    providerOrganizationId: 'provider-2', subjectId: 'operator-1', status: 'active',
    permissions: ['quotes:create']});
  assert.deepEqual(await createLeadQuote(1, auth('quotes:create'), state, quoteInput,
    provider.options), {accepted: false, code: 'lead_workflow_rejected'});
  const declined = fixture();
  declined.setCurrentTriage({...triageInput, triageId: 'triage-3', organizationId: 'org-1',
    decision: 'declined', declineReasonCode: 'capacity', createdAt: 900_000});
  assert.deepEqual(await createLeadQuote(1, auth('quotes:create'), state, quoteInput,
    declined.options), {accepted: false, code: 'lead_workflow_rejected'});
});

test('rejects malformed money and expiry and fails closed on audit or persistence failure', async () => {
  assert.deepEqual(await createLeadQuote(1, auth('quotes:create'), state,
    {...quoteInput, lineItems: [{label: 'Bad', amountMinor: 1.5}]}, fixture().options),
  {accepted: false, code: 'lead_workflow_rejected'});
  assert.deepEqual(await createLeadQuote(1, auth('quotes:create'), state,
    {...quoteInput, validUntil: 1_000_000}, fixture().options),
  {accepted: false, code: 'lead_workflow_rejected'});
  const audit = fixture();
  audit.options.audit.sink.append = async () => { throw new Error('unavailable'); };
  assert.deepEqual(await createLeadQuote(1, auth('quotes:create'), state, quoteInput,
    audit.options), {accepted: false, code: 'lead_workflow_rejected'});
  const store = fixture();
  store.options.store.createQuote = async () => false;
  assert.deepEqual(await createLeadQuote(1, auth('quotes:create'), state, quoteInput,
    store.options), {accepted: false, code: 'lead_workflow_rejected'});
});
