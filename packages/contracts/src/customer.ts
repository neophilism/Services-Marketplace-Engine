import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const CUSTOMER_CONTRACT_VERSION = 1 as const;
export const CUSTOMER_REJECTED = 'customer_rejected' as const;

export interface CustomerProfile {
  readonly customerProfileId: string;
  readonly organizationId: string;
  readonly customerSubjectId: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly status: 'active' | 'closed';
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SavedAsset {
  readonly savedAssetId: string;
  readonly organizationId: string;
  readonly customerProfileId: string;
  readonly assetType: string;
  readonly label: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly status: 'active' | 'archived';
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CustomerStore {
  createProfile(profile: CustomerProfile): Promise<boolean>;
  getProfile(organizationId: string, customerProfileId: string): Promise<CustomerProfile | null>;
  replaceProfile(current: CustomerProfile, replacement: CustomerProfile): Promise<boolean>;
  createSavedAsset(asset: SavedAsset): Promise<boolean>;
  getSavedAsset(organizationId: string, savedAssetId: string): Promise<SavedAsset | null>;
  replaceSavedAsset(current: SavedAsset, replacement: SavedAsset): Promise<boolean>;
  listSavedAssets(organizationId: string, customerProfileId: string): Promise<readonly SavedAsset[]>;
}

export interface CustomerOptions {
  readonly store: CustomerStore;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
}

export type CustomerResult<T> =
  | {readonly accepted: true; readonly value: T}
  | {readonly accepted: false; readonly code: typeof CUSTOMER_REJECTED};

export interface ProfileInput {
  readonly customerSubjectId: string;
  readonly displayName: string;
  readonly email?: string | null;
  readonly phone?: string | null;
}

export interface SavedAssetInput {
  readonly customerProfileId: string;
  readonly assetType: string;
  readonly label: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const rejected = <T>(): CustomerResult<T> => ({accepted: false, code: CUSTOMER_REJECTED});

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validText(value: string, maximum: number): boolean {
  return value === value.trim() && value.length > 0 && value.length <= maximum;
}

function validProfileInput(input: ProfileInput): boolean {
  return IDENTIFIER.test(input.customerSubjectId) && validText(input.displayName, 120) &&
    (input.email === undefined || input.email === null ||
      (input.email.length <= 254 && EMAIL.test(input.email))) &&
    (input.phone === undefined || input.phone === null || validText(input.phone, 32));
}

function normalizeAttributes(
  attributes: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | null {
  const entries = Object.entries(attributes ?? {});
  if (entries.length > 32) return null;
  const normalized: Record<string, string> = Object.create(null);
  for (const [key, value] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!IDENTIFIER.test(key) || !validText(value, 500)) return null;
    normalized[key] = value;
  }
  return Object.freeze(normalized);
}

async function authorize(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  permission: string,
  action: string,
  options: CustomerOptions,
): Promise<string | null> {
  const result = await authorizeAndAuditOrganizationAction(request, state, action, options.audit);
  return result.authorized && request.requiredPermission === permission ? result.organizationId : null;
}

export async function createCustomerProfile(
  contractVersion: number,
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  input: ProfileInput,
  options: CustomerOptions,
): Promise<CustomerResult<CustomerProfile>> {
  const organizationId = await authorize(
    request, state, 'customer-profile:write', 'customer-profile.create', options,
  );
  const customerProfileId = options.createOpaqueId();
  const now = options.now();
  if (!organizationId || contractVersion !== CUSTOMER_CONTRACT_VERSION ||
    !IDENTIFIER.test(customerProfileId) || !validTimestamp(now) || !validProfileInput(input)) {
    return rejected();
  }
  const profile = Object.freeze({
    customerProfileId, organizationId, customerSubjectId: input.customerSubjectId,
    displayName: input.displayName, email: input.email ?? null, phone: input.phone ?? null,
    status: 'active' as const, version: 1, createdAt: now, updatedAt: now,
  });
  try {
    return await options.store.createProfile(profile) ? {accepted: true, value: profile} : rejected();
  } catch {
    return rejected();
  }
}

export async function updateCustomerProfile(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  customerProfileId: string,
  expectedVersion: number,
  input: ProfileInput,
  options: CustomerOptions,
): Promise<CustomerResult<CustomerProfile>> {
  const organizationId = await authorize(
    request, state, 'customer-profile:write', 'customer-profile.update', options,
  );
  const now = options.now();
  if (!organizationId || !IDENTIFIER.test(customerProfileId) ||
    !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
    !validTimestamp(now) || !validProfileInput(input)) return rejected();
  try {
    const current = await options.store.getProfile(organizationId, customerProfileId);
    if (!current || current.status !== 'active' || current.version !== expectedVersion ||
      input.customerSubjectId !== current.customerSubjectId || now < current.updatedAt) return rejected();
    const replacement = Object.freeze({
      ...current, displayName: input.displayName, email: input.email ?? null, phone: input.phone ?? null,
      version: current.version + 1, updatedAt: now,
    });
    return await options.store.replaceProfile(current, replacement)
      ? {accepted: true, value: replacement} : rejected();
  } catch {
    return rejected();
  }
}

export async function getCustomerProfile(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  customerProfileId: string,
  options: CustomerOptions,
): Promise<CustomerResult<CustomerProfile>> {
  const organizationId = await authorize(
    request, state, 'customer-profile:read', 'customer-profile.read', options,
  );
  if (!organizationId || !IDENTIFIER.test(customerProfileId)) return rejected();
  try {
    const profile = await options.store.getProfile(organizationId, customerProfileId);
    return profile?.status === 'active' ? {accepted: true, value: profile} : rejected();
  } catch {
    return rejected();
  }
}

export async function saveCustomerAsset(
  contractVersion: number,
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  input: SavedAssetInput,
  options: CustomerOptions,
): Promise<CustomerResult<SavedAsset>> {
  const organizationId = await authorize(
    request, state, 'saved-asset:write', 'saved-asset.create', options,
  );
  const savedAssetId = options.createOpaqueId();
  const now = options.now();
  const attributes = normalizeAttributes(input.attributes);
  if (!organizationId || contractVersion !== CUSTOMER_CONTRACT_VERSION ||
    !IDENTIFIER.test(savedAssetId) || !IDENTIFIER.test(input.customerProfileId) ||
    !validText(input.assetType, 80) || !validText(input.label, 120) ||
    !attributes || !validTimestamp(now)) return rejected();
  try {
    const profile = await options.store.getProfile(organizationId, input.customerProfileId);
    if (!profile || profile.status !== 'active') return rejected();
    const asset = Object.freeze({
      savedAssetId, organizationId, customerProfileId: profile.customerProfileId,
      assetType: input.assetType, label: input.label, attributes,
      status: 'active' as const, version: 1, createdAt: now, updatedAt: now,
    });
    return await options.store.createSavedAsset(asset)
      ? {accepted: true, value: asset} : rejected();
  } catch {
    return rejected();
  }
}

export async function listCustomerAssets(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  customerProfileId: string,
  options: CustomerOptions,
): Promise<CustomerResult<readonly SavedAsset[]>> {
  const organizationId = await authorize(
    request, state, 'saved-asset:read', 'saved-asset.list', options,
  );
  if (!organizationId || !IDENTIFIER.test(customerProfileId)) return rejected();
  try {
    const profile = await options.store.getProfile(organizationId, customerProfileId);
    if (!profile || profile.status !== 'active') return rejected();
    const assets = await options.store.listSavedAssets(organizationId, customerProfileId);
    if (assets.some(asset => asset.organizationId !== organizationId ||
      asset.customerProfileId !== customerProfileId)) return rejected();
    return {accepted: true, value: Object.freeze(assets.filter(asset => asset.status === 'active'))};
  } catch {
    return rejected();
  }
}

export async function archiveCustomerAsset(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  savedAssetId: string,
  expectedVersion: number,
  options: CustomerOptions,
): Promise<CustomerResult<SavedAsset>> {
  const organizationId = await authorize(
    request, state, 'saved-asset:write', 'saved-asset.archive', options,
  );
  const now = options.now();
  if (!organizationId || !IDENTIFIER.test(savedAssetId) ||
    !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !validTimestamp(now)) {
    return rejected();
  }
  try {
    const current = await options.store.getSavedAsset(organizationId, savedAssetId);
    if (!current || current.status !== 'active' || current.version !== expectedVersion ||
      now < current.updatedAt) return rejected();
    const replacement = Object.freeze({
      ...current, status: 'archived' as const, version: current.version + 1, updatedAt: now,
    });
    return await options.store.replaceSavedAsset(current, replacement)
      ? {accepted: true, value: replacement} : rejected();
  } catch {
    return rejected();
  }
}
