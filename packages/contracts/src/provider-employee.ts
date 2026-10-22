import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {ProviderOrganization} from './provider.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const PROVIDER_EMPLOYEE_CONTRACT_VERSION = 1 as const;
export const PROVIDER_EMPLOYEE_REJECTED = 'provider_employee_rejected' as const;

export interface ProviderEmployee {
  readonly providerEmployeeId: string;
  readonly organizationId: string;
  readonly providerOrganizationId: string;
  readonly subjectId: string;
  readonly displayName: string;
  readonly permissions: readonly string[];
  readonly status: 'invited' | 'active' | 'suspended' | 'revoked';
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ProviderEmployeeStore {
  getProvider(organizationId: string, providerOrganizationId: string): Promise<ProviderOrganization | null>;
  createEmployee(employee: ProviderEmployee): Promise<boolean>;
  getEmployee(organizationId: string, providerEmployeeId: string): Promise<ProviderEmployee | null>;
  replaceEmployee(current: ProviderEmployee, replacement: ProviderEmployee): Promise<boolean>;
  listEmployees(organizationId: string, providerOrganizationId: string): Promise<readonly ProviderEmployee[]>;
}

export interface ProviderEmployeeOptions {
  readonly store: ProviderEmployeeStore;
  readonly audit: TenantAuditOptions;
  readonly permissionCatalog: ReadonlySet<string>;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
}

export interface EmployeeInvitation {
  readonly providerOrganizationId: string;
  readonly subjectId: string;
  readonly displayName: string;
  readonly permissions: readonly string[];
}

export type ProviderEmployeeResult<T> =
  | {readonly accepted: true; readonly value: T}
  | {readonly accepted: false; readonly code: typeof PROVIDER_EMPLOYEE_REJECTED};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PERMISSION = /^[a-z][a-z0-9-]{0,62}:[a-z][a-z0-9-]{0,62}$/;
const rejected = <T>(): ProviderEmployeeResult<T> => ({
  accepted: false, code: PROVIDER_EMPLOYEE_REJECTED,
});

function validText(value: string, maximum: number): boolean {
  return value === value.trim() && value.length > 0 && value.length <= maximum;
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizePermissions(
  permissions: readonly string[],
  catalog: ReadonlySet<string>,
): readonly string[] | null {
  const normalized = [...new Set(permissions)].sort();
  if (normalized.length < 1 || normalized.length > 32 ||
    normalized.some(permission => !PERMISSION.test(permission) || !catalog.has(permission))) return null;
  return Object.freeze(normalized);
}

function isBoundProvider(
  provider: ProviderOrganization | null,
  organizationId: string,
  providerOrganizationId: string,
): provider is ProviderOrganization {
  return provider?.organizationId === organizationId &&
    provider.providerOrganizationId === providerOrganizationId;
}

function isBoundEmployee(
  employee: ProviderEmployee | null,
  organizationId: string,
  providerEmployeeId: string,
): employee is ProviderEmployee {
  return employee?.organizationId === organizationId &&
    employee.providerEmployeeId === providerEmployeeId;
}

async function authorize(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  permission: string,
  action: string,
  options: ProviderEmployeeOptions,
): Promise<string | null> {
  const result = await authorizeAndAuditOrganizationAction(request, state, action, options.audit);
  return result.authorized && request.requiredPermission === permission ? result.organizationId : null;
}

async function activeProvider(
  organizationId: string,
  providerOrganizationId: string,
  options: ProviderEmployeeOptions,
): Promise<ProviderOrganization | null> {
  const provider = await options.store.getProvider(organizationId, providerOrganizationId);
  return isBoundProvider(provider, organizationId, providerOrganizationId) &&
    provider.status !== 'suspended' && provider.status !== 'closed' ? provider : null;
}

export async function inviteProviderEmployee(
  contractVersion: number,
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  input: EmployeeInvitation,
  options: ProviderEmployeeOptions,
): Promise<ProviderEmployeeResult<ProviderEmployee>> {
  const organizationId = await authorize(
    request, state, 'provider-employee:write', 'provider-employee.invite', options,
  );
  const providerEmployeeId = options.createOpaqueId();
  const now = options.now();
  const permissions = normalizePermissions(input.permissions, options.permissionCatalog);
  if (!organizationId || contractVersion !== PROVIDER_EMPLOYEE_CONTRACT_VERSION ||
    !IDENTIFIER.test(providerEmployeeId) || !IDENTIFIER.test(input.providerOrganizationId) ||
    !IDENTIFIER.test(input.subjectId) || !validText(input.displayName, 120) ||
    !permissions || !validTimestamp(now)) return rejected();
  try {
    if (!await activeProvider(organizationId, input.providerOrganizationId, options)) return rejected();
    const employee = Object.freeze({
      providerEmployeeId, organizationId, providerOrganizationId: input.providerOrganizationId,
      subjectId: input.subjectId, displayName: input.displayName, permissions,
      status: 'invited' as const, version: 1, createdAt: now, updatedAt: now,
    });
    return await options.store.createEmployee(employee)
      ? {accepted: true, value: employee} : rejected();
  } catch {
    return rejected();
  }
}

export async function getProviderEmployee(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  providerOrganizationId: string,
  providerEmployeeId: string,
  options: ProviderEmployeeOptions,
): Promise<ProviderEmployeeResult<ProviderEmployee>> {
  const organizationId = await authorize(
    request, state, 'provider-employee:read', 'provider-employee.read', options,
  );
  if (!organizationId || !IDENTIFIER.test(providerOrganizationId) ||
    !IDENTIFIER.test(providerEmployeeId)) return rejected();
  try {
    const employee = await options.store.getEmployee(organizationId, providerEmployeeId);
    return isBoundEmployee(employee, organizationId, providerEmployeeId) &&
      employee.providerOrganizationId === providerOrganizationId && employee.status !== 'revoked'
      ? {accepted: true, value: employee} : rejected();
  } catch {
    return rejected();
  }
}

export async function listProviderEmployees(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  providerOrganizationId: string,
  options: ProviderEmployeeOptions,
): Promise<ProviderEmployeeResult<readonly ProviderEmployee[]>> {
  const organizationId = await authorize(
    request, state, 'provider-employee:read', 'provider-employee.list', options,
  );
  if (!organizationId || !IDENTIFIER.test(providerOrganizationId)) return rejected();
  try {
    const provider = await options.store.getProvider(organizationId, providerOrganizationId);
    if (!isBoundProvider(provider, organizationId, providerOrganizationId) ||
      provider.status === 'closed') return rejected();
    const employees = await options.store.listEmployees(organizationId, providerOrganizationId);
    if (employees.some(employee => employee.organizationId !== organizationId ||
      employee.providerOrganizationId !== providerOrganizationId)) return rejected();
    return {accepted: true, value: Object.freeze(employees.filter(employee => employee.status !== 'revoked'))};
  } catch {
    return rejected();
  }
}

export async function replaceProviderEmployeePermissions(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  providerOrganizationId: string,
  providerEmployeeId: string,
  expectedVersion: number,
  permissionsInput: readonly string[],
  options: ProviderEmployeeOptions,
): Promise<ProviderEmployeeResult<ProviderEmployee>> {
  const organizationId = await authorize(
    request, state, 'provider-permission:grant', 'provider-employee.permissions', options,
  );
  const now = options.now();
  const permissions = normalizePermissions(permissionsInput, options.permissionCatalog);
  if (!organizationId || !IDENTIFIER.test(providerOrganizationId) ||
    !IDENTIFIER.test(providerEmployeeId) ||
    !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
    !permissions || !validTimestamp(now)) return rejected();
  try {
    const current = await options.store.getEmployee(organizationId, providerEmployeeId);
    if (!isBoundEmployee(current, organizationId, providerEmployeeId) ||
      current.providerOrganizationId !== providerOrganizationId || current.status === 'revoked' ||
      current.version !== expectedVersion || now < current.updatedAt ||
      !await activeProvider(organizationId, providerOrganizationId, options)) return rejected();
    const replacement = Object.freeze({
      ...current, permissions, version: current.version + 1, updatedAt: now,
    });
    return await options.store.replaceEmployee(current, replacement)
      ? {accepted: true, value: replacement} : rejected();
  } catch {
    return rejected();
  }
}

const TRANSITIONS: Readonly<Record<ProviderEmployee['status'], readonly ProviderEmployee['status'][]>> = {
  invited: ['active', 'revoked'],
  active: ['suspended', 'revoked'],
  suspended: ['active', 'revoked'],
  revoked: [],
};

export async function transitionProviderEmployee(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  providerOrganizationId: string,
  providerEmployeeId: string,
  expectedVersion: number,
  status: ProviderEmployee['status'],
  options: ProviderEmployeeOptions,
): Promise<ProviderEmployeeResult<ProviderEmployee>> {
  const organizationId = await authorize(
    request, state, 'provider-employee:write', 'provider-employee.transition', options,
  );
  const now = options.now();
  if (!organizationId || !IDENTIFIER.test(providerOrganizationId) ||
    !IDENTIFIER.test(providerEmployeeId) ||
    !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !validTimestamp(now)) return rejected();
  try {
    const current = await options.store.getEmployee(organizationId, providerEmployeeId);
    if (!isBoundEmployee(current, organizationId, providerEmployeeId) ||
      current.providerOrganizationId !== providerOrganizationId ||
      current.version !== expectedVersion || now < current.updatedAt ||
      !TRANSITIONS[current.status].includes(status)) return rejected();
    if (status === 'active' && !await activeProvider(
      organizationId, providerOrganizationId, options,
    )) return rejected();
    const replacement = Object.freeze({...current, status, version: current.version + 1, updatedAt: now});
    return await options.store.replaceEmployee(current, replacement)
      ? {accepted: true, value: replacement} : rejected();
  } catch {
    return rejected();
  }
}
