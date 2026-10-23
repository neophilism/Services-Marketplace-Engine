import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const TERRITORY_CONTRACT_VERSION = 1 as const;
export const TERRITORY_REJECTED = 'territory_rejected' as const;

export interface TerritoryProvider {
  readonly providerOrganizationId: string;
  readonly organizationId: string;
  readonly status: 'draft' | 'active' | 'suspended' | 'closed';
}

export interface TerritoryLocation {
  readonly providerLocationId: string;
  readonly organizationId: string;
  readonly providerOrganizationId: string;
  readonly serviceModes: readonly ('on_site' | 'mobile' | 'remote')[];
  readonly status: 'active' | 'inactive';
}

export interface TravelRules {
  readonly maximumDistanceMeters: number;
  readonly minimumNoticeMinutes: number;
  readonly baseFeeMinor: number;
  readonly perKilometerFeeMinor: number;
  readonly currency: string;
}

export interface ServiceTerritory {
  readonly serviceTerritoryId: string;
  readonly organizationId: string;
  readonly providerOrganizationId: string;
  readonly providerLocationId: string;
  readonly name: string;
  readonly centerLatitudeE6: number;
  readonly centerLongitudeE6: number;
  readonly radiusMeters: number;
  readonly travelRules: TravelRules;
  readonly status: 'active' | 'inactive';
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ServiceTerritoryInput {
  readonly providerOrganizationId: string;
  readonly providerLocationId: string;
  readonly name: string;
  readonly centerLatitudeE6: number;
  readonly centerLongitudeE6: number;
  readonly radiusMeters: number;
  readonly travelRules: TravelRules;
}

export interface TravelQuote {
  readonly eligible: boolean;
  readonly distanceMeters: number;
  readonly feeMinor: number | null;
  readonly currency: string;
  readonly minimumNoticeMinutes: number;
}

export interface TerritoryStore {
  getProvider(organizationId: string, providerOrganizationId: string): Promise<TerritoryProvider | null>;
  getLocation(organizationId: string, providerLocationId: string): Promise<TerritoryLocation | null>;
  getTerritory(organizationId: string, serviceTerritoryId: string): Promise<ServiceTerritory | null>;
  listTerritories(organizationId: string, providerOrganizationId: string): Promise<readonly ServiceTerritory[]>;
  createTerritory(territory: ServiceTerritory): Promise<boolean>;
  replaceTerritory(current: ServiceTerritory, replacement: ServiceTerritory): Promise<boolean>;
}

export interface TerritoryOptions {
  readonly store: TerritoryStore;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
}

export type TerritoryResult<T> =
  | {readonly accepted: true; readonly value: T}
  | {readonly accepted: false; readonly code: typeof TERRITORY_REJECTED};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CURRENCY = /^[A-Z]{3}$/;
const rejected = <T>(): TerritoryResult<T> => ({accepted: false, code: TERRITORY_REJECTED});

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validText(value: string, maximum: number): boolean {
  return value === value.trim() && value.length > 0 && value.length <= maximum;
}

function validCoordinates(latitudeE6: number, longitudeE6: number): boolean {
  return Number.isSafeInteger(latitudeE6) && latitudeE6 >= -90_000_000 && latitudeE6 <= 90_000_000 &&
    Number.isSafeInteger(longitudeE6) && longitudeE6 >= -180_000_000 && longitudeE6 <= 180_000_000;
}

function validTravelRules(value: TravelRules, radiusMeters: number): boolean {
  return Number.isSafeInteger(value.maximumDistanceMeters) && value.maximumDistanceMeters >= 1 &&
    value.maximumDistanceMeters <= radiusMeters && Number.isSafeInteger(value.minimumNoticeMinutes) &&
    value.minimumNoticeMinutes >= 0 && value.minimumNoticeMinutes <= 525_600 &&
    Number.isSafeInteger(value.baseFeeMinor) && value.baseFeeMinor >= 0 &&
    value.baseFeeMinor <= 100_000_000 && Number.isSafeInteger(value.perKilometerFeeMinor) &&
    value.perKilometerFeeMinor >= 0 && value.perKilometerFeeMinor <= 10_000_000 &&
    CURRENCY.test(value.currency);
}

function boundProvider(value: TerritoryProvider | null, organizationId: string,
  providerOrganizationId: string): value is TerritoryProvider {
  return value?.organizationId === organizationId &&
    value.providerOrganizationId === providerOrganizationId &&
    ['active', 'suspended'].includes(value.status);
}

function boundLocation(value: TerritoryLocation | null, organizationId: string,
  providerOrganizationId: string, providerLocationId: string): value is TerritoryLocation {
  return value?.organizationId === organizationId &&
    value.providerOrganizationId === providerOrganizationId &&
    value.providerLocationId === providerLocationId &&
    value.serviceModes.every(mode => ['on_site', 'mobile', 'remote'].includes(mode));
}

function boundTerritory(value: ServiceTerritory | null, organizationId: string,
  serviceTerritoryId: string): value is ServiceTerritory {
  return Boolean(value?.organizationId === organizationId &&
    value.serviceTerritoryId === serviceTerritoryId && IDENTIFIER.test(value.serviceTerritoryId) &&
    IDENTIFIER.test(value.providerOrganizationId) &&
    IDENTIFIER.test(value.providerLocationId) && validText(value.name, 120) &&
    validCoordinates(value.centerLatitudeE6, value.centerLongitudeE6) &&
    Number.isSafeInteger(value.radiusMeters) && value.radiusMeters >= 1 && value.radiusMeters <= 500_000 &&
    validTravelRules(value.travelRules, value.radiusMeters) &&
    ['active', 'inactive'].includes(value.status) && Number.isSafeInteger(value.version) &&
    value.version >= 1 && validTimestamp(value.createdAt) && validTimestamp(value.updatedAt) &&
    value.updatedAt >= value.createdAt);
}

function normalizeInput(input: ServiceTerritoryInput): ServiceTerritoryInput | null {
  if (!IDENTIFIER.test(input.providerOrganizationId) || !IDENTIFIER.test(input.providerLocationId) ||
    !validText(input.name, 120) || !validCoordinates(input.centerLatitudeE6, input.centerLongitudeE6) ||
    !Number.isSafeInteger(input.radiusMeters) || input.radiusMeters < 1 || input.radiusMeters > 500_000 ||
    !validTravelRules(input.travelRules, input.radiusMeters)) return null;
  return Object.freeze({...input, travelRules: Object.freeze({...input.travelRules})});
}

async function authorize(request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState, permission: string, action: string,
  options: TerritoryOptions): Promise<string | null> {
  const result = await authorizeAndAuditOrganizationAction(request, state, action, options.audit);
  return result.authorized && request.requiredPermission === permission ? result.organizationId : null;
}

async function activeParents(organizationId: string, providerOrganizationId: string,
  providerLocationId: string, options: TerritoryOptions): Promise<boolean> {
  const [provider, location] = await Promise.all([
    options.store.getProvider(organizationId, providerOrganizationId),
    options.store.getLocation(organizationId, providerLocationId),
  ]);
  return boundProvider(provider, organizationId, providerOrganizationId) && provider.status === 'active' &&
    boundLocation(location, organizationId, providerOrganizationId, providerLocationId) &&
    location.status === 'active' && location.serviceModes.includes('mobile');
}

export async function createServiceTerritory(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: ServiceTerritoryInput, options: TerritoryOptions): Promise<TerritoryResult<ServiceTerritory>> {
  const organizationId = await authorize(request, state, 'territory:write', 'territory.create', options);
  const serviceTerritoryId = options.createOpaqueId();
  const now = options.now();
  const normalized = normalizeInput(input);
  if (!organizationId || contractVersion !== TERRITORY_CONTRACT_VERSION ||
    !IDENTIFIER.test(serviceTerritoryId) || !validTimestamp(now) || !normalized) return rejected();
  try {
    if (!await activeParents(organizationId, input.providerOrganizationId,
      input.providerLocationId, options)) return rejected();
    const territory = Object.freeze({serviceTerritoryId, organizationId, ...normalized,
      status: 'active' as const, version: 1, createdAt: now, updatedAt: now});
    return await options.store.createTerritory(territory)
      ? {accepted: true, value: territory} : rejected();
  } catch {
    return rejected();
  }
}

export async function updateServiceTerritory(request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState, serviceTerritoryId: string, expectedVersion: number,
  input: ServiceTerritoryInput, status: 'active' | 'inactive',
  options: TerritoryOptions): Promise<TerritoryResult<ServiceTerritory>> {
  const organizationId = await authorize(request, state, 'territory:write', 'territory.update', options);
  const now = options.now();
  const normalized = normalizeInput(input);
  if (!organizationId || !IDENTIFIER.test(serviceTerritoryId) ||
    !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
    !['active', 'inactive'].includes(status) || !validTimestamp(now) || !normalized) return rejected();
  try {
    const current = await options.store.getTerritory(organizationId, serviceTerritoryId);
    if (!boundTerritory(current, organizationId, serviceTerritoryId) ||
      current.version !== expectedVersion || now < current.updatedAt ||
      input.providerOrganizationId !== current.providerOrganizationId ||
      input.providerLocationId !== current.providerLocationId ||
      (status === 'active' && !await activeParents(organizationId, input.providerOrganizationId,
        input.providerLocationId, options))) return rejected();
    const replacement = Object.freeze({...current, ...normalized, status,
      version: current.version + 1, updatedAt: now});
    return await options.store.replaceTerritory(current, replacement)
      ? {accepted: true, value: replacement} : rejected();
  } catch {
    return rejected();
  }
}

export async function listServiceTerritories(request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState, providerOrganizationId: string,
  options: TerritoryOptions): Promise<TerritoryResult<readonly ServiceTerritory[]>> {
  const organizationId = await authorize(request, state, 'territory:read', 'territory.list', options);
  if (!organizationId || !IDENTIFIER.test(providerOrganizationId)) return rejected();
  try {
    const provider = await options.store.getProvider(organizationId, providerOrganizationId);
    const values = await options.store.listTerritories(organizationId, providerOrganizationId);
    if (!boundProvider(provider, organizationId, providerOrganizationId) || values.length > 1_000 ||
      new Set(values.map(value => value.serviceTerritoryId)).size !== values.length ||
      values.some(value => !boundTerritory(value, organizationId, value.serviceTerritoryId) ||
        value.providerOrganizationId !== providerOrganizationId)) return rejected();
    return {accepted: true, value: Object.freeze([...values])};
  } catch {
    return rejected();
  }
}

function distanceMeters(fromLatitudeE6: number, fromLongitudeE6: number,
  toLatitudeE6: number, toLongitudeE6: number): number {
  const radians = (value: number) => value * Math.PI / 180_000_000;
  const latitudeDelta = radians(toLatitudeE6 - fromLatitudeE6);
  const longitudeDelta = radians(toLongitudeE6 - fromLongitudeE6);
  const fromLatitude = radians(fromLatitudeE6);
  const toLatitude = radians(toLatitudeE6);
  const a = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(fromLatitude) * Math.cos(toLatitude) *
    Math.sin(longitudeDelta / 2) ** 2;
  const bounded = Math.min(1, Math.max(0, a));
  return Math.round(6_371_008.8 * 2 * Math.atan2(Math.sqrt(bounded), Math.sqrt(1 - bounded)));
}

export async function quoteTerritoryTravel(request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState, serviceTerritoryId: string,
  destinationLatitudeE6: number, destinationLongitudeE6: number,
  options: TerritoryOptions): Promise<TerritoryResult<TravelQuote>> {
  const organizationId = await authorize(request, state, 'territory:read', 'territory.quote', options);
  if (!organizationId || !IDENTIFIER.test(serviceTerritoryId) ||
    !validCoordinates(destinationLatitudeE6, destinationLongitudeE6)) return rejected();
  try {
    const territory = await options.store.getTerritory(organizationId, serviceTerritoryId);
    if (!boundTerritory(territory, organizationId, serviceTerritoryId) || territory.status !== 'active' ||
      !await activeParents(organizationId, territory.providerOrganizationId,
        territory.providerLocationId, options)) return rejected();
    const distance = distanceMeters(territory.centerLatitudeE6, territory.centerLongitudeE6,
      destinationLatitudeE6, destinationLongitudeE6);
    const eligible = distance <= territory.radiusMeters &&
      distance <= territory.travelRules.maximumDistanceMeters;
    const distanceKilometers = Math.ceil(distance / 1_000);
    const variableFee = distanceKilometers * territory.travelRules.perKilometerFeeMinor;
    const fee = eligible && Number.isSafeInteger(variableFee) &&
      Number.isSafeInteger(territory.travelRules.baseFeeMinor + variableFee)
      ? territory.travelRules.baseFeeMinor + variableFee : null;
    return {accepted: true, value: Object.freeze({eligible: eligible && fee !== null,
      distanceMeters: distance, feeMinor: fee, currency: territory.travelRules.currency,
      minimumNoticeMinutes: territory.travelRules.minimumNoticeMinutes})};
  } catch {
    return rejected();
  }
}
