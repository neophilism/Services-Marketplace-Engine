import {
  AUTHORIZATION_DENIED,
  BOOTSTRAP_CONTRACT_VERSION,
  authorizeTenantAccess,
  type AuthorizationContext,
} from '@services-marketplace/contracts';

export interface ApiRequest {
  readonly contractVersion: number;
  readonly context: AuthorizationContext;
  readonly organizationId: string;
  readonly resourceId: string;
}

export type ApiResponse =
  | { readonly status: 200; readonly body: { readonly id: string; readonly organizationId: string } }
  | { readonly status: 400; readonly body: { readonly code: 'unsupported_contract_version' } }
  | { readonly status: 403; readonly body: { readonly code: typeof AUTHORIZATION_DENIED } };

export async function handleResourceRead(
  request: ApiRequest,
  findResource: (organizationId: string, resourceId: string) => Promise<{id: string}>,
): Promise<ApiResponse> {
  if (request.contractVersion !== BOOTSTRAP_CONTRACT_VERSION) {
    return {status: 400, body: {code: 'unsupported_contract_version'}};
  }

  const authorization = authorizeTenantAccess(
    request.context,
    request.organizationId,
    'resource:read',
  );
  if (!authorization.authorized) {
    return {status: 403, body: {code: authorization.code}};
  }

  const resource = await findResource(authorization.organizationId, request.resourceId);
  return {
    status: 200,
    body: {id: resource.id, organizationId: authorization.organizationId},
  };
}
