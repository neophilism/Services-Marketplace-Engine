import {authorizeAndAuditOrganizationAction, type TenantAuditOptions} from './audit.js';
import type {OrganizationAuthorizationRequest, OrganizationAuthorizationState} from './rbac.js';

export const INVOICE_ACCOUNTING_EXPORT_CONTRACT_VERSION = 1 as const;
export const INVOICE_ACCOUNTING_EXPORT_REJECTED = 'invoice_accounting_export_rejected' as const;

export type InvoiceSourceType = 'scheduled_charge' | 'external_payment';

export interface FinalizedInvoiceSource {
  readonly organizationId: string;
  readonly sourceType: InvoiceSourceType;
  readonly sourceId: string;
  readonly revision: number;
  readonly jobRoomId: string;
  readonly customerSubjectId: string;
  readonly providerOrganizationId: string;
  readonly currency: string;
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly finalizedAt: number;
  readonly status: 'finalized' | 'void';
}

export interface VerifiedTaxDetermination {
  readonly organizationId: string;
  readonly determinationId: string;
  readonly sourceType: InvoiceSourceType;
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly jurisdictionCode: string;
  readonly taxMinor: number;
  readonly determinedAt: number;
  readonly status: 'verified' | 'void';
}

export interface AccountingEntry {
  readonly accountCode: 'accounts_receivable' | 'service_revenue' | 'tax_payable';
  readonly direction: 'debit' | 'credit';
  readonly amountMinor: number;
}

export interface InvoiceAccountingExport {
  readonly invoiceId: string;
  readonly accountingExportId: string;
  readonly organizationId: string;
  readonly requestKey: string;
  readonly sourceType: InvoiceSourceType;
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly jobRoomId: string;
  readonly customerSubjectId: string;
  readonly providerOrganizationId: string;
  readonly currency: string;
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly taxDeterminationId: string;
  readonly jurisdictionCode: string;
  readonly entries: readonly AccountingEntry[];
  readonly status: 'issued';
  readonly issuedAt: number;
}

export interface CreateInvoiceAccountingExportInput {
  readonly requestKey: string;
  readonly sourceType: InvoiceSourceType;
  readonly sourceId: string;
  readonly expectedSourceRevision: number;
  readonly taxDeterminationId: string;
}

export interface InvoiceAccountingExportStore {
  getSource(
    organizationId: string,
    sourceType: InvoiceSourceType,
    sourceId: string,
  ): Promise<FinalizedInvoiceSource | null>;
  getTaxDetermination(
    organizationId: string,
    determinationId: string,
  ): Promise<VerifiedTaxDetermination | null>;
  getByRequestKey(
    organizationId: string,
    requestKey: string,
  ): Promise<InvoiceAccountingExport | null>;
  getBySource(
    organizationId: string,
    sourceType: InvoiceSourceType,
    sourceId: string,
    sourceRevision: number,
  ): Promise<InvoiceAccountingExport | null>;
  createExport(
    source: FinalizedInvoiceSource,
    tax: VerifiedTaxDetermination,
    value: InvoiceAccountingExport,
  ): Promise<boolean>;
}

export interface InvoiceAccountingExportOptions {
  readonly store: InvoiceAccountingExportStore;
  readonly audit: TenantAuditOptions;
  readonly now: () => number;
  readonly createOpaqueId: () => string;
}

export type CreateInvoiceAccountingExportResult =
  | {readonly accepted: true; readonly value: InvoiceAccountingExport; readonly replayed: boolean}
  | {readonly accepted: false; readonly code: typeof INVOICE_ACCOUNTING_EXPORT_REJECTED};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const JURISDICTION = /^[A-Z0-9][A-Z0-9._:-]{1,31}$/;
const CURRENCY = /^[A-Z]{3}$/;
const DATE = 8_640_000_000_000_000;
const MAX_MONEY = 9_999_999_999;
const SOURCE_TYPES = new Set<InvoiceSourceType>(['scheduled_charge', 'external_payment']);
const integer = (value: number, min: number, max: number): boolean =>
  Number.isSafeInteger(value) && value >= min && value <= max;
const rejected = (): CreateInvoiceAccountingExportResult => ({
  accepted: false,
  code: INVOICE_ACCOUNTING_EXPORT_REJECTED,
});

function validSource(
  value: FinalizedInvoiceSource | null,
  organizationId: string,
): value is FinalizedInvoiceSource {
  return value?.organizationId === organizationId &&
    SOURCE_TYPES.has(value.sourceType) &&
    ID.test(value.sourceId) &&
    integer(value.revision, 1, Number.MAX_SAFE_INTEGER) &&
    ID.test(value.jobRoomId) &&
    ID.test(value.customerSubjectId) &&
    ID.test(value.providerOrganizationId) &&
    CURRENCY.test(value.currency) &&
    integer(value.subtotalMinor, 1, MAX_MONEY) &&
    integer(value.discountMinor, 0, value.subtotalMinor - 1) &&
    integer(value.finalizedAt, 0, DATE) &&
    (value.status === 'finalized' || value.status === 'void');
}

function validTax(
  value: VerifiedTaxDetermination | null,
  organizationId: string,
): value is VerifiedTaxDetermination {
  return value?.organizationId === organizationId &&
    ID.test(value.determinationId) &&
    SOURCE_TYPES.has(value.sourceType) &&
    ID.test(value.sourceId) &&
    integer(value.sourceRevision, 1, Number.MAX_SAFE_INTEGER) &&
    JURISDICTION.test(value.jurisdictionCode) &&
    integer(value.taxMinor, 0, MAX_MONEY) &&
    integer(value.determinedAt, 0, DATE) &&
    (value.status === 'verified' || value.status === 'void');
}

function validEntries(
  entries: readonly AccountingEntry[],
  revenueMinor: number,
  taxMinor: number,
  totalMinor: number,
): boolean {
  const expectedLength = taxMinor === 0 ? 2 : 3;
  if (entries.length !== expectedLength) return false;
  const receivable = entries[0];
  const revenue = entries[1];
  const tax = entries[2];
  return receivable?.accountCode === 'accounts_receivable' &&
    receivable.direction === 'debit' &&
    receivable.amountMinor === totalMinor &&
    revenue?.accountCode === 'service_revenue' &&
    revenue.direction === 'credit' &&
    revenue.amountMinor === revenueMinor &&
    (taxMinor === 0 ||
      (tax?.accountCode === 'tax_payable' &&
        tax.direction === 'credit' &&
        tax.amountMinor === taxMinor)) &&
    totalMinor === revenueMinor + taxMinor;
}

function validExport(
  value: InvoiceAccountingExport | null,
  organizationId: string,
): value is InvoiceAccountingExport {
  if (
    value?.organizationId !== organizationId ||
    !ID.test(value.invoiceId) ||
    !ID.test(value.accountingExportId) ||
    !ID.test(value.requestKey) ||
    !SOURCE_TYPES.has(value.sourceType) ||
    !ID.test(value.sourceId) ||
    !integer(value.sourceRevision, 1, Number.MAX_SAFE_INTEGER) ||
    !ID.test(value.jobRoomId) ||
    !ID.test(value.customerSubjectId) ||
    !ID.test(value.providerOrganizationId) ||
    !CURRENCY.test(value.currency) ||
    !integer(value.subtotalMinor, 1, MAX_MONEY) ||
    !integer(value.discountMinor, 0, value.subtotalMinor - 1) ||
    !integer(value.taxMinor, 0, MAX_MONEY) ||
    !integer(value.totalMinor, 1, MAX_MONEY) ||
    !ID.test(value.taxDeterminationId) ||
    !JURISDICTION.test(value.jurisdictionCode) ||
    value.status !== 'issued' ||
    !integer(value.issuedAt, 0, DATE)
  ) return false;
  return validEntries(
    value.entries,
    value.subtotalMinor - value.discountMinor,
    value.taxMinor,
    value.totalMinor,
  );
}

function exactReplay(
  value: InvoiceAccountingExport,
  input: CreateInvoiceAccountingExportInput,
): boolean {
  return value.requestKey === input.requestKey &&
    value.sourceType === input.sourceType &&
    value.sourceId === input.sourceId &&
    value.sourceRevision === input.expectedSourceRevision &&
    value.taxDeterminationId === input.taxDeterminationId;
}

export async function createInvoiceAccountingExport(
  version: number,
  request: OrganizationAuthorizationRequest,
  state: OrganizationAuthorizationState,
  input: CreateInvoiceAccountingExportInput,
  options: InvoiceAccountingExportOptions,
): Promise<CreateInvoiceAccountingExportResult> {
  const auth = await authorizeAndAuditOrganizationAction(
    request,
    state,
    'commerce.invoice.accounting_export',
    options.audit,
  );
  const now = options.now();
  if (
    !auth.authorized ||
    request.requiredPermission !== 'commerce:invoices:export' ||
    version !== INVOICE_ACCOUNTING_EXPORT_CONTRACT_VERSION ||
    !integer(now, 0, DATE) ||
    !ID.test(input.requestKey) ||
    !SOURCE_TYPES.has(input.sourceType) ||
    !ID.test(input.sourceId) ||
    !integer(input.expectedSourceRevision, 1, Number.MAX_SAFE_INTEGER) ||
    !ID.test(input.taxDeterminationId)
  ) return rejected();

  try {
    const [source, tax, replay, existingSource] = await Promise.all([
      options.store.getSource(auth.organizationId, input.sourceType, input.sourceId),
      options.store.getTaxDetermination(auth.organizationId, input.taxDeterminationId),
      options.store.getByRequestKey(auth.organizationId, input.requestKey),
      options.store.getBySource(
        auth.organizationId,
        input.sourceType,
        input.sourceId,
        input.expectedSourceRevision,
      ),
    ]);
    if (replay !== null) {
      return validExport(replay, auth.organizationId) &&
        exactReplay(replay, input) &&
        validExport(existingSource, auth.organizationId) &&
        existingSource.invoiceId === replay.invoiceId &&
        existingSource.accountingExportId === replay.accountingExportId
        ? {accepted: true, value: replay, replayed: true}
        : rejected();
    }
    if (
      existingSource !== null ||

      !validSource(source, auth.organizationId) ||
      source.sourceType !== input.sourceType ||
      source.sourceId !== input.sourceId ||
      source.revision !== input.expectedSourceRevision ||
      source.status !== 'finalized' ||
      source.finalizedAt > now ||
      !validTax(tax, auth.organizationId) ||
      tax.determinationId !== input.taxDeterminationId ||
      tax.sourceType !== source.sourceType ||
      tax.sourceId !== source.sourceId ||
      tax.sourceRevision !== source.revision ||
      tax.status !== 'verified' ||
      tax.determinedAt < source.finalizedAt ||
      tax.determinedAt > now
    ) return rejected();

    const revenueMinor = source.subtotalMinor - source.discountMinor;
    const totalMinor = revenueMinor + tax.taxMinor;
    if (!integer(totalMinor, 1, MAX_MONEY)) return rejected();
    const invoiceId = options.createOpaqueId();
    const accountingExportId = options.createOpaqueId();
    if (!ID.test(invoiceId) || !ID.test(accountingExportId) || invoiceId === accountingExportId) {
      return rejected();
    }
    const entries: AccountingEntry[] = [
      {accountCode: 'accounts_receivable', direction: 'debit', amountMinor: totalMinor},
      {accountCode: 'service_revenue', direction: 'credit', amountMinor: revenueMinor},
    ];
    if (tax.taxMinor > 0) {
      entries.push({accountCode: 'tax_payable', direction: 'credit', amountMinor: tax.taxMinor});
    }
    const value: InvoiceAccountingExport = Object.freeze({
      invoiceId,
      accountingExportId,
      organizationId: auth.organizationId,
      requestKey: input.requestKey,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      sourceRevision: source.revision,
      jobRoomId: source.jobRoomId,
      customerSubjectId: source.customerSubjectId,
      providerOrganizationId: source.providerOrganizationId,
      currency: source.currency,
      subtotalMinor: source.subtotalMinor,
      discountMinor: source.discountMinor,
      taxMinor: tax.taxMinor,
      totalMinor,
      taxDeterminationId: tax.determinationId,
      jurisdictionCode: tax.jurisdictionCode,
      entries: Object.freeze(entries.map(entry => Object.freeze(entry))),
      status: 'issued',
      issuedAt: now,
    });
    return validExport(value, auth.organizationId) &&
      await options.store.createExport(source, tax, value)
      ? {accepted: true, value, replayed: false}
      : rejected();
  } catch {
    return rejected();
  }
}
