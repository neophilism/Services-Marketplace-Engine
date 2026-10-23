import {
  authorizeAndAuditOrganizationAction,
  type TenantAuditOptions,
} from './audit.js';
import type {
  OrganizationAuthorizationRequest,
  OrganizationAuthorizationState,
} from './rbac.js';

export const REVIEW_DISPUTE_CONTRACT_VERSION = 1 as const;
export const REVIEW_DISPUTE_REJECTED = 'review_dispute_rejected' as const;

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const REQUEST_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const REASON_CODE = /^[a-z][a-z0-9_]{1,63}$/;

export interface CompletedEngagement {
  readonly organizationId: string;
  readonly engagementId: string;
  readonly customerSubjectId: string;
  readonly providerOrganizationId: string;
  readonly status: 'active' | 'completed' | 'cancelled';
  readonly completedAt: number | null;
}

export interface ReviewProviderOperator {
  readonly organizationId: string;
  readonly providerOrganizationId: string;
  readonly subjectId: string;
  readonly status: 'active' | 'inactive';
  readonly permissions: readonly string[];
}

export interface EngagementReview {
  readonly reviewId: string;
  readonly organizationId: string;
  readonly requestKey: string;
  readonly engagementId: string;
  readonly customerSubjectId: string;
  readonly providerOrganizationId: string;
  readonly rating: number;
  readonly comment: string;
  readonly createdAt: number;
}

export interface ReviewResponse {
  readonly responseId: string;
  readonly organizationId: string;
  readonly requestKey: string;
  readonly reviewId: string;
  readonly providerOrganizationId: string;
  readonly responderSubjectId: string;
  readonly response: string;
  readonly createdAt: number;
}

export interface ReviewDispute {
  readonly disputeId: string;
  readonly organizationId: string;
  readonly requestKey: string;
  readonly reviewId: string;
  readonly raisedBy: 'customer' | 'provider';
  readonly raisedBySubjectId: string;
  readonly reasonCode: string;
  readonly statement: string;
  readonly evidenceReferences: readonly string[];
  readonly status: 'open';
  readonly createdAt: number;
}

export interface ReviewInput {
  readonly requestKey: string;
  readonly engagementId: string;
  readonly rating: number;
  readonly comment: string;
}

export interface ReviewResponseInput {
  readonly requestKey: string;
  readonly reviewId: string;
  readonly response: string;
}

export interface ReviewDisputeInput {
  readonly requestKey: string;
  readonly reviewId: string;
  readonly raisedBy: 'customer' | 'provider';
  readonly reasonCode: string;
  readonly statement: string;
  readonly evidenceReferences: readonly string[];
}

export interface ReviewDisputeStore {
  getEngagement(organizationId: string, engagementId: string): Promise<CompletedEngagement | null>;
  getProviderOperator(organizationId: string, providerOrganizationId: string,
    subjectId: string): Promise<ReviewProviderOperator | null>;
  getReview(organizationId: string, reviewId: string): Promise<EngagementReview | null>;
  getReviewByRequestKey(organizationId: string,
    requestKey: string): Promise<EngagementReview | null>;
  getReviewByEngagement(organizationId: string,
    engagementId: string): Promise<EngagementReview | null>;
  createReview(value: EngagementReview): Promise<boolean>;
  getResponseByRequestKey(organizationId: string,
    requestKey: string): Promise<ReviewResponse | null>;
  getResponseByReview(organizationId: string, reviewId: string): Promise<ReviewResponse | null>;
  createResponse(value: ReviewResponse): Promise<boolean>;
  getDisputeByRequestKey(organizationId: string,
    requestKey: string): Promise<ReviewDispute | null>;
  getDisputeByReview(organizationId: string, reviewId: string): Promise<ReviewDispute | null>;
  createDispute(value: ReviewDispute): Promise<boolean>;
}

export interface ReviewDisputeOptions {
  readonly store: ReviewDisputeStore;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
}

export type ReviewDisputeResult<T> =
  | {readonly accepted: true; readonly value: T; readonly replayed: boolean}
  | {readonly accepted: false; readonly code: typeof REVIEW_DISPUTE_REJECTED};

const rejected = <T>(): ReviewDisputeResult<T> => ({
  accepted: false,
  code: REVIEW_DISPUTE_REJECTED,
});

const timestamp = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const validText = (value: string, maximum: number): boolean =>
  value === value.trim() && value.length >= 1 && value.length <= maximum;

function validReviewInput(value: ReviewInput): boolean {
  return REQUEST_KEY.test(value.requestKey) && IDENTIFIER.test(value.engagementId) &&
    Number.isSafeInteger(value.rating) && value.rating >= 1 && value.rating <= 5 &&
    validText(value.comment, 2_000);
}

function validResponseInput(value: ReviewResponseInput): boolean {
  return REQUEST_KEY.test(value.requestKey) && IDENTIFIER.test(value.reviewId) &&
    validText(value.response, 2_000);
}

function validDisputeInput(value: ReviewDisputeInput): boolean {
  return REQUEST_KEY.test(value.requestKey) && IDENTIFIER.test(value.reviewId) &&
    (value.raisedBy === 'customer' || value.raisedBy === 'provider') &&
    REASON_CODE.test(value.reasonCode) && validText(value.statement, 4_000) &&
    value.evidenceReferences.length <= 10 &&
    new Set(value.evidenceReferences).size === value.evidenceReferences.length &&
    value.evidenceReferences.every(reference => IDENTIFIER.test(reference));
}

function boundEngagement(value: CompletedEngagement | null, organizationId: string,
  engagementId: string): value is CompletedEngagement {
  return value?.organizationId === organizationId && value.engagementId === engagementId &&
    IDENTIFIER.test(value.customerSubjectId) && IDENTIFIER.test(value.providerOrganizationId) &&
    value.status === 'completed' && value.completedAt !== null && timestamp(value.completedAt);
}

function boundOperator(value: ReviewProviderOperator | null, organizationId: string,
  providerOrganizationId: string, subjectId: string, permission: string): boolean {
  return value?.organizationId === organizationId &&
    value.providerOrganizationId === providerOrganizationId &&
    value.subjectId === subjectId && value.status === 'active' &&
    value.permissions.includes(permission);
}

function validStoredReview(value: EngagementReview, organizationId: string): boolean {
  return value.organizationId === organizationId && IDENTIFIER.test(value.reviewId) &&
    REQUEST_KEY.test(value.requestKey) && IDENTIFIER.test(value.engagementId) &&
    IDENTIFIER.test(value.customerSubjectId) && IDENTIFIER.test(value.providerOrganizationId) &&
    Number.isSafeInteger(value.rating) && value.rating >= 1 && value.rating <= 5 &&
    validText(value.comment, 2_000) && timestamp(value.createdAt);
}

function boundReview(value: EngagementReview | null, organizationId: string,
  input: ReviewInput, subjectId: string): value is EngagementReview {
  return value !== null && validStoredReview(value, organizationId) &&
    value.requestKey === input.requestKey && value.engagementId === input.engagementId &&
    value.customerSubjectId === subjectId && value.rating === input.rating &&
    value.comment === input.comment;
}

function boundResponse(value: ReviewResponse | null, organizationId: string,
  input: ReviewResponseInput, review: EngagementReview,
  subjectId: string): value is ReviewResponse {
  return value?.organizationId === organizationId && value.requestKey === input.requestKey &&
    value.reviewId === review.reviewId &&
    value.providerOrganizationId === review.providerOrganizationId &&
    value.responderSubjectId === subjectId && value.response === input.response &&
    IDENTIFIER.test(value.responseId) && timestamp(value.createdAt);
}

function boundDispute(value: ReviewDispute | null, organizationId: string,
  input: ReviewDisputeInput, subjectId: string): value is ReviewDispute {
  return value?.organizationId === organizationId && value.requestKey === input.requestKey &&
    value.reviewId === input.reviewId && value.raisedBy === input.raisedBy &&
    value.raisedBySubjectId === subjectId && value.reasonCode === input.reasonCode &&
    value.statement === input.statement && value.status === 'open' &&
    IDENTIFIER.test(value.disputeId) && timestamp(value.createdAt) &&
    value.evidenceReferences.length === input.evidenceReferences.length &&
    value.evidenceReferences.every((reference, index) =>
      reference === input.evidenceReferences[index]);
}

async function authorize(request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState, action: string, permission: string,
  options: ReviewDisputeOptions): Promise<{organizationId: string; subjectId: string} | null> {
  const result = await authorizeAndAuditOrganizationAction(request, state, action, options.audit);
  return result.authorized && request.requiredPermission === permission
    ? {organizationId: result.organizationId, subjectId: result.subjectId} : null;
}

export async function createEngagementReview(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: ReviewInput, options: ReviewDisputeOptions): Promise<ReviewDisputeResult<EngagementReview>> {
  const identity = await authorize(request, state, 'review.create', 'reviews:create', options);
  const now = options.now();
  if (!identity || contractVersion !== REVIEW_DISPUTE_CONTRACT_VERSION || !timestamp(now) ||
    !validReviewInput(input)) return rejected();
  try {
    const [engagement, existing, engagementReview] = await Promise.all([
      options.store.getEngagement(identity.organizationId, input.engagementId),
      options.store.getReviewByRequestKey(identity.organizationId, input.requestKey),
      options.store.getReviewByEngagement(identity.organizationId, input.engagementId),
    ]);
    if (!boundEngagement(engagement, identity.organizationId, input.engagementId) ||
      engagement.customerSubjectId !== identity.subjectId) return rejected();
    if (existing !== null) return boundReview(existing, identity.organizationId, input,
      identity.subjectId) ? {accepted: true, value: existing, replayed: true} : rejected();
    if (engagementReview !== null) return rejected();
    const reviewId = options.createOpaqueId();
    if (!IDENTIFIER.test(reviewId)) return rejected();
    const review = Object.freeze({
      reviewId, organizationId: identity.organizationId, requestKey: input.requestKey,
      engagementId: input.engagementId, customerSubjectId: identity.subjectId,
      providerOrganizationId: engagement.providerOrganizationId, rating: input.rating,
      comment: input.comment, createdAt: now,
    });
    if (!await options.store.createReview(review)) return rejected();
    return {accepted: true, value: review, replayed: false};
  } catch {
    return rejected();
  }
}

export async function respondToEngagementReview(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: ReviewResponseInput,
  options: ReviewDisputeOptions): Promise<ReviewDisputeResult<ReviewResponse>> {
  const identity = await authorize(request, state, 'review.respond', 'reviews:respond', options);
  const now = options.now();
  if (!identity || contractVersion !== REVIEW_DISPUTE_CONTRACT_VERSION || !timestamp(now) ||
    !validResponseInput(input)) return rejected();
  try {
    const review = await options.store.getReview(identity.organizationId, input.reviewId);
    if (review === null || !validStoredReview(review, identity.organizationId)) return rejected();
    const [operator, existing, reviewResponse] = await Promise.all([
      options.store.getProviderOperator(identity.organizationId,
        review.providerOrganizationId, identity.subjectId),
      options.store.getResponseByRequestKey(identity.organizationId, input.requestKey),
      options.store.getResponseByReview(identity.organizationId, input.reviewId),
    ]);
    if (!boundOperator(operator, identity.organizationId, review.providerOrganizationId,
      identity.subjectId, 'reviews:respond')) return rejected();
    if (existing !== null) return boundResponse(existing, identity.organizationId, input,
      review, identity.subjectId) ? {accepted: true, value: existing, replayed: true} : rejected();
    if (reviewResponse !== null) return rejected();
    const responseId = options.createOpaqueId();
    if (!IDENTIFIER.test(responseId)) return rejected();
    const response = Object.freeze({
      responseId, organizationId: identity.organizationId, requestKey: input.requestKey,
      reviewId: input.reviewId, providerOrganizationId: review.providerOrganizationId,
      responderSubjectId: identity.subjectId, response: input.response, createdAt: now,
    });
    if (!await options.store.createResponse(response)) return rejected();
    return {accepted: true, value: response, replayed: false};
  } catch {
    return rejected();
  }
}

export async function disputeEngagementReview(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: ReviewDisputeInput,
  options: ReviewDisputeOptions): Promise<ReviewDisputeResult<ReviewDispute>> {
  const identity = await authorize(request, state, 'review.dispute', 'reviews:dispute', options);
  const now = options.now();
  if (!identity || contractVersion !== REVIEW_DISPUTE_CONTRACT_VERSION || !timestamp(now) ||
    !validDisputeInput(input)) return rejected();
  try {
    const review = await options.store.getReview(identity.organizationId, input.reviewId);
    if (review === null || !validStoredReview(review, identity.organizationId)) return rejected();
    const engagement = await options.store.getEngagement(identity.organizationId,
      review.engagementId);
    if (!boundEngagement(engagement, identity.organizationId, review.engagementId) ||
      engagement.customerSubjectId !== review.customerSubjectId ||
      engagement.providerOrganizationId !== review.providerOrganizationId) return rejected();
    if (input.raisedBy === 'customer' && identity.subjectId !== review.customerSubjectId) {
      return rejected();
    }
    if (input.raisedBy === 'provider') {
      const operator = await options.store.getProviderOperator(identity.organizationId,
        review.providerOrganizationId, identity.subjectId);
      if (!boundOperator(operator, identity.organizationId, review.providerOrganizationId,
        identity.subjectId, 'reviews:dispute')) return rejected();
    }
    const [existing, reviewDispute] = await Promise.all([
      options.store.getDisputeByRequestKey(identity.organizationId, input.requestKey),
      options.store.getDisputeByReview(identity.organizationId, input.reviewId),
    ]);
    if (existing !== null) return boundDispute(existing, identity.organizationId, input,
      identity.subjectId) ? {accepted: true, value: existing, replayed: true} : rejected();
    if (reviewDispute !== null) return rejected();
    const disputeId = options.createOpaqueId();
    if (!IDENTIFIER.test(disputeId)) return rejected();
    const evidenceReferences = Object.freeze([...input.evidenceReferences]);
    const dispute = Object.freeze({
      disputeId, organizationId: identity.organizationId, requestKey: input.requestKey,
      reviewId: input.reviewId, raisedBy: input.raisedBy,
      raisedBySubjectId: identity.subjectId, reasonCode: input.reasonCode,
      statement: input.statement, evidenceReferences, status: 'open' as const, createdAt: now,
    });
    if (!await options.store.createDispute(dispute)) return rejected();
    return {accepted: true, value: dispute, replayed: false};
  } catch {
    return rejected();
  }
}
