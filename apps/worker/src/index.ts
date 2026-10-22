import {
  AUTHORIZATION_DENIED,
  BOOTSTRAP_CONTRACT_VERSION,
  authorizeTenantAccess,
  type AuthorizationContext,
} from '@services-marketplace/contracts';

export interface WorkerMessage {
  readonly contractVersion: number;
  readonly context: AuthorizationContext;
  readonly organizationId: string;
  readonly taskId: string;
}

export type WorkerResult =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly code: typeof AUTHORIZATION_DENIED | 'unsupported_contract_version' };

export async function processTask(
  message: WorkerMessage,
  runTask: (organizationId: string, taskId: string) => Promise<void>,
): Promise<WorkerResult> {
  if (message.contractVersion !== BOOTSTRAP_CONTRACT_VERSION) {
    return {accepted: false, code: 'unsupported_contract_version'};
  }

  const authorization = authorizeTenantAccess(
    message.context,
    message.organizationId,
    'task:execute',
  );
  if (!authorization.authorized) {
    return {accepted: false, code: AUTHORIZATION_DENIED};
  }

  await runTask(authorization.organizationId, message.taskId);
  return {accepted: true};
}
