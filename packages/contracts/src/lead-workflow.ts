import {
  authorizeAndAuditOrganizationAction,
  type TenantAuditOptions,
} from './audit.js';
import type {
  OrganizationAuthorizationRequest,
  OrganizationAuthorizationState,
} from './rbac.js';

export const LEAD_WORKFLOW_CONTRACT_VERSION = 1 as const;
export const LEAD_WORKFLOW_REJECTED = 'lead_workflow_rejected' as const;

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const REQUEST_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const REASON_CODE = /^[a-z][a-z0-9_]{1,63}$/;
const CURRENCY = /^[A-Z]{3}$/;

export interface MatchedLead {
  readonly organizationId: string;
  readonly leadId: string;
  readonly providerOrganizationId: string;
  readonly serviceRevision: number;
  readonly status: 'open' | 'closed';
}

export interface ProviderOperator {
  readonly organizationId: string;
  readonly providerOrganizationId: string;
  readonly subjectId: string;
  readonly status: 'active' | 'inactive';
  readonly permissions: readonly string[];
}

export interface LeadTriage {
  readonly triageId: string;
  readonly organizationId: string;
  readonly requestKey: string;
  readonly leadId: string;
  readonly providerOrganizationId: string;
  readonly decision: 'interested' | 'declined';
  readonly declineReasonCode: string | null;
  readonly createdAt: number;
}

export interface QuoteLineItem {
  readonly label: string;
  readonly amountMinor: number;
}

export interface LeadQuote {
  readonly quoteId: string;
  readonly organizationId: string;
  readonly requestKey: string;
  readonly leadId: string;
  readonly providerOrganizationId: string;
  readonly serviceRevision: number;
  readonly version: number;
  readonly supersedesQuoteId: string | null;
  readonly currency: string;
  readonly lineItems: readonly QuoteLineItem[];
  readonly totalMinor: number;
  readonly validUntil: number;
  readonly createdAt: number;
}

export interface TriageInput {
  readonly requestKey: string;
  readonly leadId: string;
  readonly providerOrganizationId: string;
  readonly decision: 'interested' | 'declined';
  readonly declineReasonCode: string | null;
}

export interface QuoteInput {
  readonly requestKey: string;
  readonly leadId: string;
  readonly providerOrganizationId: string;
  readonly currency: string;
  readonly lineItems: readonly QuoteLineItem[];
  readonly validUntil: number;
}

export interface LeadWorkflowStore {
  getMatchedLead(organizationId: string, leadId: string,
    providerOrganizationId: string): Promise<MatchedLead | null>;
  getProviderOperator(organizationId: string, providerOrganizationId: string,
    subjectId: string): Promise<ProviderOperator | null>;
  getTriageByRequestKey(organizationId: string,
    requestKey: string): Promise<LeadTriage | null>;
  getCurrentTriage(organizationId: string, leadId: string,
    providerOrganizationId: string): Promise<LeadTriage | null>;
  createTriage(value: LeadTriage): Promise<boolean>;
  getQuoteByRequestKey(organizationId: string,
    requestKey: string): Promise<LeadQuote | null>;
  getLatestQuote(organizationId: string, leadId: string,
    providerOrganizationId: string): Promise<LeadQuote | null>;
  createQuote(value: LeadQuote): Promise<boolean>;
}

export interface LeadWorkflowOptions {
  readonly store: LeadWorkflowStore;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
}

export type LeadWorkflowResult<T> =
  | {readonly accepted: true; readonly value: T; readonly replayed: boolean}
  | {readonly accepted: false; readonly code: typeof LEAD_WORKFLOW_REJECTED};

const rejected = <T>(): LeadWorkflowResult<T> => ({
  accepted: false,
  code: LEAD_WORKFLOW_REJECTED,
});

const timestamp = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

function validTriageInput(value: TriageInput): boolean {
  return REQUEST_KEY.test(value.requestKey) && IDENTIFIER.test(value.leadId) &&
    IDENTIFIER.test(value.providerOrganizationId) &&
    ((value.decision === 'interested' && value.declineReasonCode === null) ||
      (value.decision === 'declined' && value.declineReasonCode !== null &&
        REASON_CODE.test(value.declineReasonCode)));
}

function validLineItems(values: readonly QuoteLineItem[]): boolean {
  if (values.length < 1 || values.length > 50) return false;
  return values.every(value => value.label === value.label.trim() &&
    value.label.length >= 1 && value.label.length <= 120 &&
    Number.isSafeInteger(value.amountMinor) && value.amountMinor >= 0 &&
    value.amountMinor <= 1_000_000_000_000);
}

function quoteTotal(values: readonly QuoteLineItem[]): number | null {
  let total = 0;
  for (const value of values) {
    total += value.amountMinor;
    if (!Number.isSafeInteger(total) || total > 1_000_000_000_000) return null;
  }
  return total;
}

function validQuoteInput(value: QuoteInput, now: number): boolean {
  return REQUEST_KEY.test(value.requestKey) && IDENTIFIER.test(value.leadId) &&
    IDENTIFIER.test(value.providerOrganizationId) && CURRENCY.test(value.currency) &&
    validLineItems(value.lineItems) && timestamp(value.validUntil) &&
    value.validUntil > now && value.validUntil <= now + 31 * 24 * 60 * 60 * 1_000;
}

function boundLead(value: MatchedLead | null, organizationId: string,
  leadId: string, providerOrganizationId: string): value is MatchedLead {
  return value?.organizationId === organizationId && value.leadId === leadId &&
    value.providerOrganizationId === providerOrganizationId && value.status === 'open' &&
    Number.isSafeInteger(value.serviceRevision) && value.serviceRevision >= 1;
}

function boundOperator(value: ProviderOperator | null, organizationId: string,
  providerOrganizationId: string, subjectId: string, permission: string): boolean {
  return value?.organizationId === organizationId &&
    value.providerOrganizationId === providerOrganizationId &&
    value.subjectId === subjectId && value.status === 'active' &&
    value.permissions.includes(permission);
}

function boundTriage(value: LeadTriage | null, organizationId: string,
  input: TriageInput): value is LeadTriage {
  return value?.organizationId === organizationId && value.requestKey === input.requestKey &&
    value.leadId === input.leadId &&
    value.providerOrganizationId === input.providerOrganizationId &&
    value.decision === input.decision && value.declineReasonCode === input.declineReasonCode &&
    IDENTIFIER.test(value.triageId) && timestamp(value.createdAt);
}

function boundCurrentTriage(value: LeadTriage | null, organizationId: string,
  leadId: string, providerOrganizationId: string): value is LeadTriage {
  return value?.organizationId === organizationId && value.leadId === leadId &&
    value.providerOrganizationId === providerOrganizationId &&
    value.decision === 'interested' && value.declineReasonCode === null &&
    IDENTIFIER.test(value.triageId) && timestamp(value.createdAt);
}

function boundQuote(value: LeadQuote | null, organizationId: string,
  input: QuoteInput, serviceRevision: number): value is LeadQuote {
  if (value?.organizationId !== organizationId || value.requestKey !== input.requestKey ||
    value.leadId !== input.leadId ||
    value.providerOrganizationId !== input.providerOrganizationId ||
    value.serviceRevision !== serviceRevision || value.currency !== input.currency ||
    value.validUntil !== input.validUntil || !IDENTIFIER.test(value.quoteId) ||
    !Number.isSafeInteger(value.version) || value.version < 1 || !timestamp(value.createdAt) ||
    value.lineItems.length !== input.lineItems.length) return false;
  return value.lineItems.every((line, index) => line.label === input.lineItems[index]?.label &&
    line.amountMinor === input.lineItems[index]?.amountMinor) &&
    value.totalMinor === quoteTotal(input.lineItems);
}

async function authorize(request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState, action: string, permission: string,
  options: LeadWorkflowOptions): Promise<{organizationId: string; subjectId: string} | null> {
  const result = await authorizeAndAuditOrganizationAction(request, state, action, options.audit);
  return result.authorized && request.requiredPermission === permission
    ? {organizationId: result.organizationId, subjectId: result.subjectId} : null;
}

export async function triageMatchedLead(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: TriageInput, options: LeadWorkflowOptions): Promise<LeadWorkflowResult<LeadTriage>> {
  const identity = await authorize(request, state, 'lead.triage', 'leads:triage', options);
  const now = options.now();
  if (!identity || contractVersion !== LEAD_WORKFLOW_CONTRACT_VERSION || !timestamp(now) ||
    !validTriageInput(input)) return rejected();
  try {
    const [lead, operator, existing] = await Promise.all([
      options.store.getMatchedLead(identity.organizationId, input.leadId,
        input.providerOrganizationId),
      options.store.getProviderOperator(identity.organizationId, input.providerOrganizationId,
        identity.subjectId),
      options.store.getTriageByRequestKey(identity.organizationId, input.requestKey),
    ]);
    if (!boundLead(lead, identity.organizationId, input.leadId,
      input.providerOrganizationId) || !boundOperator(operator, identity.organizationId,
      input.providerOrganizationId, identity.subjectId, 'leads:triage')) return rejected();
    if (existing !== null) return boundTriage(existing, identity.organizationId, input)
      ? {accepted: true, value: existing, replayed: true} : rejected();
    if (await options.store.getCurrentTriage(identity.organizationId, input.leadId,
      input.providerOrganizationId) !== null) return rejected();
    const triageId = options.createOpaqueId();
    if (!IDENTIFIER.test(triageId)) return rejected();
    const triage = Object.freeze({...input, triageId,
      organizationId: identity.organizationId, createdAt: now});
    if (!await options.store.createTriage(triage)) return rejected();
    return {accepted: true, value: triage, replayed: false};
  } catch {
    return rejected();
  }
}

export async function createLeadQuote(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: QuoteInput, options: LeadWorkflowOptions): Promise<LeadWorkflowResult<LeadQuote>> {
  const identity = await authorize(request, state, 'lead.quote.create', 'quotes:create', options);
  const now = options.now();
  if (!identity || contractVersion !== LEAD_WORKFLOW_CONTRACT_VERSION || !timestamp(now) ||
    !validQuoteInput(input, now)) return rejected();
  try {
    const [lead, operator, triage, existing, latest] = await Promise.all([
      options.store.getMatchedLead(identity.organizationId, input.leadId,
        input.providerOrganizationId),
      options.store.getProviderOperator(identity.organizationId, input.providerOrganizationId,
        identity.subjectId),
      options.store.getCurrentTriage(identity.organizationId, input.leadId,
        input.providerOrganizationId),
      options.store.getQuoteByRequestKey(identity.organizationId, input.requestKey),
      options.store.getLatestQuote(identity.organizationId, input.leadId,
        input.providerOrganizationId),
    ]);
    if (!boundLead(lead, identity.organizationId, input.leadId,
      input.providerOrganizationId) || !boundOperator(operator, identity.organizationId,
      input.providerOrganizationId, identity.subjectId, 'quotes:create') ||
      !boundCurrentTriage(triage, identity.organizationId, input.leadId,
        input.providerOrganizationId)) return rejected();
    if (existing !== null) return boundQuote(existing, identity.organizationId, input,
      lead.serviceRevision) ? {accepted: true, value: existing, replayed: true} : rejected();
    if (latest !== null && (!boundQuote(latest, identity.organizationId, {
      requestKey: latest.requestKey, leadId: input.leadId,
      providerOrganizationId: input.providerOrganizationId, currency: latest.currency,
      lineItems: latest.lineItems, validUntil: latest.validUntil,
    }, lead.serviceRevision) || latest.version >= Number.MAX_SAFE_INTEGER)) return rejected();
    const totalMinor = quoteTotal(input.lineItems);
    const quoteId = options.createOpaqueId();
    if (totalMinor === null || !IDENTIFIER.test(quoteId)) return rejected();
    const lineItems = Object.freeze(input.lineItems.map(value => Object.freeze({...value})));
    const quote = Object.freeze({
      quoteId, organizationId: identity.organizationId, requestKey: input.requestKey,
      leadId: input.leadId, providerOrganizationId: input.providerOrganizationId,
      serviceRevision: lead.serviceRevision, version: (latest?.version ?? 0) + 1,
      supersedesQuoteId: latest?.quoteId ?? null, currency: input.currency, lineItems,
      totalMinor, validUntil: input.validUntil, createdAt: now,
    });
    if (!await options.store.createQuote(quote)) return rejected();
    return {accepted: true, value: quote, replayed: false};
  } catch {
    return rejected();
  }
}
