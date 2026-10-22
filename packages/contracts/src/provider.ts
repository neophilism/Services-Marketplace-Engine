import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const PROVIDER_CONTRACT_VERSION = 1 as const;
export const PROVIDER_REJECTED = 'provider_rejected' as const;

export interface ProviderOrganization {
  readonly providerOrganizationId: string;
  readonly organizationId: string;
  readonly legalName: string;
  readonly publicName: string;
  readonly status: 'draft' | 'active' | 'suspended' | 'closed';
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ProviderLocation {
  readonly providerLocationId: string;
  readonly organizationId: string;
  readonly providerOrganizationId: string;
  readonly name: string;
  readonly addressLines: readonly string[];
  readonly locality: string;
  readonly administrativeArea: string;
  readonly postalCode: string;
  readonly countryCode: string;
  readonly timeZone: string;
  readonly serviceModes: readonly ('on_site' | 'mobile' | 'remote')[];
  readonly status: 'active' | 'inactive';
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ProviderStore {
  createProvider(provider: ProviderOrganization): Promise<boolean>;
  getProvider(organizationId: string, providerOrganizationId: string): Promise<ProviderOrganization | null>;
  replaceProvider(current: ProviderOrganization, replacement: ProviderOrganization): Promise<boolean>;
  createLocation(location: ProviderLocation): Promise<boolean>;
  getLocation(organizationId: string, providerLocationId: string): Promise<ProviderLocation | null>;
  replaceLocation(current: ProviderLocation, replacement: ProviderLocation): Promise<boolean>;
  listLocations(organizationId: string, providerOrganizationId: string): Promise<readonly ProviderLocation[]>;
}

export interface ProviderOptions {
  readonly store: ProviderStore;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
}

export interface ProviderInput {
  readonly legalName: string;
  readonly publicName: string;
}

export interface LocationInput {
  readonly providerOrganizationId: string;
  readonly name: string;
  readonly addressLines: readonly string[];
  readonly locality: string;
  readonly administrativeArea: string;
  readonly postalCode: string;
  readonly countryCode: string;
  readonly timeZone: string;
  readonly serviceModes: readonly ('on_site' | 'mobile' | 'remote')[];
}

export type ProviderResult<T> =
  | {readonly accepted: true; readonly value: T}
  | {readonly accepted: false; readonly code: typeof PROVIDER_REJECTED};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COUNTRY_CODE = /^[A-Z]{2}$/;
const TIME_ZONE = /^(?:UTC|[A-Za-z_]+\/[A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+)?)$/;
const MODES = new Set(['on_site', 'mobile', 'remote']);
const rejected = <T>(): ProviderResult<T> => ({accepted: false, code: PROVIDER_REJECTED});

function validText(value: string, maximum: number): boolean {
  return value === value.trim() && value.length > 0 && value.length <= maximum;
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validProviderInput(input: ProviderInput): boolean {
  return validText(input.legalName, 200) && validText(input.publicName, 120);
}

function normalizeLocation(input: LocationInput): Omit<LocationInput, 'providerOrganizationId'> | null {
  const modes = [...new Set(input.serviceModes)].sort() as LocationInput['serviceModes'];
  if (!validText(input.name, 120) || input.addressLines.length < 1 || input.addressLines.length > 3 ||
    input.addressLines.some(line => !validText(line, 160)) || !validText(input.locality, 120) ||
    !validText(input.administrativeArea, 120) || !validText(input.postalCode, 32) ||
    !COUNTRY_CODE.test(input.countryCode) || !TIME_ZONE.test(input.timeZone) ||
    modes.length < 1 || modes.some(mode => !MODES.has(mode))) return null;
  return Object.freeze({
    name: input.name,
    addressLines: Object.freeze([...input.addressLines]),
    locality: input.locality,
    administrativeArea: input.administrativeArea,
    postalCode: input.postalCode,
    countryCode: input.countryCode,
    timeZone: input.timeZone,
    serviceModes: Object.freeze(modes),
  });
}

async function authorize(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  permission: string,
  action: string,
  options: ProviderOptions,
): Promise<string | null> {
  const result = await authorizeAndAuditOrganizationAction(request, state, action, options.audit);
  return result.authorized && request.requiredPermission === permission ? result.organizationId : null;
}

export async function createProviderOrganization(
  contractVersion: number,
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  input: ProviderInput,
  options: ProviderOptions,
): Promise<ProviderResult<ProviderOrganization>> {
  const organizationId = await authorize(request, state, 'provider:write', 'provider.create', options);
  const providerOrganizationId = options.createOpaqueId();
  const now = options.now();
  if (!organizationId || contractVersion !== PROVIDER_CONTRACT_VERSION ||
    !IDENTIFIER.test(providerOrganizationId) || !validTimestamp(now) || !validProviderInput(input)) {
    return rejected();
  }
  const provider = Object.freeze({
    providerOrganizationId, organizationId, legalName: input.legalName,
    publicName: input.publicName, status: 'draft' as const,
    version: 1, createdAt: now, updatedAt: now,
  });
  try {
    return await options.store.createProvider(provider)
      ? {accepted: true, value: provider} : rejected();
  } catch {
    return rejected();
  }
}

export async function getProviderOrganization(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  providerOrganizationId: string,
  options: ProviderOptions,
): Promise<ProviderResult<ProviderOrganization>> {
  const organizationId = await authorize(request, state, 'provider:read', 'provider.read', options);
  if (!organizationId || !IDENTIFIER.test(providerOrganizationId)) return rejected();
  try {
    const provider = await options.store.getProvider(organizationId, providerOrganizationId);
    return provider && provider.status !== 'closed' ? {accepted: true, value: provider} : rejected();
  } catch {
    return rejected();
  }
}

export async function updateProviderOrganization(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  providerOrganizationId: string,
  expectedVersion: number,
  input: ProviderInput,
  options: ProviderOptions,
): Promise<ProviderResult<ProviderOrganization>> {
  const organizationId = await authorize(request, state, 'provider:write', 'provider.update', options);
  const now = options.now();
  if (!organizationId || !IDENTIFIER.test(providerOrganizationId) ||
    !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
    !validTimestamp(now) || !validProviderInput(input)) return rejected();
  try {
    const current = await options.store.getProvider(organizationId, providerOrganizationId);
    if (!current || current.status === 'closed' || current.version !== expectedVersion ||
      now < current.updatedAt) return rejected();
    const replacement = Object.freeze({
      ...current, legalName: input.legalName, publicName: input.publicName,
      version: current.version + 1, updatedAt: now,
    });
    return await options.store.replaceProvider(current, replacement)
      ? {accepted: true, value: replacement} : rejected();
  } catch {
    return rejected();
  }
}

export async function createProviderLocation(
  contractVersion: number,
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  input: LocationInput,
  options: ProviderOptions,
): Promise<ProviderResult<ProviderLocation>> {
  const organizationId = await authorize(request, state, 'provider-location:write', 'provider-location.create', options);
  const providerLocationId = options.createOpaqueId();
  const now = options.now();
  const normalized = normalizeLocation(input);
  if (!organizationId || contractVersion !== PROVIDER_CONTRACT_VERSION ||
    !IDENTIFIER.test(providerLocationId) || !IDENTIFIER.test(input.providerOrganizationId) ||
    !validTimestamp(now) || !normalized) return rejected();
  try {
    const provider = await options.store.getProvider(organizationId, input.providerOrganizationId);
    if (!provider || provider.status === 'closed' || provider.status === 'suspended') return rejected();
    const location = Object.freeze({
      providerLocationId, organizationId, providerOrganizationId: provider.providerOrganizationId,
      ...normalized, status: 'active' as const, version: 1, createdAt: now, updatedAt: now,
    });
    return await options.store.createLocation(location)
      ? {accepted: true, value: location} : rejected();
  } catch {
    return rejected();
  }
}

export async function listProviderLocations(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  providerOrganizationId: string,
  options: ProviderOptions,
): Promise<ProviderResult<readonly ProviderLocation[]>> {
  const organizationId = await authorize(request, state, 'provider-location:read', 'provider-location.list', options);
  if (!organizationId || !IDENTIFIER.test(providerOrganizationId)) return rejected();
  try {
    const provider = await options.store.getProvider(organizationId, providerOrganizationId);
    if (!provider || provider.status === 'closed') return rejected();
    const locations = await options.store.listLocations(organizationId, providerOrganizationId);
    if (locations.some(location => location.organizationId !== organizationId ||
      location.providerOrganizationId !== providerOrganizationId)) return rejected();
    return {accepted: true, value: Object.freeze([...locations])};
  } catch {
    return rejected();
  }
}

export async function setProviderLocationStatus(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  providerLocationId: string,
  expectedVersion: number,
  status: 'active' | 'inactive',
  options: ProviderOptions,
): Promise<ProviderResult<ProviderLocation>> {
  const organizationId = await authorize(request, state, 'provider-location:write', 'provider-location.status', options);
  const now = options.now();
  if (!organizationId || !IDENTIFIER.test(providerLocationId) ||
    !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
    !['active', 'inactive'].includes(status) || !validTimestamp(now)) return rejected();
  try {
    const current = await options.store.getLocation(organizationId, providerLocationId);
    if (!current || current.version !== expectedVersion || now < current.updatedAt) return rejected();
    const replacement = Object.freeze({...current, status, version: current.version + 1, updatedAt: now});
    return await options.store.replaceLocation(current, replacement)
      ? {accepted: true, value: replacement} : rejected();
  } catch {
    return rejected();
  }
}
