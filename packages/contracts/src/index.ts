export const BOOTSTRAP_CONTRACT_VERSION = 1 as const;
export const AUTHORIZATION_DENIED = 'authorization_denied' as const;

export interface Membership {
  readonly organizationId: string;
  readonly status: 'active' | 'inactive' | 'revoked';
  readonly permissions: readonly string[];
}

export interface AuthorizationContext {
  readonly subjectId?: string;
  readonly organizationId?: string;
  readonly memberships: readonly Membership[];
}

export type AuthorizationResult =
  | { readonly authorized: true; readonly organizationId: string; readonly subjectId: string }
  | { readonly authorized: false; readonly code: typeof AUTHORIZATION_DENIED };

export function authorizeTenantAccess(
  context: AuthorizationContext,
  resourceOrganizationId: string,
  requiredPermission: string,
): AuthorizationResult {
  if (!context.subjectId || !context.organizationId || context.organizationId !== resourceOrganizationId) {
    return {authorized: false, code: AUTHORIZATION_DENIED};
  }
  const membership = context.memberships.find(
    candidate => candidate.organizationId === context.organizationId,
  );
  if (
    membership?.status !== 'active' ||
    !membership.permissions.includes(requiredPermission)
  ) {
    return {authorized: false, code: AUTHORIZATION_DENIED};
  }

  return {
    authorized: true,
    organizationId: context.organizationId,
    subjectId: context.subjectId,
  };
}

export * from './identity.js';
export * from './rbac.js';
export * from './audit.js';
export * from './outbox.js';
export * from './attachment.js';
export * from './customer.js';
export * from './provider.js';
