import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const PRICING_FEE_CAP_CONTRACT_VERSION = 1 as const;
export const PRICING_FEE_CAP_REJECTED = 'pricing_fee_cap_rejected' as const;

export interface PricingJobRoom { readonly organizationId: string; readonly jobRoomId: string; readonly customerSubjectId: string; readonly providerOrganizationId: string; readonly status: 'active' | 'completed' | 'closed'; }
export interface PricingPolicy { readonly pricingPolicyId: string; readonly organizationId: string; readonly providerOrganizationId: string; readonly revision: number; readonly status: 'active' | 'retired'; readonly currency: string; readonly customerFeeBasisPoints: number; readonly providerFeeBasisPoints: number; readonly customerFeeCapMinor: number; readonly providerFeeCapMinor: number; }
export interface MarketplacePriceQuote { readonly priceQuoteId: string; readonly organizationId: string; readonly requestKey: string; readonly jobRoomId: string; readonly customerSubjectId: string; readonly providerOrganizationId: string; readonly pricingPolicyId: string; readonly pricingPolicyRevision: number; readonly currency: string; readonly subtotalMinor: number; readonly customerFeeMinor: number; readonly customerTotalMinor: number; readonly providerFeeMinor: number; readonly providerNetMinor: number; readonly createdAt: number; }
export interface CreatePriceQuoteInput { readonly requestKey: string; readonly jobRoomId: string; readonly pricingPolicyId: string; readonly expectedPolicyRevision: number; readonly currency: string; readonly subtotalMinor: number; }
export interface PricingFeeCapStore { getJobRoom(organizationId:string,jobRoomId:string):Promise<PricingJobRoom|null>; getPricingPolicy(organizationId:string,pricingPolicyId:string):Promise<PricingPolicy|null>; getQuoteByRequestKey(organizationId:string,requestKey:string):Promise<MarketplacePriceQuote|null>; createQuote(value:MarketplacePriceQuote):Promise<boolean>; }
export interface PricingFeeCapOptions { readonly store: PricingFeeCapStore; readonly audit: TenantAuditOptions; readonly now: () => number; }
export type PricingFeeCapResult<T> = {readonly accepted:true;readonly value:T;readonly replayed:boolean}|{readonly accepted:false;readonly code:typeof PRICING_FEE_CAP_REJECTED};

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CURRENCY=/^[A-Z]{3}$/;
const MAX_MONEY=9_999_999_999;
const MAX_FEE_BASIS_POINTS=2_500;
const MAX_DATE=8_640_000_000_000_000;
const integer=(value:number,min:number,max:number):boolean=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const rejected=<T>():PricingFeeCapResult<T>=>({accepted:false,code:PRICING_FEE_CAP_REJECTED});
const validPolicy=(value:PricingPolicy|null,organizationId:string):value is PricingPolicy=>value?.organizationId===organizationId&&ID.test(value.pricingPolicyId)&&ID.test(value.providerOrganizationId)&&integer(value.revision,1,Number.MAX_SAFE_INTEGER)&&(value.status==='active'||value.status==='retired')&&CURRENCY.test(value.currency)&&integer(value.customerFeeBasisPoints,0,MAX_FEE_BASIS_POINTS)&&integer(value.providerFeeBasisPoints,0,MAX_FEE_BASIS_POINTS)&&integer(value.customerFeeCapMinor,0,MAX_MONEY)&&integer(value.providerFeeCapMinor,0,MAX_MONEY);
const validQuote=(value:MarketplacePriceQuote|null,organizationId:string):value is MarketplacePriceQuote=>value?.organizationId===organizationId&&ID.test(value.priceQuoteId)&&ID.test(value.requestKey)&&ID.test(value.jobRoomId)&&ID.test(value.customerSubjectId)&&ID.test(value.providerOrganizationId)&&ID.test(value.pricingPolicyId)&&integer(value.pricingPolicyRevision,1,Number.MAX_SAFE_INTEGER)&&CURRENCY.test(value.currency)&&integer(value.subtotalMinor,1,MAX_MONEY)&&integer(value.customerFeeMinor,0,MAX_MONEY)&&integer(value.customerTotalMinor,1,MAX_MONEY)&&integer(value.providerFeeMinor,0,MAX_MONEY)&&integer(value.providerNetMinor,0,MAX_MONEY)&&integer(value.createdAt,0,MAX_DATE)&&value.customerTotalMinor===value.subtotalMinor+value.customerFeeMinor&&value.providerNetMinor===value.subtotalMinor-value.providerFeeMinor;
const fee=(subtotal:number,basisPoints:number,cap:number):number=>Math.min(Math.floor(subtotal*basisPoints/10_000),cap);

export async function createMarketplacePriceQuote(contractVersion:number,request:OrganizationAuthorizationRequest,state:OrganizationAuthorizationState,input:CreatePriceQuoteInput,options:PricingFeeCapOptions):Promise<PricingFeeCapResult<MarketplacePriceQuote>>{
  const auth=await authorizeAndAuditOrganizationAction(request,state,'commerce.price-quote.create',options.audit),now=options.now();
  if(!auth.authorized||request.requiredPermission!=='commerce:pricing:quote'||contractVersion!==PRICING_FEE_CAP_CONTRACT_VERSION||!integer(now,0,MAX_DATE)||!ID.test(input.requestKey)||!ID.test(input.jobRoomId)||!ID.test(input.pricingPolicyId)||!integer(input.expectedPolicyRevision,1,Number.MAX_SAFE_INTEGER)||!CURRENCY.test(input.currency)||!integer(input.subtotalMinor,1,MAX_MONEY))return rejected();
  try{
    const [room,policy,replay]=await Promise.all([options.store.getJobRoom(auth.organizationId,input.jobRoomId),options.store.getPricingPolicy(auth.organizationId,input.pricingPolicyId),options.store.getQuoteByRequestKey(auth.organizationId,input.requestKey)]);
    if(room?.organizationId!==auth.organizationId||room.jobRoomId!==input.jobRoomId||room.customerSubjectId!==auth.subjectId||room.status!=='active'||!ID.test(room.providerOrganizationId)||!validPolicy(policy,auth.organizationId)||policy.pricingPolicyId!==input.pricingPolicyId||policy.providerOrganizationId!==room.providerOrganizationId||policy.status!=='active'||policy.revision!==input.expectedPolicyRevision||policy.currency!==input.currency)return rejected();
    if(replay!==null)return validQuote(replay,auth.organizationId)&&replay.requestKey===input.requestKey&&replay.jobRoomId===input.jobRoomId&&replay.customerSubjectId===auth.subjectId&&replay.providerOrganizationId===room.providerOrganizationId&&replay.pricingPolicyId===input.pricingPolicyId&&replay.pricingPolicyRevision===input.expectedPolicyRevision&&replay.currency===input.currency&&replay.subtotalMinor===input.subtotalMinor?{accepted:true,value:replay,replayed:true}:rejected();
    const customerFeeMinor=fee(input.subtotalMinor,policy.customerFeeBasisPoints,policy.customerFeeCapMinor),providerFeeMinor=fee(input.subtotalMinor,policy.providerFeeBasisPoints,policy.providerFeeCapMinor);
    if(input.subtotalMinor+customerFeeMinor>MAX_MONEY)return rejected();
    const value:MarketplacePriceQuote=Object.freeze({priceQuoteId:input.requestKey,organizationId:auth.organizationId,requestKey:input.requestKey,jobRoomId:input.jobRoomId,customerSubjectId:auth.subjectId,providerOrganizationId:room.providerOrganizationId,pricingPolicyId:policy.pricingPolicyId,pricingPolicyRevision:policy.revision,currency:input.currency,subtotalMinor:input.subtotalMinor,customerFeeMinor,customerTotalMinor:input.subtotalMinor+customerFeeMinor,providerFeeMinor,providerNetMinor:input.subtotalMinor-providerFeeMinor,createdAt:now});
    return validQuote(value,auth.organizationId)&&await options.store.createQuote(value)?{accepted:true,value,replayed:false}:rejected();
  }catch{return rejected();}
}
