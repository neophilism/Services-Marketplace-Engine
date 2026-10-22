export const RBAC_DENIED = 'authorization_denied' as const;

export interface Organization {
  readonly organizationId: string;
  readonly status: 'active' | 'suspended' | 'closed';
}

export interface OrganizationRole {
  readonly roleId: string;
  readonly organizationId: string;
  readonly permissions: readonly string[];
}

export interface OrganizationMembership {
  readonly subjectId: string;
  readonly organizationId: string;
  readonly status: 'invited' | 'active' | 'suspended' | 'revoked';
  readonly roleIds: readonly string[];
}

export interface OrganizationAuthorizationRequest {
  readonly subjectId?: string;
  readonly organizationId?: string;
  readonly resourceOrganizationId: string;
  readonly requiredPermission: string;
}

export interface OrganizationAuthorizationState {
  readonly organizations: readonly Organization[];
  readonly memberships: readonly OrganizationMembership[];
  readonly roles: readonly OrganizationRole[];
}

export type OrganizationAuthorizationResult =
  | {
      readonly authorized: true;
      readonly organizationId: string;
      readonly subjectId: string;
      readonly roleIds: readonly string[];
    }
  | {readonly authorized: false; readonly code: typeof RBAC_DENIED};

const denied = (): OrganizationAuthorizationResult => ({
  authorized: false,
  code: RBAC_DENIED,
});

export function authorizeOrganizationAction(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
): OrganizationAuthorizationResult {
  if (
    !request.subjectId ||
    !request.organizationId ||
    !request.requiredPermission ||
    request.organizationId !== request.resourceOrganizationId
  ) {
    return denied();
  }

  const organizations = state.organizations.filter(
    candidate => candidate.organizationId === request.organizationId,
  );
  if (organizations.length !== 1 || organizations[0]?.status !== 'active') return denied();

  const memberships = state.memberships.filter(
    candidate =>
      candidate.organizationId === request.organizationId &&
      candidate.subjectId === request.subjectId,
  );
  const membership = memberships[0];
  if (memberships.length !== 1 || membership?.status !== 'active') return denied();

  const uniqueRoleIds = new Set(membership.roleIds);
  if (uniqueRoleIds.size !== membership.roleIds.length || uniqueRoleIds.size === 0) return denied();

  const resolvedRoles = [...uniqueRoleIds].map(roleId =>
    state.roles.filter(candidate => candidate.roleId === roleId),
  );
  if (
    resolvedRoles.some(matches =>
      matches.length !== 1 || matches[0]?.organizationId !== request.organizationId,
    )
  ) {
    return denied();
  }

  const hasPermission = resolvedRoles.some(matches =>
    matches[0]?.permissions.includes(request.requiredPermission),
  );
  if (!hasPermission) return denied();

  return {
    authorized: true,
    organizationId: request.organizationId,
    subjectId: request.subjectId,
    roleIds: [...uniqueRoleIds].sort(),
  };
}
