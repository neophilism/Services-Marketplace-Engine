import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const KNOWLEDGE_BASE_CONTRACT_VERSION = 1 as const;
export const KNOWLEDGE_BASE_REJECTED = 'knowledge_base_rejected' as const;

export type KnowledgeBaseArticleStatus = 'draft' | 'published' | 'archived';

export interface KnowledgeBaseOperator {
  readonly organizationId: string;
  readonly subjectId: string;
  readonly status: 'active' | 'inactive';
  readonly permissions: readonly string[];
}

export interface KnowledgeBaseArticleRevision {
  readonly revisionId: string;
  readonly organizationId: string;
  readonly requestKey: string;
  readonly articleKey: string;
  readonly locale: string;
  readonly title: string;
  readonly contentReference: string;
  readonly contentDigest: string;
  readonly status: KnowledgeBaseArticleStatus;
  readonly revision: number;
  readonly actorSubjectId: string;
  readonly updatedAt: number;
  readonly publishedAt: number | null;
}

export interface ReviseKnowledgeBaseArticleInput {
  readonly requestKey: string;
  readonly articleKey: string;
  readonly locale: string;
  readonly title: string;
  readonly contentReference: string;
  readonly contentDigest: string;
  readonly status: KnowledgeBaseArticleStatus;
  readonly expectedRevision: number;
}

export interface KnowledgeBaseStore {
  getOperator(organizationId: string, subjectId: string): Promise<KnowledgeBaseOperator | null>;
  getCurrent(organizationId: string, articleKey: string, locale: string):
    Promise<KnowledgeBaseArticleRevision | null>;
  getByRequestKey(organizationId: string, requestKey: string):
    Promise<KnowledgeBaseArticleRevision | null>;
  commit(current: KnowledgeBaseArticleRevision | null,
    revision: KnowledgeBaseArticleRevision): Promise<boolean>;
}

export interface KnowledgeBaseOptions {
  readonly store: KnowledgeBaseStore;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
}

export type KnowledgeBaseResult =
  | {readonly accepted: true; readonly value: KnowledgeBaseArticleRevision;
      readonly replayed: boolean}
  | {readonly accepted: false; readonly code: typeof KNOWLEDGE_BASE_REJECTED};

export type PublishedKnowledgeBaseArticle =
  | {readonly accepted: true; readonly value: KnowledgeBaseArticleRevision}
  | {readonly accepted: false; readonly code: typeof KNOWLEDGE_BASE_REJECTED};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ARTICLE_KEY = /^[a-z0-9]+(?:-[a-z0-9]+){0,15}$/;
const LOCALE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
const DIGEST = /^[a-f0-9]{64}$/;
const STATUSES = new Set<KnowledgeBaseArticleStatus>(['draft', 'published', 'archived']);
const DATE = 8_640_000_000_000_000;
const rejected = (): KnowledgeBaseResult =>
  ({accepted: false, code: KNOWLEDGE_BASE_REJECTED});
const readRejected = (): PublishedKnowledgeBaseArticle =>
  ({accepted: false, code: KNOWLEDGE_BASE_REJECTED});
const integer = (value: number, minimum: number, maximum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const validTitle = (value: string): boolean => value.length >= 1 && value.length <= 160 &&
  value === value.trim() && !/[<>\u0000-\u001f\u007f]/.test(value);

function validRevision(value: KnowledgeBaseArticleRevision | null,
  organizationId: string): value is KnowledgeBaseArticleRevision {
  return value?.organizationId === organizationId && ID.test(value.revisionId) &&
    ID.test(value.requestKey) && ARTICLE_KEY.test(value.articleKey) &&
    LOCALE.test(value.locale) && validTitle(value.title) && ID.test(value.contentReference) &&
    DIGEST.test(value.contentDigest) && STATUSES.has(value.status) &&
    integer(value.revision, 1, Number.MAX_SAFE_INTEGER) && ID.test(value.actorSubjectId) &&
    integer(value.updatedAt, 0, DATE) &&
    (value.status === 'published'
      ? value.publishedAt === value.updatedAt
      : value.publishedAt === null);
}

function allowedTransition(current: KnowledgeBaseArticleRevision | null,
  status: KnowledgeBaseArticleStatus): boolean {
  if (current === null) return status === 'draft';
  if (current.status === 'archived') return false;
  if (current.status === 'draft') return status === 'draft' || status === 'published';
  return status === 'draft' || status === 'published' || status === 'archived';
}

function exactReplay(value: KnowledgeBaseArticleRevision,
  input: ReviseKnowledgeBaseArticleInput): boolean {
  return value.requestKey === input.requestKey && value.articleKey === input.articleKey &&
    value.locale === input.locale && value.title === input.title &&
    value.contentReference === input.contentReference &&
    value.contentDigest === input.contentDigest && value.status === input.status &&
    value.revision === input.expectedRevision + 1;
}

export async function reviseKnowledgeBaseArticle(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: ReviseKnowledgeBaseArticleInput, options: KnowledgeBaseOptions):
  Promise<KnowledgeBaseResult> {
  const authorization = await authorizeAndAuditOrganizationAction(
    request, state, 'knowledge-base.revise', options.audit);
  const now = options.now();
  if (!authorization.authorized || request.requiredPermission !== 'knowledge-base:write' ||
    contractVersion !== KNOWLEDGE_BASE_CONTRACT_VERSION || !ID.test(input.requestKey) ||
    !ARTICLE_KEY.test(input.articleKey) || !LOCALE.test(input.locale) ||
    !validTitle(input.title) || !ID.test(input.contentReference) ||
    !DIGEST.test(input.contentDigest) || !STATUSES.has(input.status) ||
    !integer(input.expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1) ||
    !integer(now, 0, DATE)) return rejected();

  try {
    const [operator, current, replay] = await Promise.all([
      options.store.getOperator(authorization.organizationId, authorization.subjectId),
      options.store.getCurrent(authorization.organizationId, input.articleKey, input.locale),
      options.store.getByRequestKey(authorization.organizationId, input.requestKey),
    ]);
    if (operator?.organizationId !== authorization.organizationId ||
      operator.subjectId !== authorization.subjectId || operator.status !== 'active' ||
      !operator.permissions.includes('knowledge-base:write')) return rejected();
    if (replay !== null) return validRevision(replay, authorization.organizationId) &&
      replay.actorSubjectId === authorization.subjectId && exactReplay(replay, input)
      ? {accepted: true, value: replay, replayed: true} : rejected();
    if ((current === null && input.expectedRevision !== 0) ||
      (current !== null && (!validRevision(current, authorization.organizationId) ||
        current.articleKey !== input.articleKey || current.locale !== input.locale ||
        current.revision !== input.expectedRevision || current.updatedAt > now)) ||
      !allowedTransition(current, input.status)) return rejected();

    const revisionId = options.createOpaqueId();
    if (!ID.test(revisionId)) return rejected();
    const revision = Object.freeze({
      revisionId, organizationId: authorization.organizationId,
      requestKey: input.requestKey, articleKey: input.articleKey, locale: input.locale,
      title: input.title, contentReference: input.contentReference,
      contentDigest: input.contentDigest, status: input.status,
      revision: input.expectedRevision + 1, actorSubjectId: authorization.subjectId,
      updatedAt: now, publishedAt: input.status === 'published' ? now : null,
    });
    return validRevision(revision, authorization.organizationId) &&
      await options.store.commit(current, revision)
      ? {accepted: true, value: revision, replayed: false} : rejected();
  } catch {
    return rejected();
  }
}

export function resolvePublishedKnowledgeBaseArticle(contractVersion: number,
  organizationId: string, articleKey: string, locale: string,
  revision: KnowledgeBaseArticleRevision | null): PublishedKnowledgeBaseArticle {
  if (contractVersion !== KNOWLEDGE_BASE_CONTRACT_VERSION || !ID.test(organizationId) ||
    !ARTICLE_KEY.test(articleKey) || !LOCALE.test(locale) ||
    !validRevision(revision, organizationId) || revision.articleKey !== articleKey ||
    revision.locale !== locale || revision.status !== 'published') return readRejected();
  return {accepted: true, value: revision};
}
