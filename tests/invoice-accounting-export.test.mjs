import test from 'node:test';
import assert from 'node:assert/strict';
import {createInvoiceAccountingExport} from '../packages/contracts/dist/invoice-accounting-export.js';

const state = {
  organizations: [{organizationId: 'org', status: 'active'}],
  memberships: [{
    subjectId: 'accountant',
    organizationId: 'org',
    status: 'active',
    roleIds: ['accountant'],
  }],
  roles: [{
    roleId: 'accountant',
    organizationId: 'org',
    permissions: ['commerce:invoices:export'],
  }],
};
const auth = {
  subjectId: 'accountant',
  organizationId: 'org',
  resourceOrganizationId: 'org',
  requiredPermission: 'commerce:invoices:export',
};
const input = {
  requestKey: 'request-1',
  sourceType: 'scheduled_charge',
  sourceId: 'charge-1',
  expectedSourceRevision: 3,
  taxDeterminationId: 'tax-1',
};

function fixture() {
  const source = {
    organizationId: 'org',
    sourceType: 'scheduled_charge',
    sourceId: 'charge-1',
    revision: 3,
    jobRoomId: 'room-1',
    customerSubjectId: 'customer-1',
    providerOrganizationId: 'provider-1',
    currency: 'USD',
    subtotalMinor: 10000,
    discountMinor: 1000,
    finalizedAt: 900,
    status: 'finalized',
  };
  const tax = {
    organizationId: 'org',
    determinationId: 'tax-1',
    sourceType: 'scheduled_charge',
    sourceId: 'charge-1',
    sourceRevision: 3,
    jurisdictionCode: 'US-CA',
    taxMinor: 720,
    determinedAt: 950,
    status: 'verified',
  };
  let saved = null;
  let sequence = 0;
  const options = {
    store: {
      getSource: async () => source,
      getTaxDetermination: async () => tax,
      getByRequestKey: async (_organizationId, key) => saved?.requestKey === key ? saved : null,
      getBySource: async () => saved,
      createExport: async (_source, _tax, value) => {
        if (saved !== null) return false;
        saved = value;
        return true;
      },
    },
    audit: {
      sink: {append: async () => {}},
      createOpaqueId: () => `audit-${++sequence}`,
      now: () => 1000,
    },
    now: () => 1000,
    createOpaqueId: () => `invoice-${++sequence}`,
  };
  return {options, source, tax, saved: () => saved};
}

test('issues a balanced immutable invoice export and exactly replays it', async () => {
  const f = fixture();
  const first = await createInvoiceAccountingExport(1, auth, state, input, f.options);
  assert.equal(first.accepted, true);
  assert.equal(first.value.totalMinor, 9720);
  assert.deepEqual(first.value.entries, [
    {accountCode: 'accounts_receivable', direction: 'debit', amountMinor: 9720},
    {accountCode: 'service_revenue', direction: 'credit', amountMinor: 9000},
    {accountCode: 'tax_payable', direction: 'credit', amountMinor: 720},
  ]);
  assert.equal(Object.isFrozen(first.value), true);
  assert.equal(Object.isFrozen(first.value.entries), true);
  const replay = await createInvoiceAccountingExport(1, auth, state, input, f.options);
  assert.equal(replay.accepted, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.value.invoiceId, first.value.invoiceId);
  assert.equal((await createInvoiceAccountingExport(
    1,
    auth,
    state,
    {...input, expectedSourceRevision: 2},
    f.options,
  )).accepted, false);
  assert.equal((await createInvoiceAccountingExport(
    1,
    auth,
    state,
    {...input, requestKey: 'request-2'},
    f.options,
  )).accepted, false);
});

test('supports a verified zero-tax determination without an empty journal entry', async () => {
  const f = fixture();
  f.tax.taxMinor = 0;
  const result = await createInvoiceAccountingExport(1, auth, state, input, f.options);
  assert.equal(result.accepted, true);
  assert.equal(result.value.totalMinor, 9000);
  assert.equal(result.value.entries.length, 2);
});

test('rejects stale, void, cross-tenant, and contaminated tax evidence', async () => {
  const stale = fixture();
  assert.equal((await createInvoiceAccountingExport(
    1,
    auth,
    state,
    {...input, expectedSourceRevision: 2},
    stale.options,
  )).accepted, false);

  const voided = fixture();
  voided.source.status = 'void';
  assert.equal((await createInvoiceAccountingExport(1, auth, state, input, voided.options)).accepted, false);

  const tenant = fixture();
  tenant.options.store.getTaxDetermination = async () => ({...tenant.tax, organizationId: 'other'});
  assert.equal((await createInvoiceAccountingExport(1, auth, state, input, tenant.options)).accepted, false);

  const rebound = fixture();
  rebound.tax.sourceId = 'charge-2';
  assert.equal((await createInvoiceAccountingExport(1, auth, state, input, rebound.options)).accepted, false);

  const future = fixture();
  future.tax.determinedAt = 1001;
  assert.equal((await createInvoiceAccountingExport(1, auth, state, input, future.options)).accepted, false);
});

test('fails closed on authorization, audit, arithmetic, identifier, and persistence failures', async () => {
  assert.equal((await createInvoiceAccountingExport(
    1,
    {...auth, resourceOrganizationId: 'other'},
    state,
    input,
    fixture().options,
  )).accepted, false);

  const audit = fixture();
  audit.options.audit.sink.append = async () => { throw Error('down'); };
  assert.equal((await createInvoiceAccountingExport(1, auth, state, input, audit.options)).accepted, false);

  const overflow = fixture();
  overflow.source.subtotalMinor = 9_999_999_999;
  overflow.source.discountMinor = 0;
  overflow.tax.taxMinor = 1;
  assert.equal((await createInvoiceAccountingExport(1, auth, state, input, overflow.options)).accepted, false);

  const identifiers = fixture();
  identifiers.options.createOpaqueId = () => 'same';
  assert.equal((await createInvoiceAccountingExport(1, auth, state, input, identifiers.options)).accepted, false);

  const persistence = fixture();
  persistence.options.store.createExport = async () => false;
  assert.equal((await createInvoiceAccountingExport(1, auth, state, input, persistence.options)).accepted, false);
  assert.equal(persistence.saved(), null);
});
