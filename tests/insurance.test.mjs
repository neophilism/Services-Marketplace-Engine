import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProviderInsuranceEvidence,
  decideProviderInsuranceEvidence,
  getProviderInsuranceEvidence,
  listProviderInsuranceEvidence,
  submitProviderInsuranceEvidence,
} from '../packages/contracts/dist/insurance.js';

const permissions = ['insurance:read', 'insurance:write', 'insurance:review'];
const state = {
  organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [
    {subjectId: 'author-1', organizationId: 'org-1', status: 'active', roleIds: ['admin']},
    {subjectId: 'reviewer-1', organizationId: 'org-1', status: 'active', roleIds: ['admin']},
  ],
  roles: [{roleId: 'admin', organizationId: 'org-1', permissions}],
};
const auth = (requiredPermission, subjectId = 'author-1') => ({
  subjectId, organizationId: 'org-1', resourceOrganizationId: 'org-1', requiredPermission,
});
const input = {
  providerOrganizationId: 'provider-1', attachmentId: 'attachment-1',
  coverageType: 'general-liability', insurerName: 'Example Mutual',
  policyReference: 'POL-100', coverageStartsAt: 900, coverageEndsAt: 2_000,
};

function fixture() {
  let sequence = 0;
  let now = 1_000;
  const providers = new Map([['org-1:provider-1', {
    providerOrganizationId: 'provider-1', organizationId: 'org-1', status: 'active',
  }]]);
  const attachments = new Map([['org-1:attachment-1', {
    attachmentId: 'attachment-1', organizationId: 'org-1', status: 'clean', sha256: 'a'.repeat(64),
  }]]);
  const evidence = new Map();
  const key = value => value.organizationId + ':' + value.insuranceEvidenceId;
  const options = {
    store: {
      getProvider: async (organizationId, id) => providers.get(organizationId + ':' + id) ?? null,
      getAttachment: async (organizationId, id) => attachments.get(organizationId + ':' + id) ?? null,
      getEvidence: async (organizationId, id) => evidence.get(organizationId + ':' + id) ?? null,
      listEvidence: async (organizationId, providerOrganizationId) => [...evidence.values()]
        .filter(value => value.organizationId === organizationId &&
          value.providerOrganizationId === providerOrganizationId),
      createEvidence: async value => {
        if (evidence.has(key(value))) return false;
        evidence.set(key(value), value);
        return true;
      },
      replaceEvidence: async (current, replacement) => {
        if (evidence.get(key(current)) !== current) return false;
        evidence.set(key(current), replacement);
        return true;
      },
    },
    audit: {
      sink: {append: async () => {}},
      createOpaqueId: () => 'audit-' + (++sequence),
      now: () => now,
    },
    createOpaqueId: () => 'insurance-' + (++sequence),
    now: () => now,
  };
  return {providers, attachments, evidence, options, setNow: value => { now = value; }};
}

async function create(value, contractVersion = 1,
  authorization = auth('insurance:write'), changedInput = input) {
  return createProviderInsuranceEvidence(contractVersion, authorization, state, changedInput, value.options);
}

test('creates tenant-bound draft evidence from an active provider and clean attachment', async () => {
  const value = fixture();
  const result = await create(value);
  assert.equal(result.accepted, true);
  assert.equal(result.value.status, 'draft');
  assert.equal(result.value.attachmentSha256, 'a'.repeat(64));
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(value.evidence.get('org-1:' + result.value.insuranceEvidenceId), result.value);
});

test('rejects malformed, unauthorized, expired and unscanned creation inputs', async () => {
  for (const [version, authorization, changedInput] of [
    [2, auth('insurance:write'), input],
    [1, auth('insurance:read'), input],
    [1, {...auth('insurance:write'), resourceOrganizationId: 'org-2'}, input],
    [1, auth('insurance:write'), {...input, coverageType: 'Not Valid'}],
    [1, auth('insurance:write'), {...input, insurerName: ' padded '}],
    [1, auth('insurance:write'), {...input, coverageEndsAt: 1_000}],
  ]) {
    assert.deepEqual(await create(fixture(), version, authorization, changedInput), {
      accepted: false, code: 'insurance_rejected',
    });
  }
  const dirty = fixture();
  dirty.attachments.set('org-1:attachment-1', {
    ...dirty.attachments.get('org-1:attachment-1'), status: 'quarantined',
  });
  assert.deepEqual(await create(dirty), {accepted: false, code: 'insurance_rejected'});
});

test('submits with optimistic concurrency and immutable attachment digest binding', async () => {
  const value = fixture();
  const created = await create(value);
  value.setNow(1_010);
  const submitted = await submitProviderInsuranceEvidence(
    auth('insurance:write'), state, created.value.insuranceEvidenceId, 1, value.options,
  );
  assert.equal(submitted.accepted, true);
  assert.equal(submitted.value.status, 'submitted');
  assert.equal(submitted.value.submittedBySubjectId, 'author-1');
  assert.equal(submitted.value.version, 2);
  assert.deepEqual(await submitProviderInsuranceEvidence(
    auth('insurance:write'), state, created.value.insuranceEvidenceId, 1, value.options,
  ), {accepted: false, code: 'insurance_rejected'});

  const replaced = fixture();
  const second = await create(replaced);
  replaced.attachments.set('org-1:attachment-1', {
    ...replaced.attachments.get('org-1:attachment-1'), sha256: 'b'.repeat(64),
  });
  assert.deepEqual(await submitProviderInsuranceEvidence(
    auth('insurance:write'), state, second.value.insuranceEvidenceId, 1, replaced.options,
  ), {accepted: false, code: 'insurance_rejected'});
});

test('requires independent review and projects approved evidence to expired at the exact boundary', async () => {
  const value = fixture();
  const created = await create(value);
  value.setNow(1_010);
  await submitProviderInsuranceEvidence(
    auth('insurance:write'), state, created.value.insuranceEvidenceId, 1, value.options,
  );
  value.setNow(1_020);
  assert.deepEqual(await decideProviderInsuranceEvidence(
    auth('insurance:review'), state, created.value.insuranceEvidenceId,
    2, 'approved', 'Verified.', value.options,
  ), {accepted: false, code: 'insurance_rejected'});
  const approved = await decideProviderInsuranceEvidence(
    auth('insurance:review', 'reviewer-1'), state, created.value.insuranceEvidenceId,
    2, 'approved', 'Verified.', value.options,
  );
  assert.equal(approved.accepted, true);
  assert.equal(approved.value.reviewedBySubjectId, 'reviewer-1');
  value.setNow(1_999);
  assert.equal((await getProviderInsuranceEvidence(
    auth('insurance:read'), state, created.value.insuranceEvidenceId, value.options,
  )).value.status, 'approved');
  value.setNow(2_000);
  const expired = await getProviderInsuranceEvidence(
    auth('insurance:read'), state, created.value.insuranceEvidenceId, value.options,
  );
  assert.equal(expired.value.status, 'expired');
  assert.equal(expired.value.version, 3);
  assert.equal(value.evidence.get('org-1:' + created.value.insuranceEvidenceId).status, 'approved');
});

test('supports terminal rejection and blocks expired review', async () => {
  const rejected = fixture();
  const created = await create(rejected);
  rejected.setNow(1_010);
  await submitProviderInsuranceEvidence(
    auth('insurance:write'), state, created.value.insuranceEvidenceId, 1, rejected.options,
  );
  rejected.setNow(1_020);
  const result = await decideProviderInsuranceEvidence(
    auth('insurance:review', 'reviewer-1'), state, created.value.insuranceEvidenceId,
    2, 'rejected', 'Coverage could not be verified.', rejected.options,
  );
  assert.equal(result.accepted, true);
  assert.equal(result.value.status, 'rejected');
  assert.deepEqual(await decideProviderInsuranceEvidence(
    auth('insurance:review', 'reviewer-1'), state, created.value.insuranceEvidenceId,
    3, 'approved', 'Retry.', rejected.options,
  ), {accepted: false, code: 'insurance_rejected'});

  const expired = fixture();
  const second = await create(expired);
  expired.setNow(1_010);
  await submitProviderInsuranceEvidence(
    auth('insurance:write'), state, second.value.insuranceEvidenceId, 1, expired.options,
  );
  expired.setNow(2_000);
  assert.deepEqual(await decideProviderInsuranceEvidence(
    auth('insurance:review', 'reviewer-1'), state, second.value.insuranceEvidenceId,
    2, 'approved', 'Too late.', expired.options,
  ), {accepted: false, code: 'insurance_rejected'});
});

test('lists deterministic expiration projections and rejects duplicate or cross-tenant adapter data', async () => {
  const value = fixture();
  const created = await create(value);
  value.setNow(1_010);
  await submitProviderInsuranceEvidence(
    auth('insurance:write'), state, created.value.insuranceEvidenceId, 1, value.options,
  );
  value.setNow(1_020);
  await decideProviderInsuranceEvidence(
    auth('insurance:review', 'reviewer-1'), state, created.value.insuranceEvidenceId,
    2, 'approved', 'Verified.', value.options,
  );
  value.setNow(2_000);
  const listed = await listProviderInsuranceEvidence(
    auth('insurance:read'), state, 'provider-1', value.options,
  );
  assert.equal(listed.accepted, true);
  assert.equal(listed.value[0].status, 'expired');
  assert.equal(Object.isFrozen(listed.value), true);

  value.providers.set('org-1:provider-1', {
    ...value.providers.get('org-1:provider-1'), status: 'suspended',
  });
  assert.equal((await listProviderInsuranceEvidence(
    auth('insurance:read'), state, 'provider-1', value.options,
  )).accepted, true);

  value.options.store.listEvidence = async () => [
    value.evidence.get('org-1:' + created.value.insuranceEvidenceId),
    value.evidence.get('org-1:' + created.value.insuranceEvidenceId),
  ];
  assert.deepEqual(await listProviderInsuranceEvidence(
    auth('insurance:read'), state, 'provider-1', value.options,
  ), {accepted: false, code: 'insurance_rejected'});

  const contaminated = fixture();
  const second = await create(contaminated);
  contaminated.evidence.set('org-1:' + second.value.insuranceEvidenceId, {
    ...second.value, organizationId: 'org-2',
  });
  assert.deepEqual(await getProviderInsuranceEvidence(
    auth('insurance:read'), state, second.value.insuranceEvidenceId, contaminated.options,
  ), {accepted: false, code: 'insurance_rejected'});

  const malformed = fixture();
  const third = await create(malformed);
  malformed.evidence.set('org-1:' + third.value.insuranceEvidenceId, {
    ...third.value, status: 'approved', reviewedBySubjectId: 'reviewer-1',
    reviewedAt: 1_000, decisionReason: 'Forged without submission.',
  });
  assert.deepEqual(await getProviderInsuranceEvidence(
    auth('insurance:read'), state, third.value.insuranceEvidenceId, malformed.options,
  ), {accepted: false, code: 'insurance_rejected'});
});

test('fails closed on provider, persistence and audit adapter failures', async () => {
  const suspended = fixture();
  suspended.providers.set('org-1:provider-1', {
    ...suspended.providers.get('org-1:provider-1'), status: 'suspended',
  });
  assert.deepEqual(await create(suspended), {accepted: false, code: 'insurance_rejected'});

  const persistence = fixture();
  persistence.options.store.createEvidence = async () => { throw new Error('unavailable'); };
  assert.deepEqual(await create(persistence), {accepted: false, code: 'insurance_rejected'});

  const audit = fixture();
  audit.options.audit.sink.append = async () => { throw new Error('unavailable'); };
  assert.deepEqual(await create(audit), {accepted: false, code: 'insurance_rejected'});
});
