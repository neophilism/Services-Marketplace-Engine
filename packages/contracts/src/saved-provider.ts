import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const SAVED_PROVIDER_CONTRACT_VERSION = 1 as const;
export const SAVED_PROVIDER_REJECTED = 'saved_provider_rejected' as const;

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const REQUEST_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const SERVICE_KEY = /^[a-z][a-z0-9-]{0,62}$/;
const DAY = 86_400_000;

export interface SavedProviderCustomer { readonly organizationId: string; readonly customerProfileId: string; readonly customerSubjectId: string; readonly status: 'active' | 'inactive'; }
export interface SavedProviderTarget { readonly organizationId: string; readonly providerOrganizationId: string; readonly status: 'active' | 'suspended' | 'closed'; }
export interface RepeatSourceEngagement { readonly organizationId: string; readonly engagementId: string; readonly customerProfileId: string; readonly customerSubjectId: string; readonly providerOrganizationId: string; readonly serviceKey: string; readonly status: 'active' | 'completed' | 'cancelled'; readonly completedAt: number | null; }
export interface RepeatPublishedService { readonly organizationId: string; readonly providerOrganizationId: string; readonly serviceKey: string; readonly revision: number; readonly status: 'draft' | 'published' | 'retired'; }
export interface SavedProvider { readonly savedProviderId: string; readonly organizationId: string; readonly requestKey: string; readonly customerProfileId: string; readonly customerSubjectId: string; readonly providerOrganizationId: string; readonly createdAt: number; }
export interface RepeatRequest { readonly repeatRequestId: string; readonly organizationId: string; readonly requestKey: string; readonly savedProviderId: string; readonly sourceEngagementId: string; readonly customerProfileId: string; readonly customerSubjectId: string; readonly providerOrganizationId: string; readonly serviceKey: string; readonly serviceRevision: number; readonly summary: string; readonly requestedStartAt: number | null; readonly requestedEndAt: number | null; readonly status: 'draft'; readonly createdAt: number; }
export interface SaveProviderInput { readonly requestKey: string; readonly customerProfileId: string; readonly providerOrganizationId: string; }
export interface RepeatRequestInput { readonly requestKey: string; readonly savedProviderId: string; readonly sourceEngagementId: string; readonly summary: string; readonly requestedStartAt: number | null; readonly requestedEndAt: number | null; }
export interface SavedProviderStore {
  getCustomer(organizationId: string, customerProfileId: string): Promise<SavedProviderCustomer | null>;
  getProvider(organizationId: string, providerOrganizationId: string): Promise<SavedProviderTarget | null>;
  getSavedProvider(organizationId: string, savedProviderId: string): Promise<SavedProvider | null>;
  getSavedProviderByRequestKey(organizationId: string, requestKey: string): Promise<SavedProvider | null>;
  getSavedProviderByCustomerAndProvider(organizationId: string, customerProfileId: string, providerOrganizationId: string): Promise<SavedProvider | null>;
  createSavedProvider(value: SavedProvider): Promise<boolean>;
  getCompletedEngagement(organizationId: string, engagementId: string): Promise<RepeatSourceEngagement | null>;
  getPublishedService(organizationId: string, providerOrganizationId: string, serviceKey: string): Promise<RepeatPublishedService | null>;
  getRepeatRequestByRequestKey(organizationId: string, requestKey: string): Promise<RepeatRequest | null>;
  createRepeatRequest(value: RepeatRequest): Promise<boolean>;
}
export interface SavedProviderOptions { readonly store: SavedProviderStore; readonly audit: TenantAuditOptions; readonly createOpaqueId: () => string; readonly now: () => number; }
export type SavedProviderResult<T> = {readonly accepted: true; readonly value: T; readonly replayed: boolean} | {readonly accepted: false; readonly code: typeof SAVED_PROVIDER_REJECTED};

const rejected = <T>(): SavedProviderResult<T> => ({accepted: false, code: SAVED_PROVIDER_REJECTED});
const timestamp = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const text = (value: string, maximum: number): boolean => value === value.trim() && value.length >= 1 && value.length <= maximum;
function validWindow(start: number | null, end: number | null, now: number): boolean {
  if (start === null || end === null) return start === null && end === null;
  return timestamp(start) && timestamp(end) && start >= now && end > start && end - start <= 366 * DAY;
}
function boundCustomer(value: SavedProviderCustomer | null, organizationId: string, customerProfileId: string, subjectId: string): value is SavedProviderCustomer { return value?.organizationId === organizationId && value.customerProfileId === customerProfileId && value.customerSubjectId === subjectId && value.status === 'active'; }
function boundProvider(value: SavedProviderTarget | null, organizationId: string, providerOrganizationId: string): value is SavedProviderTarget { return value?.organizationId === organizationId && value.providerOrganizationId === providerOrganizationId && value.status === 'active'; }
function storedSavedProvider(value: SavedProvider | null, organizationId: string): value is SavedProvider { return value?.organizationId === organizationId && IDENTIFIER.test(value.savedProviderId) && REQUEST_KEY.test(value.requestKey) && IDENTIFIER.test(value.customerProfileId) && IDENTIFIER.test(value.customerSubjectId) && IDENTIFIER.test(value.providerOrganizationId) && timestamp(value.createdAt); }
function matchesSave(value: SavedProvider | null, organizationId: string, input: SaveProviderInput, subjectId: string): value is SavedProvider { return storedSavedProvider(value, organizationId) && value.requestKey === input.requestKey && value.customerProfileId === input.customerProfileId && value.customerSubjectId === subjectId && value.providerOrganizationId === input.providerOrganizationId; }
function boundEngagement(value: RepeatSourceEngagement | null, organizationId: string, saved: SavedProvider): value is RepeatSourceEngagement { return value?.organizationId === organizationId && IDENTIFIER.test(value.engagementId) && value.customerProfileId === saved.customerProfileId && value.customerSubjectId === saved.customerSubjectId && value.providerOrganizationId === saved.providerOrganizationId && SERVICE_KEY.test(value.serviceKey) && value.status === 'completed' && value.completedAt !== null && timestamp(value.completedAt); }
function boundService(value: RepeatPublishedService | null, organizationId: string, engagement: RepeatSourceEngagement): value is RepeatPublishedService { return value?.organizationId === organizationId && value.providerOrganizationId === engagement.providerOrganizationId && value.serviceKey === engagement.serviceKey && Number.isSafeInteger(value.revision) && value.revision >= 1 && value.status === 'published'; }
function matchesRepeat(value: RepeatRequest | null, organizationId: string, input: RepeatRequestInput, saved: SavedProvider, service: RepeatPublishedService): value is RepeatRequest { return value?.organizationId === organizationId && value.requestKey === input.requestKey && value.savedProviderId === input.savedProviderId && value.sourceEngagementId === input.sourceEngagementId && value.customerProfileId === saved.customerProfileId && value.customerSubjectId === saved.customerSubjectId && value.providerOrganizationId === saved.providerOrganizationId && value.serviceKey === service.serviceKey && value.serviceRevision === service.revision && value.summary === input.summary && value.requestedStartAt === input.requestedStartAt && value.requestedEndAt === input.requestedEndAt && value.status === 'draft' && IDENTIFIER.test(value.repeatRequestId) && timestamp(value.createdAt); }
async function authorize(request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState, action: string, permission: string, options: SavedProviderOptions): Promise<{organizationId: string; subjectId: string} | null> { const result = await authorizeAndAuditOrganizationAction(request, state, action, options.audit); return result.authorized && request.requiredPermission === permission ? {organizationId: result.organizationId, subjectId: result.subjectId} : null; }

export async function saveProvider(contractVersion: number, request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState, input: SaveProviderInput, options: SavedProviderOptions): Promise<SavedProviderResult<SavedProvider>> {
  const identity = await authorize(request, state, 'saved-provider.create', 'saved-providers:write', options); const now = options.now();
  if (!identity || contractVersion !== SAVED_PROVIDER_CONTRACT_VERSION || !timestamp(now) || !REQUEST_KEY.test(input.requestKey) || !IDENTIFIER.test(input.customerProfileId) || !IDENTIFIER.test(input.providerOrganizationId)) return rejected();
  try {
    const [customer, provider, existing, duplicate] = await Promise.all([options.store.getCustomer(identity.organizationId, input.customerProfileId), options.store.getProvider(identity.organizationId, input.providerOrganizationId), options.store.getSavedProviderByRequestKey(identity.organizationId, input.requestKey), options.store.getSavedProviderByCustomerAndProvider(identity.organizationId, input.customerProfileId, input.providerOrganizationId)]);
    if (!boundCustomer(customer, identity.organizationId, input.customerProfileId, identity.subjectId) || !boundProvider(provider, identity.organizationId, input.providerOrganizationId)) return rejected();
    if (existing !== null) return matchesSave(existing, identity.organizationId, input, identity.subjectId) ? {accepted: true, value: existing, replayed: true} : rejected();
    if (duplicate !== null) return rejected();
    const savedProviderId = options.createOpaqueId(); if (!IDENTIFIER.test(savedProviderId)) return rejected();
    const value = Object.freeze({savedProviderId, organizationId: identity.organizationId, requestKey: input.requestKey, customerProfileId: input.customerProfileId, customerSubjectId: identity.subjectId, providerOrganizationId: input.providerOrganizationId, createdAt: now});
    return await options.store.createSavedProvider(value) ? {accepted: true, value, replayed: false} : rejected();
  } catch { return rejected(); }
}

export async function createRepeatRequest(contractVersion: number, request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState, input: RepeatRequestInput, options: SavedProviderOptions): Promise<SavedProviderResult<RepeatRequest>> {
  const identity = await authorize(request, state, 'repeat-request.create', 'repeat-requests:create', options); const now = options.now();
  if (!identity || contractVersion !== SAVED_PROVIDER_CONTRACT_VERSION || !timestamp(now) || !REQUEST_KEY.test(input.requestKey) || !IDENTIFIER.test(input.savedProviderId) || !IDENTIFIER.test(input.sourceEngagementId) || !text(input.summary, 2_000) || !validWindow(input.requestedStartAt, input.requestedEndAt, now)) return rejected();
  try {
    const saved = await options.store.getSavedProvider(identity.organizationId, input.savedProviderId);
    if (!storedSavedProvider(saved, identity.organizationId) || saved.customerSubjectId !== identity.subjectId) return rejected();
    const [customer, provider, engagement, existing] = await Promise.all([options.store.getCustomer(identity.organizationId, saved.customerProfileId), options.store.getProvider(identity.organizationId, saved.providerOrganizationId), options.store.getCompletedEngagement(identity.organizationId, input.sourceEngagementId), options.store.getRepeatRequestByRequestKey(identity.organizationId, input.requestKey)]);
    if (!boundCustomer(customer, identity.organizationId, saved.customerProfileId, identity.subjectId) || !boundProvider(provider, identity.organizationId, saved.providerOrganizationId) || !boundEngagement(engagement, identity.organizationId, saved)) return rejected();
    const service = await options.store.getPublishedService(identity.organizationId, saved.providerOrganizationId, engagement.serviceKey);
    if (!boundService(service, identity.organizationId, engagement)) return rejected();
    if (existing !== null) return matchesRepeat(existing, identity.organizationId, input, saved, service) ? {accepted: true, value: existing, replayed: true} : rejected();
    const repeatRequestId = options.createOpaqueId(); if (!IDENTIFIER.test(repeatRequestId)) return rejected();
    const value = Object.freeze({repeatRequestId, organizationId: identity.organizationId, requestKey: input.requestKey, savedProviderId: saved.savedProviderId, sourceEngagementId: engagement.engagementId, customerProfileId: saved.customerProfileId, customerSubjectId: saved.customerSubjectId, providerOrganizationId: saved.providerOrganizationId, serviceKey: service.serviceKey, serviceRevision: service.revision, summary: input.summary, requestedStartAt: input.requestedStartAt, requestedEndAt: input.requestedEndAt, status: 'draft' as const, createdAt: now});
    return await options.store.createRepeatRequest(value) ? {accepted: true, value, replayed: false} : rejected();
  } catch { return rejected(); }
}
