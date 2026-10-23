import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const SEARCH_CONTRACT_VERSION = 1 as const;
export const SEARCH_REJECTED = 'search_rejected' as const;

export interface SearchProvider {
  readonly providerOrganizationId: string;
  readonly organizationId: string;
  readonly publicName: string;
  readonly status: 'draft' | 'active' | 'suspended' | 'closed';
}

export interface SearchService {
  readonly organizationId: string;
  readonly serviceKey: string;
  readonly revision: number;
  readonly title: string;
  readonly description: string;
  readonly status: 'draft' | 'published' | 'retired';
}

export interface SearchDocument {
  readonly searchDocumentId: string;
  readonly organizationId: string;
  readonly providerOrganizationId: string;
  readonly serviceKey: string;
  readonly serviceRevision: number;
  readonly publicName: string;
  readonly title: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly qualityScore: number;
  readonly status: 'active' | 'inactive';
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SearchIndexInput {
  readonly providerOrganizationId: string;
  readonly serviceKey: string;
  readonly keywords: readonly string[];
  readonly qualityScore: number;
}

export interface SearchQuery {
  readonly text: string;
  readonly limit: number;
}

export interface SearchHit {
  readonly searchDocumentId: string;
  readonly providerOrganizationId: string;
  readonly serviceKey: string;
  readonly serviceRevision: number;
  readonly publicName: string;
  readonly title: string;
  readonly score: number;
  readonly matchedTerms: readonly string[];
}

export interface SearchStore {
  getProvider(organizationId: string, providerOrganizationId: string): Promise<SearchProvider | null>;
  getPublishedService(organizationId: string, serviceKey: string): Promise<SearchService | null>;
  getDocument(organizationId: string, providerOrganizationId: string,
    serviceKey: string): Promise<SearchDocument | null>;
  replaceDocument(current: SearchDocument | null, replacement: SearchDocument): Promise<boolean>;
  listDocuments(organizationId: string): Promise<readonly SearchDocument[]>;
}

export interface SearchOptions {
  readonly store: SearchStore;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
}

export type SearchResult<T> =
  | {readonly accepted: true; readonly value: T}
  | {readonly accepted: false; readonly code: typeof SEARCH_REJECTED};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY = /^[a-z][a-z0-9-]{0,62}$/;
const TERM = /^[a-z0-9][a-z0-9-]{0,31}$/;
const rejected = <T>(): SearchResult<T> => ({accepted: false, code: SEARCH_REJECTED});

function validText(value: string, maximum: number): boolean {
  return value === value.trim() && value.length > 0 && value.length <= maximum;
}

function terms(value: string): readonly string[] {
  return Object.freeze([...new Set(value.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [])]);
}

function normalizedKeywords(values: readonly string[]): readonly string[] | null {
  if (values.length > 32) return null;
  const normalized = [...new Set(values)];
  if (normalized.length !== values.length || normalized.some(value => !TERM.test(value))) return null;
  return Object.freeze(normalized.sort());
}

function boundProvider(value: SearchProvider | null, organizationId: string,
  providerOrganizationId: string): value is SearchProvider {
  return value?.organizationId === organizationId &&
    value.providerOrganizationId === providerOrganizationId &&
    validText(value.publicName, 120) && value.status === 'active';
}

function boundService(value: SearchService | null, organizationId: string,
  serviceKey: string): value is SearchService {
  return value?.organizationId === organizationId && value.serviceKey === serviceKey &&
    KEY.test(value.serviceKey) && Number.isSafeInteger(value.revision) && value.revision >= 1 &&
    validText(value.title, 120) && validText(value.description, 2_000) &&
    value.status === 'published';
}

function boundDocument(value: SearchDocument, organizationId: string): boolean {
  return value.organizationId === organizationId && IDENTIFIER.test(value.searchDocumentId) &&
    IDENTIFIER.test(value.providerOrganizationId) && KEY.test(value.serviceKey) &&
    Number.isSafeInteger(value.serviceRevision) && value.serviceRevision >= 1 &&
    validText(value.publicName, 120) && validText(value.title, 120) &&
    validText(value.description, 2_000) && normalizedKeywords(value.keywords) !== null &&
    Number.isSafeInteger(value.qualityScore) && value.qualityScore >= 0 && value.qualityScore <= 1_000 &&
    ['active', 'inactive'].includes(value.status) && Number.isSafeInteger(value.version) &&
    value.version >= 1 && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0 &&
    Number.isSafeInteger(value.updatedAt) && value.updatedAt >= value.createdAt;
}

async function authorize(request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState, permission: string, action: string,
  options: SearchOptions): Promise<string | null> {
  const result = await authorizeAndAuditOrganizationAction(request, state, action, options.audit);
  return result.authorized && request.requiredPermission === permission ? result.organizationId : null;
}

export async function indexSearchDocument(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: SearchIndexInput, expectedVersion: number, options: SearchOptions):
  Promise<SearchResult<SearchDocument>> {
  const organizationId = await authorize(request, state, 'search:write', 'search.index', options);
  const now = options.now();
  const keywords = normalizedKeywords(input.keywords);
  if (!organizationId || contractVersion !== SEARCH_CONTRACT_VERSION ||
    !IDENTIFIER.test(input.providerOrganizationId) || !KEY.test(input.serviceKey) ||
    !Number.isSafeInteger(input.qualityScore) || input.qualityScore < 0 ||
    input.qualityScore > 1_000 || !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0 || !Number.isSafeInteger(now) || now < 0 || !keywords) return rejected();
  try {
    const [provider, service, current] = await Promise.all([
      options.store.getProvider(organizationId, input.providerOrganizationId),
      options.store.getPublishedService(organizationId, input.serviceKey),
      options.store.getDocument(organizationId, input.providerOrganizationId, input.serviceKey),
    ]);
    if (!boundProvider(provider, organizationId, input.providerOrganizationId) ||
      !boundService(service, organizationId, input.serviceKey) ||
      (current !== null && !boundDocument(current, organizationId)) ||
      (current?.version ?? 0) !== expectedVersion || (current && now < current.updatedAt)) return rejected();
    const searchDocumentId = current?.searchDocumentId ?? options.createOpaqueId();
    if (!IDENTIFIER.test(searchDocumentId)) return rejected();
    const replacement = Object.freeze({
      searchDocumentId, organizationId, providerOrganizationId: provider.providerOrganizationId,
      serviceKey: service.serviceKey, serviceRevision: service.revision,
      publicName: provider.publicName, title: service.title, description: service.description,
      keywords, qualityScore: input.qualityScore, status: 'active' as const,
      version: (current?.version ?? 0) + 1, createdAt: current?.createdAt ?? now, updatedAt: now,
    });
    return await options.store.replaceDocument(current, replacement)
      ? {accepted: true, value: replacement} : rejected();
  } catch {
    return rejected();
  }
}

function rank(document: SearchDocument, queryTerms: readonly string[]): SearchHit | null {
  const titleTerms = new Set(terms(document.title));
  const providerTerms = new Set(terms(document.publicName));
  const descriptionTerms = new Set(terms(document.description));
  const keywordTerms = new Set(document.keywords);
  const matched = queryTerms.filter(term => titleTerms.has(term) || providerTerms.has(term) ||
    descriptionTerms.has(term) || keywordTerms.has(term));
  if (matched.length === 0) return null;
  const score = matched.reduce((total, term) => total +
    (titleTerms.has(term) ? 1_000 : 0) + (providerTerms.has(term) ? 700 : 0) +
    (keywordTerms.has(term) ? 400 : 0) + (descriptionTerms.has(term) ? 100 : 0), 0) +
    matched.length * 10_000 + document.qualityScore;
  return Object.freeze({
    searchDocumentId: document.searchDocumentId,
    providerOrganizationId: document.providerOrganizationId,
    serviceKey: document.serviceKey,
    serviceRevision: document.serviceRevision,
    publicName: document.publicName,
    title: document.title,
    score,
    matchedTerms: Object.freeze([...matched]),
  });
}

export async function searchIndex(request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState, query: SearchQuery,
  options: SearchOptions): Promise<SearchResult<readonly SearchHit[]>> {
  const organizationId = await authorize(request, state, 'search:read', 'search.query', options);
  const queryTerms = terms(query.text);
  if (!organizationId || !validText(query.text, 160) || queryTerms.length < 1 ||
    queryTerms.length > 10 || !Number.isSafeInteger(query.limit) || query.limit < 1 ||
    query.limit > 100) return rejected();
  try {
    const documents = await options.store.listDocuments(organizationId);
    if (documents.length > 5_000 ||
      new Set(documents.map(value => value.searchDocumentId)).size !== documents.length ||
      documents.some(value => !boundDocument(value, organizationId))) return rejected();
    const hits = documents.filter(value => value.status === 'active')
      .map(value => rank(value, queryTerms)).filter((value): value is SearchHit => value !== null)
      .sort((left, right) => right.score - left.score ||
        left.publicName.localeCompare(right.publicName, 'en') ||
        left.searchDocumentId.localeCompare(right.searchDocumentId, 'en'))
      .slice(0, query.limit);
    return {accepted: true, value: Object.freeze(hits)};
  } catch {
    return rejected();
  }
}
