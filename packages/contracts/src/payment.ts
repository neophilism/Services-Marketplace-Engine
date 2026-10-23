import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const PAYMENT_ABSTRACTION_CONTRACT_VERSION = 1 as const;
export const PAYMENT_ABSTRACTION_REJECTED = 'payment_abstraction_rejected' as const;

export interface PaymentJobRoom { readonly organizationId: string; readonly jobRoomId: string; readonly customerSubjectId: string; readonly providerOrganizationId: string; readonly status: 'active' | 'completed' | 'closed'; }
export interface ConnectedPaymentAccount { readonly paymentAccountId: string; readonly organizationId: string; readonly providerOrganizationId: string; readonly processor: 'stripe_connect'; readonly processorAccountReference: string; readonly status: 'active' | 'restricted' | 'closed'; readonly chargesEnabled: boolean; readonly payoutsEnabled: boolean; }
export interface ProcessorPaymentIntentRequest { readonly idempotencyKey: string; readonly destinationAccountReference: string; readonly amountMinor: number; readonly currency: string; readonly metadata: Readonly<{organizationId: string; jobRoomId: string; paymentIntentId: string}>; }
export interface ProcessorPaymentIntent { readonly processor: 'stripe_connect'; readonly processorIntentReference: string; readonly destinationAccountReference: string; readonly amountMinor: number; readonly currency: string; readonly status: 'requires_payment_method' | 'requires_action' | 'authorized'; }
export interface PaymentProcessorAdapter { createPaymentIntent(request: ProcessorPaymentIntentRequest): Promise<ProcessorPaymentIntent>; }
export interface MarketplacePaymentIntent { readonly paymentIntentId: string; readonly organizationId: string; readonly requestKey: string; readonly jobRoomId: string; readonly customerSubjectId: string; readonly providerOrganizationId: string; readonly paymentAccountId: string; readonly processor: 'stripe_connect'; readonly processorIntentReference: string; readonly amountMinor: number; readonly currency: string; readonly status: ProcessorPaymentIntent['status']; readonly createdAt: number; }
export interface CreatePaymentIntentInput { readonly requestKey: string; readonly jobRoomId: string; readonly paymentAccountId: string; readonly amountMinor: number; readonly currency: string; }
export interface PaymentAbstractionStore {
  getJobRoom(organizationId: string, jobRoomId: string): Promise<PaymentJobRoom | null>;
  getPaymentAccount(organizationId: string, paymentAccountId: string): Promise<ConnectedPaymentAccount | null>;
  getPaymentIntentByRequestKey(organizationId: string, requestKey: string): Promise<MarketplacePaymentIntent | null>;
  recordPaymentIntent(value: MarketplacePaymentIntent): Promise<boolean>;
}
export interface PaymentAbstractionOptions { readonly store: PaymentAbstractionStore; readonly processor: PaymentProcessorAdapter; readonly audit: TenantAuditOptions; readonly now: () => number; }
export type PaymentAbstractionResult<T> = {readonly accepted: true; readonly value: T; readonly replayed: boolean} | {readonly accepted: false; readonly code: typeof PAYMENT_ABSTRACTION_REJECTED};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CURRENCY = /^[A-Z]{3}$/;
const MAX_AMOUNT_MINOR = 9_999_999_999;
const MAX_DATE = 8_640_000_000_000_000;
const rejected = <T>(): PaymentAbstractionResult<T> => ({accepted:false, code:PAYMENT_ABSTRACTION_REJECTED});
const timestamp = (value:number):boolean => Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE;
const amount = (value:number):boolean => Number.isSafeInteger(value) && value > 0 && value <= MAX_AMOUNT_MINOR;
const processorStatus = (value:string):value is ProcessorPaymentIntent['status'] => value === 'requires_payment_method' || value === 'requires_action' || value === 'authorized';
const boundIntent = (value:MarketplacePaymentIntent|null, organizationId:string):value is MarketplacePaymentIntent => value?.organizationId === organizationId && ID.test(value.paymentIntentId) && ID.test(value.requestKey) && ID.test(value.jobRoomId) && ID.test(value.customerSubjectId) && ID.test(value.providerOrganizationId) && ID.test(value.paymentAccountId) && value.processor === 'stripe_connect' && ID.test(value.processorIntentReference) && amount(value.amountMinor) && CURRENCY.test(value.currency) && processorStatus(value.status) && timestamp(value.createdAt);

export async function createStripeConnectPaymentIntent(contractVersion:number, request:OrganizationAuthorizationRequest, state:OrganizationAuthorizationState, input:CreatePaymentIntentInput, options:PaymentAbstractionOptions):Promise<PaymentAbstractionResult<MarketplacePaymentIntent>> {
  const auth = await authorizeAndAuditOrganizationAction(request,state,'commerce.payment-intent.create',options.audit);
  const now = options.now();
  if(!auth.authorized || request.requiredPermission !== 'commerce:payment-intents:create' || contractVersion !== PAYMENT_ABSTRACTION_CONTRACT_VERSION || !timestamp(now) || !ID.test(input.requestKey) || !ID.test(input.jobRoomId) || !ID.test(input.paymentAccountId) || !amount(input.amountMinor) || !CURRENCY.test(input.currency)) return rejected();
  try {
    const [room,account,replay] = await Promise.all([
      options.store.getJobRoom(auth.organizationId,input.jobRoomId),
      options.store.getPaymentAccount(auth.organizationId,input.paymentAccountId),
      options.store.getPaymentIntentByRequestKey(auth.organizationId,input.requestKey),
    ]);
    if(room?.organizationId !== auth.organizationId || room.jobRoomId !== input.jobRoomId || room.customerSubjectId !== auth.subjectId || room.status !== 'active' || !ID.test(room.providerOrganizationId) || account?.organizationId !== auth.organizationId || account.paymentAccountId !== input.paymentAccountId || account.providerOrganizationId !== room.providerOrganizationId || account.processor !== 'stripe_connect' || !ID.test(account.processorAccountReference) || account.status !== 'active' || !account.chargesEnabled || !account.payoutsEnabled) return rejected();
    if(replay !== null) return boundIntent(replay,auth.organizationId) && replay.requestKey === input.requestKey && replay.jobRoomId === input.jobRoomId && replay.customerSubjectId === auth.subjectId && replay.providerOrganizationId === room.providerOrganizationId && replay.paymentAccountId === input.paymentAccountId && replay.amountMinor === input.amountMinor && replay.currency === input.currency ? {accepted:true,value:replay,replayed:true} : rejected();
    // The opaque request key is also the stable local intent id so a retry after
    // processor success cannot bind that processor object to a different id.
    const paymentIntentId = input.requestKey;
    const provider = await options.processor.createPaymentIntent(Object.freeze({idempotencyKey:input.requestKey,destinationAccountReference:account.processorAccountReference,amountMinor:input.amountMinor,currency:input.currency,metadata:Object.freeze({organizationId:auth.organizationId,jobRoomId:input.jobRoomId,paymentIntentId})}));
    if(provider.processor !== 'stripe_connect' || !ID.test(provider.processorIntentReference) || provider.destinationAccountReference !== account.processorAccountReference || provider.amountMinor !== input.amountMinor || provider.currency !== input.currency || !processorStatus(provider.status)) return rejected();
    const value:MarketplacePaymentIntent = Object.freeze({paymentIntentId,organizationId:auth.organizationId,requestKey:input.requestKey,jobRoomId:input.jobRoomId,customerSubjectId:auth.subjectId,providerOrganizationId:room.providerOrganizationId,paymentAccountId:input.paymentAccountId,processor:'stripe_connect',processorIntentReference:provider.processorIntentReference,amountMinor:input.amountMinor,currency:input.currency,status:provider.status,createdAt:now});
    return boundIntent(value,auth.organizationId) && await options.store.recordPaymentIntent(value) ? {accepted:true,value,replayed:false} : rejected();
  } catch { return rejected(); }
}
