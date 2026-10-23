import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const LEAD_CONTRACT_VERSION = 1 as const;
export const LEAD_REJECTED = 'lead_rejected' as const;

export interface LeadCustomer {
  readonly customerProfileId: string;
  readonly organizationId: string;
  readonly status: 'active' | 'inactive';
}

export interface LeadService {
  readonly organizationId: string;
  readonly serviceKey: string;
  readonly revision: number;
  readonly status: 'draft' | 'published' | 'retired';
}

export interface LeadCandidate {
  readonly organizationId: string;
  readonly providerOrganizationId: string;
  readonly serviceKey: string;
  readonly serviceRevision: number;
  readonly status: 'active' | 'inactive';
  readonly eligible: boolean;
  readonly rankScore: number;
  readonly notificationRecipientId: string;
}

export interface LeadInput {
  readonly requestKey: string;
  readonly customerProfileId: string;
  readonly serviceKey: string;
  readonly summary: string;
  readonly requestedStartAt: number | null;
  readonly requestedEndAt: number | null;
  readonly maximumMatches: number;
}

export interface LeadMatch {
  readonly providerOrganizationId: string;
  readonly serviceRevision: number;
  readonly rankScore: number;
}

export interface Lead {
  readonly leadId: string;
  readonly organizationId: string;
  readonly requestKey: string;
  readonly customerProfileId: string;
  readonly serviceKey: string;
  readonly serviceRevision: number;
  readonly summary: string;
  readonly requestedStartAt: number | null;
  readonly requestedEndAt: number | null;
  readonly matches: readonly LeadMatch[];
  readonly status: 'open';
  readonly createdAt: number;
}

export interface LeadNotification {
  readonly notificationId: string;
  readonly organizationId: string;
  readonly leadId: string;
  readonly providerOrganizationId: string;
  readonly recipientId: string;
  readonly eventType: 'lead.matched';
  readonly occurredAt: number;
}

export interface LeadStore {
  getCustomer(organizationId: string, customerProfileId: string): Promise<LeadCustomer | null>;
  getPublishedService(organizationId: string, serviceKey: string): Promise<LeadService | null>;
  getLeadByRequestKey(organizationId: string, requestKey: string): Promise<Lead | null>;
  listMatchingCandidates(organizationId: string, serviceKey: string,
    requestedStartAt: number | null, requestedEndAt: number | null):
    Promise<readonly LeadCandidate[]>;
  createLead(lead: Lead, notifications: readonly LeadNotification[]): Promise<boolean>;
}

export interface LeadOptions {
  readonly store: LeadStore;
  readonly audit: TenantAuditOptions;
  readonly createOpaqueId: () => string;
  readonly now: () => number;
}

export interface LeadCreation {
  readonly lead: Lead;
  readonly notifications: readonly LeadNotification[];
  readonly replayed: boolean;
}

export type LeadResult<T> =
  | {readonly accepted: true; readonly value: T}
  | {readonly accepted: false; readonly code: typeof LEAD_REJECTED};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY = /^[a-z][a-z0-9-]{0,62}$/;
const DAY = 86_400_000;
const rejected = <T>(): LeadResult<T> => ({accepted: false, code: LEAD_REJECTED});

function timestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validInput(input: LeadInput, now: number): boolean {
  const noWindow = input.requestedStartAt === null && input.requestedEndAt === null;
  const validWindow = input.requestedStartAt !== null && input.requestedEndAt !== null &&
    timestamp(input.requestedStartAt) && timestamp(input.requestedEndAt) &&
    input.requestedStartAt >= now && input.requestedEndAt > input.requestedStartAt &&
    input.requestedEndAt - input.requestedStartAt <= 366 * DAY;
  return IDENTIFIER.test(input.requestKey) && IDENTIFIER.test(input.customerProfileId) &&
    KEY.test(input.serviceKey) && input.summary === input.summary.trim() &&
    input.summary.length > 0 && input.summary.length <= 2_000 &&
    Number.isSafeInteger(input.maximumMatches) && input.maximumMatches >= 1 &&
    input.maximumMatches <= 20 && (noWindow || validWindow);
}

function boundCustomer(value: LeadCustomer | null, organizationId: string,
  customerProfileId: string): value is LeadCustomer {
  return value?.organizationId === organizationId &&
    value.customerProfileId === customerProfileId && value.status === 'active';
}

function boundService(value: LeadService | null, organizationId: string,
  serviceKey: string): value is LeadService {
  return value?.organizationId === organizationId && value.serviceKey === serviceKey &&
    KEY.test(value.serviceKey) && Number.isSafeInteger(value.revision) && value.revision >= 1 &&
    value.status === 'published';
}

function boundCandidate(value: LeadCandidate, organizationId: string, service: LeadService): boolean {
  return value.organizationId === organizationId &&
    IDENTIFIER.test(value.providerOrganizationId) && value.serviceKey === service.serviceKey &&
    value.serviceRevision === service.revision && value.status === 'active' &&
    value.eligible === true && Number.isSafeInteger(value.rankScore) &&
    value.rankScore >= 0 && value.rankScore <= 1_000 &&
    IDENTIFIER.test(value.notificationRecipientId);
}

function boundLead(value: Lead | null, organizationId: string, input: LeadInput,
  service: LeadService): value is Lead {
  if (value?.organizationId !== organizationId || value.requestKey !== input.requestKey ||
    value.customerProfileId !== input.customerProfileId || value.serviceKey !== input.serviceKey ||
    value.serviceRevision !== service.revision || value.summary !== input.summary ||
    value.requestedStartAt !== input.requestedStartAt ||
    value.requestedEndAt !== input.requestedEndAt || value.status !== 'open' ||
    !IDENTIFIER.test(value.leadId) || !timestamp(value.createdAt) ||
    value.matches.length > input.maximumMatches) return false;
  if (new Set(value.matches.map(match => match.providerOrganizationId)).size !==
    value.matches.length) return false;
  return value.matches.every((match, index) => IDENTIFIER.test(match.providerOrganizationId) &&
    match.serviceRevision === service.revision && Number.isSafeInteger(match.rankScore) &&
    match.rankScore >= 0 && match.rankScore <= 1_000 &&
    (index === 0 || value.matches[index - 1]!.rankScore > match.rankScore ||
      (value.matches[index - 1]!.rankScore === match.rankScore &&
        value.matches[index - 1]!.providerOrganizationId.localeCompare(
          match.providerOrganizationId) < 0)));
}

async function authorize(request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState, options: LeadOptions): Promise<string | null> {
  const result = await authorizeAndAuditOrganizationAction(
    request, state, 'lead.create', options.audit);
  return result.authorized && request.requiredPermission === 'leads:create'
    ? result.organizationId : null;
}

export async function createMatchedLead(contractVersion: number,
  request: OrganizationAuthorizationRequest, state: OrganizationAuthorizationState,
  input: LeadInput, options: LeadOptions): Promise<LeadResult<LeadCreation>> {
  const organizationId = await authorize(request, state, options);
  const now = options.now();
  if (!organizationId || contractVersion !== LEAD_CONTRACT_VERSION ||
    !timestamp(now) || !validInput(input, now)) return rejected();
  try {
    const [customer, service] = await Promise.all([
      options.store.getCustomer(organizationId, input.customerProfileId),
      options.store.getPublishedService(organizationId, input.serviceKey),
    ]);
    if (!boundCustomer(customer, organizationId, input.customerProfileId) ||
      !boundService(service, organizationId, input.serviceKey)) return rejected();
    const existing = await options.store.getLeadByRequestKey(organizationId, input.requestKey);
    if (existing !== null) {
      return boundLead(existing, organizationId, input, service)
        ? {accepted: true, value: Object.freeze({
          lead: existing, notifications: Object.freeze([]), replayed: true,
        })} : rejected();
    }
    const candidates = await options.store.listMatchingCandidates(
      organizationId, input.serviceKey, input.requestedStartAt, input.requestedEndAt);
    if (candidates.length > 1_000 ||
      candidates.some(value => !boundCandidate(value, organizationId, service)) ||
      new Set(candidates.map(value => value.providerOrganizationId)).size !== candidates.length ||
      new Set(candidates.map(value => value.notificationRecipientId)).size !== candidates.length) {
      return rejected();
    }
    const selected = [...candidates].sort((left, right) =>
      right.rankScore - left.rankScore ||
      left.providerOrganizationId.localeCompare(right.providerOrganizationId))
      .slice(0, input.maximumMatches);
    const leadId = options.createOpaqueId();
    if (!IDENTIFIER.test(leadId)) return rejected();
    const matches = Object.freeze(selected.map(value => Object.freeze({
      providerOrganizationId: value.providerOrganizationId,
      serviceRevision: value.serviceRevision,
      rankScore: value.rankScore,
    })));
    const lead = Object.freeze({
      leadId, organizationId, requestKey: input.requestKey,
      customerProfileId: customer.customerProfileId, serviceKey: service.serviceKey,
      serviceRevision: service.revision, summary: input.summary,
      requestedStartAt: input.requestedStartAt, requestedEndAt: input.requestedEndAt,
      matches, status: 'open' as const, createdAt: now,
    });
    const notifications: LeadNotification[] = [];
    for (const candidate of selected) {
      const notificationId = options.createOpaqueId();
      if (!IDENTIFIER.test(notificationId)) return rejected();
      notifications.push(Object.freeze({
        notificationId, organizationId, leadId,
        providerOrganizationId: candidate.providerOrganizationId,
        recipientId: candidate.notificationRecipientId,
        eventType: 'lead.matched' as const, occurredAt: now,
      }));
    }
    const frozenNotifications = Object.freeze(notifications);
    if (!await options.store.createLead(lead, frozenNotifications)) return rejected();
    return {accepted: true, value: Object.freeze({
      lead, notifications: frozenNotifications, replayed: false,
    })};
  } catch {
    return rejected();
  }
}
