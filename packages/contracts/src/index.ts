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
export * from './provider-employee.js';
export * from './service-taxonomy.js';
export * from './provider-onboarding.js';
export * from './insurance.js';
export * from './credential-check.js';
export * from './territory.js';
export * from './search.js';
export * from './availability.js';
export * from './lead.js';
export * from './lead-workflow.js';
export * from './review-dispute.js';
export * from './saved-provider.js';
export * from './job-room.js';
export * from './job-room-chat.js';
export * from './job-room-media.js';
export * from './job-room-estimate.js';
export * from './esign.js';
export * from './scheduling.js';
export * from './technician-task.js';
