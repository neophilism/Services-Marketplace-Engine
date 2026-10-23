import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getProviderCredentialCheck,
  listProviderCredentialChecks,
  runProviderCredentialCheck,
} from '../packages/contracts/dist/credential-check.js';

const permissions = ['credentials:check', 'credentials:read'];
const state = {
  organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [{subjectId: 'operator-1', organizationId: 'org-1', status: 'active', roleIds: ['admin']}],
  roles: [{roleId: 'admin', organizationId: 'org-1', permissions}],
};
const auth = requiredPermission => ({
  subjectId: 'operator-1', organizationId: 'org-1', resourceOrganizationId: 'org-1', requiredPermission,
});
const input = {
  providerOrganizationId: 'provider-1', subjectReference: 'subject-token-1',
  credentialType: 'professional-license', attachmentId: 'attachment-1',
  purposeCode: 'provider-onboarding', consentedAt: 900,
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
  const checks = new Map();
  const options = {
    store: {
      getProvider: async (organizationId, id) => providers.get(organizationId + ':' + id) ?? null,
      getAttachment: async (organizationId, id) => attachments.get(organizationId + ':' + id) ?? null,
      getCheck: async (organizationId, id) => checks.get(organizationId + ':' + id) ?? null,
      listChecks: async (organizationId, providerOrganizationId) => [...checks.values()]
        .filter(value => value.organizationId === organizationId &&
          value.providerOrganizationId === providerOrganizationId),
      createCheck: async value => {
        const key = value.organizationId + ':' + value.credentialCheckId;
        if (checks.has(key)) return false;
        checks.set(key, value);
        return true;
      },
    },
    adapter: {
      check: async request => ({...request, adapterName: 'example-checks',
        adapterReference: 'external-1', outcome: 'verified', checkedAt: 950, validUntil: 2_000}),
    },
    audit: {
      sink: {append: async () => {}},
      createOpaqueId: () => 'audit-' + (++sequence),
      now: () => now,
    },
    createOpaqueId: () => 'check-' + (++sequence),
    now: () => now,
  };
  return {providers, attachments, checks, options, setNow: value => { now = value; }};
}

const run = (value, changedInput = input, version = 1, authorization = auth('credentials:check')) =>
  runProviderCredentialCheck(version, authorization, state, changedInput, value.options);

test('stores a tenant-bound normalized result without raw adapter findings', async () => {
  const value = fixture();
  const result = await run(value);
  assert.equal(result.accepted, true);
  assert.equal(result.value.attachmentSha256, 'a'.repeat(64));
  assert.equal(result.value.requestedBySubjectId, 'operator-1');
  assert.equal('rawFindings' in result.value, false);
  assert.equal(Object.isFrozen(result.value), true);
});

test('requires exact authorization, recent consent, an active provider and clean evidence', async () => {
  for (const [changedInput, version, authorization] of [
    [input, 2, auth('credentials:check')],
    [input, 1, auth('credentials:read')],
    [{...input, consentedAt: 1_001}, 1, auth('credentials:check')],
    [{...input, credentialType: 'Not Valid'}, 1, auth('credentials:check')],
  ]) {
    assert.deepEqual(await run(fixture(), changedInput, version, authorization), {
      accepted: false, code: 'credential_check_rejected',
    });
  }
  const stale = fixture();
  stale.options.maximumConsentAgeMs = 50;
  assert.deepEqual(await run(stale), {accepted: false, code: 'credential_check_rejected'});
  const suspended = fixture();
  suspended.providers.set('org-1:provider-1', {
    ...suspended.providers.get('org-1:provider-1'), status: 'suspended',
  });
  assert.deepEqual(await run(suspended), {accepted: false, code: 'credential_check_rejected'});
  const dirty = fixture();
  dirty.attachments.set('org-1:attachment-1', {
    ...dirty.attachments.get('org-1:attachment-1'), status: 'quarantined',
  });
  assert.deepEqual(await run(dirty), {accepted: false, code: 'credential_check_rejected'});
});

test('rejects adapter results that do not match the request boundary', async () => {
  for (const change of [
    {organizationId: 'org-2'},
    {providerOrganizationId: 'provider-2'},
    {subjectReference: 'another-subject'},
    {attachmentSha256: 'b'.repeat(64)},
    {checkedAt: 1_001},
    {validUntil: 950},
  ]) {
    const value = fixture();
    value.options.adapter.check = async request => ({...request, adapterName: 'example-checks',
      adapterReference: 'external-1', outcome: 'verified', checkedAt: 950,
      validUntil: 2_000, ...change});
    assert.deepEqual(await run(value), {accepted: false, code: 'credential_check_rejected'});
    assert.equal(value.checks.size, 0);
  }
});

test('reads and lists immutable records with exact-boundary expiry projection', async () => {
  const value = fixture();
  const created = await run(value);
  value.setNow(1_999);
  assert.equal((await getProviderCredentialCheck(auth('credentials:read'), state,
    created.value.credentialCheckId, value.options)).value.outcome, 'verified');
  value.setNow(2_000);
  assert.equal((await getProviderCredentialCheck(auth('credentials:read'), state,
    created.value.credentialCheckId, value.options)).value.outcome, 'review');
  const listed = await listProviderCredentialChecks(auth('credentials:read'), state,
    'provider-1', value.options);
  assert.equal(listed.accepted, true);
  assert.equal(listed.value[0].outcome, 'review');
  assert.equal(Object.isFrozen(listed.value), true);
  assert.equal([...value.checks.values()][0].outcome, 'verified');
});

test('preserves suspended-provider read continuity and rejects contaminated adapter storage', async () => {
  const value = fixture();
  const created = await run(value);
  value.providers.set('org-1:provider-1', {
    ...value.providers.get('org-1:provider-1'), status: 'suspended',
  });
  assert.equal((await listProviderCredentialChecks(auth('credentials:read'), state,
    'provider-1', value.options)).accepted, true);
  const key = 'org-1:' + created.value.credentialCheckId;
  value.checks.set(key, {...value.checks.get(key), organizationId: 'org-2'});
  assert.deepEqual(await getProviderCredentialCheck(auth('credentials:read'), state,
    created.value.credentialCheckId, value.options), {
    accepted: false, code: 'credential_check_rejected',
  });
});

test('rejects duplicate listings and fails closed on adapter, persistence and audit errors', async () => {
  const duplicate = fixture();
  const created = await run(duplicate);
  duplicate.options.store.listChecks = async () => [created.value, created.value];
  assert.deepEqual(await listProviderCredentialChecks(auth('credentials:read'), state,
    'provider-1', duplicate.options), {accepted: false, code: 'credential_check_rejected'});

  const adapter = fixture();
  adapter.options.adapter.check = async () => { throw new Error('unavailable'); };
  assert.deepEqual(await run(adapter), {accepted: false, code: 'credential_check_rejected'});
  const persistence = fixture();
  persistence.options.store.createCheck = async () => { throw new Error('unavailable'); };
  assert.deepEqual(await run(persistence), {accepted: false, code: 'credential_check_rejected'});
  const audit = fixture();
  audit.options.audit.sink.append = async () => { throw new Error('unavailable'); };
  assert.deepEqual(await run(audit), {accepted: false, code: 'credential_check_rejected'});
});
