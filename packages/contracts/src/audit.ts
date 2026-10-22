import {
  authorizeOrganizationAction,
  type OrganizationAuthorizationRequest,
  type OrganizationAuthorizationResult,
  type OrganizationAuthorizationState,
} from './rbac.js';

export interface TenantAuthorizationAuditEvent {
  readonly eventId: string;
  readonly occurredAt: number;
  readonly action: string;
  readonly subjectId: string | null;
  readonly organizationId: string | null;
  readonly resourceOrganizationId: string;
  readonly outcome: 'authorized' | 'denied';
}

export interface TenantAuditSink {
  append(event: TenantAuthorizationAuditEvent): Promise<void>;
}

export interface TenantAuditOptions {
  readonly sink: TenantAuditSink;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
}

export async function authorizeAndAuditOrganizationAction(
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  action: string,
  options: TenantAuditOptions,
): Promise<OrganizationAuthorizationResult> {
  const result = authorizeOrganizationAction(request, state);
  const eventId = options.createOpaqueId();
  const occurredAt = options.now();
  if (!eventId || !action || !Number.isSafeInteger(occurredAt) || occurredAt < 0) {
    return {authorized: false, code: 'authorization_denied'};
  }

  const event = Object.freeze({
    eventId,
    occurredAt,
    action,
    subjectId: request.subjectId ?? null,
    organizationId: request.organizationId ?? null,
    resourceOrganizationId: request.resourceOrganizationId,
    outcome: result.authorized ? 'authorized' as const : 'denied' as const,
  });

  try {
    await options.sink.append(event);
  } catch {
    return {authorized: false, code: 'authorization_denied'};
  }
  return result;
}
