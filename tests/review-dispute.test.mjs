import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEngagementReview,
  disputeEngagementReview,
  respondToEngagementReview,
} from '../packages/contracts/dist/review-dispute.js';

const state = {
  organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [
    {subjectId: 'customer-1', organizationId: 'org-1', status: 'active',
      roleIds: ['customer-role']},
    {subjectId: 'operator-1', organizationId: 'org-1', status: 'active',
      roleIds: ['provider-role']},
  ],
  roles: [
    {roleId: 'customer-role', organizationId: 'org-1',
      permissions: ['reviews:create', 'reviews:dispute']},
    {roleId: 'provider-role', organizationId: 'org-1',
      permissions: ['reviews:respond', 'reviews:dispute']},
  ],
};
const auth = (subjectId, permission) => ({subjectId, organizationId: 'org-1',
  resourceOrganizationId: 'org-1', requiredPermission: permission});
const reviewInput = {requestKey: 'review-1', engagementId: 'engagement-1', rating: 4,
  comment: 'Prompt service and a clear estimate.'};
const responseInput = {requestKey: 'response-1', reviewId: 'review-existing',
  response: 'Thank you for the detailed feedback.'};
const disputeInput = {requestKey: 'dispute-1', reviewId: 'review-existing',
  raisedBy: 'provider', reasonCode: 'wrong_engagement',
  statement: 'The attached completion record identifies a different engagement.',
  evidenceReferences: ['evidence-1']};

function fixture() {
  let sequence = 0;
  let reviewReplay = null;
  let engagementReview = null;
  let responseReplay = null;
  let reviewResponse = null;
  let disputeReplay = null;
  let reviewDispute = null;
  let committed = null;
  const review = {reviewId: 'review-existing', organizationId: 'org-1',
    requestKey: 'review-existing', engagementId: 'engagement-1',
    customerSubjectId: 'customer-1', providerOrganizationId: 'provider-1', rating: 4,
    comment: 'Prompt service and a clear estimate.', createdAt: 900_000};
  const options = {
    store: {
      getEngagement: async () => ({organizationId: 'org-1', engagementId: 'engagement-1',
        customerSubjectId: 'customer-1', providerOrganizationId: 'provider-1',
        status: 'completed', completedAt: 800_000}),
      getProviderOperator: async () => ({organizationId: 'org-1',
        providerOrganizationId: 'provider-1', subjectId: 'operator-1', status: 'active',
        permissions: ['reviews:respond', 'reviews:dispute']}),
      getReview: async () => review,
      getReviewByRequestKey: async () => reviewReplay,
      getReviewByEngagement: async () => engagementReview,
      createReview: async value => { committed = value; engagementReview = value; return true; },
      getResponseByRequestKey: async () => responseReplay,
      getResponseByReview: async () => reviewResponse,
      createResponse: async value => { committed = value; reviewResponse = value; return true; },
      getDisputeByRequestKey: async () => disputeReplay,
      getDisputeByReview: async () => reviewDispute,
      createDispute: async value => { committed = value; reviewDispute = value; return true; },
    },
    audit: {sink: {append: async () => {}}, createOpaqueId: () => 'audit-' + (++sequence),
      now: () => 1_000_000},
    createOpaqueId: () => 'opaque-' + (++sequence),
    now: () => 1_000_000,
  };
  return {options, review, committed: () => committed,
    setReviewReplay: value => { reviewReplay = value; },
    setEngagementReview: value => { engagementReview = value; },
    setResponseReplay: value => { responseReplay = value; },
    setReviewResponse: value => { reviewResponse = value; },
    setDisputeReplay: value => { disputeReplay = value; },
    setReviewDispute: value => { reviewDispute = value; }};
}

test('creates one immutable customer review for a completed engagement and replays exactly', async () => {
  const value = fixture();
  const created = await createEngagementReview(1, auth('customer-1', 'reviews:create'), state,
    reviewInput, value.options);
  assert.equal(created.accepted, true);
  assert.equal(created.replayed, false);
  assert.equal(Object.isFrozen(created.value), true);
  assert.equal(value.committed(), created.value);
  value.setReviewReplay(created.value);
  const replay = await createEngagementReview(1, auth('customer-1', 'reviews:create'), state,
    reviewInput, value.options);
  assert.equal(replay.accepted, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.value, created.value);
});

test('rejects non-customer, incomplete, duplicate, and malformed reviews', async () => {
  assert.deepEqual(await createEngagementReview(1, auth('operator-1', 'reviews:create'), state,
    reviewInput, fixture().options), {accepted: false, code: 'review_dispute_rejected'});
  const active = fixture();
  active.options.store.getEngagement = async () => ({organizationId: 'org-1',
    engagementId: 'engagement-1', customerSubjectId: 'customer-1',
    providerOrganizationId: 'provider-1', status: 'active', completedAt: null});
  assert.deepEqual(await createEngagementReview(1, auth('customer-1', 'reviews:create'), state,
    reviewInput, active.options), {accepted: false, code: 'review_dispute_rejected'});
  const duplicate = fixture();
  duplicate.setEngagementReview(duplicate.review);
  assert.deepEqual(await createEngagementReview(1, auth('customer-1', 'reviews:create'), state,
    reviewInput, duplicate.options), {accepted: false, code: 'review_dispute_rejected'});
  assert.deepEqual(await createEngagementReview(1, auth('customer-1', 'reviews:create'), state,
    {...reviewInput, rating: 6}, fixture().options),
  {accepted: false, code: 'review_dispute_rejected'});
});

test('allows only the bound active provider operator to post one response', async () => {
  const value = fixture();
  const created = await respondToEngagementReview(1,
    auth('operator-1', 'reviews:respond'), state, responseInput, value.options);
  assert.equal(created.accepted, true);
  assert.equal(created.value.providerOrganizationId, 'provider-1');
  assert.equal(value.committed(), created.value);
  value.setResponseReplay(created.value);
  const replay = await respondToEngagementReview(1,
    auth('operator-1', 'reviews:respond'), state, responseInput, value.options);
  assert.equal(replay.accepted, true);
  assert.equal(replay.replayed, true);
});

test('rejects cross-provider, conflicting, and unauthorized responses', async () => {
  const crossProvider = fixture();
  crossProvider.options.store.getProviderOperator = async () => ({organizationId: 'org-1',
    providerOrganizationId: 'provider-2', subjectId: 'operator-1', status: 'active',
    permissions: ['reviews:respond']});
  assert.deepEqual(await respondToEngagementReview(1,
    auth('operator-1', 'reviews:respond'), state, responseInput, crossProvider.options),
  {accepted: false, code: 'review_dispute_rejected'});
  const conflict = fixture();
  conflict.setReviewResponse({responseId: 'response-existing', organizationId: 'org-1',
    requestKey: 'another-key', reviewId: 'review-existing',
    providerOrganizationId: 'provider-1', responderSubjectId: 'operator-1',
    response: 'Existing response', createdAt: 900_000});
  assert.deepEqual(await respondToEngagementReview(1,
    auth('operator-1', 'reviews:respond'), state, responseInput, conflict.options),
  {accepted: false, code: 'review_dispute_rejected'});
  assert.deepEqual(await respondToEngagementReview(1,
    auth('customer-1', 'reviews:create'), state, responseInput, fixture().options),
  {accepted: false, code: 'review_dispute_rejected'});
});

test('opens one immutable evidence-bound dispute for either verified party', async () => {
  const provider = fixture();
  const created = await disputeEngagementReview(1,
    auth('operator-1', 'reviews:dispute'), state, disputeInput, provider.options);
  assert.equal(created.accepted, true);
  assert.equal(created.value.status, 'open');
  assert.equal(Object.isFrozen(created.value.evidenceReferences), true);
  provider.setDisputeReplay(created.value);
  const replay = await disputeEngagementReview(1,
    auth('operator-1', 'reviews:dispute'), state, disputeInput, provider.options);
  assert.equal(replay.accepted, true);
  assert.equal(replay.replayed, true);

  const customer = fixture();
  const customerDispute = await disputeEngagementReview(1,
    auth('customer-1', 'reviews:dispute'), state,
    {...disputeInput, requestKey: 'dispute-2', raisedBy: 'customer'}, customer.options);
  assert.equal(customerDispute.accepted, true);
  assert.equal(customerDispute.value.raisedBySubjectId, 'customer-1');
});

test('rejects identity confusion, contaminated records, bad evidence, audit and storage failure', async () => {
  assert.deepEqual(await disputeEngagementReview(1,
    auth('customer-1', 'reviews:dispute'), state, disputeInput, fixture().options),
  {accepted: false, code: 'review_dispute_rejected'});
  const contaminated = fixture();
  contaminated.options.store.getReview = async () =>
    ({...contaminated.review, organizationId: 'org-2'});
  assert.deepEqual(await disputeEngagementReview(1,
    auth('operator-1', 'reviews:dispute'), state, disputeInput, contaminated.options),
  {accepted: false, code: 'review_dispute_rejected'});
  assert.deepEqual(await disputeEngagementReview(1,
    auth('operator-1', 'reviews:dispute'), state,
    {...disputeInput, evidenceReferences: ['same', 'same']}, fixture().options),
  {accepted: false, code: 'review_dispute_rejected'});
  const audit = fixture();
  audit.options.audit.sink.append = async () => { throw new Error('unavailable'); };
  assert.deepEqual(await disputeEngagementReview(1,
    auth('operator-1', 'reviews:dispute'), state, disputeInput, audit.options),
  {accepted: false, code: 'review_dispute_rejected'});
  const store = fixture();
  store.options.store.createDispute = async () => false;
  assert.deepEqual(await disputeEngagementReview(1,
    auth('operator-1', 'reviews:dispute'), state, disputeInput, store.options),
  {accepted: false, code: 'review_dispute_rejected'});
});
