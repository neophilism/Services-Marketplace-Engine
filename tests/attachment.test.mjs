import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginAttachmentUpload,
  createAttachmentDownload,
  recordAttachmentScan,
} from '../packages/contracts/dist/attachment.js';

const HASH = 'a'.repeat(64);
const state = {
  organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [{
    subjectId: 'subject-1',
    organizationId: 'org-1',
    status: 'active',
    roleIds: ['member'],
  }],
  roles: [{
    roleId: 'member',
    organizationId: 'org-1',
    permissions: ['attachment:write', 'attachment:read'],
  }],
};
const auth = permission => ({
  subjectId: 'subject-1',
  organizationId: 'org-1',
  resourceOrganizationId: 'org-1',
  requiredPermission: permission,
});

function fixture(overrides = {}) {
  let now = 1_000;
  let sequence = 0;
  const records = new Map();
  const events = [];
  const deleted = [];
  const options = {
    store: {
      createQuarantined: async attachment => { records.set(attachment.attachmentId, attachment); },
      get: async (organizationId, attachmentId) => {
        const record = records.get(attachmentId);
        return record?.organizationId === organizationId ? record : null;
      },
      applyVerifiedVerdict: async (attachment, verdict) => {
        records.set(attachment.attachmentId, {...attachment, status: verdict});
        return true;
      },
    },
    objects: {
      createUploadUrl: async key => 'https://objects.example/upload/' + key,
      createDownloadUrl: async key => 'https://objects.example/download/' + key,
      delete: async key => { deleted.push(key); },
    },
    audit: {
      sink: {append: async event => { events.push(event); }},
      createOpaqueId: () => 'audit-' + (++sequence),
      now: () => now,
    },
    createOpaqueId: () => 'attachment-' + (++sequence),
    now: () => now,
    allowedContentTypes: new Set(['application/pdf', 'image/png']),
    maxSizeBytes: 1_000_000,
    verifyScanResult: async result => result.evidence === 'verified',
    ...overrides,
  };
  return {deleted, events, options, records};
}

async function upload(value) {
  return beginAttachmentUpload(
    1,
    auth('attachment:write'),
    state,
    {contentType: 'application/pdf', sizeBytes: 100, sha256: HASH},
    value.options,
  );
}

const scan = attachment => ({
  contractVersion: 1,
  attachmentId: attachment.attachmentId,
  organizationId: attachment.organizationId,
  objectKey: attachment.objectKey,
  sha256: attachment.sha256,
  verdict: 'clean',
  scannedAt: 2_000,
  evidence: 'verified',
});

test('authorized uploads receive an engine-owned quarantined object key', async () => {
  const value = fixture();
  const result = await upload(value);
  assert.equal(result.accepted, true);
  assert.equal(result.value.attachment.status, 'quarantined');
  assert.equal(result.value.attachment.objectKey, 'quarantine/org-1/attachment-2');
  assert.equal(Object.isFrozen(result.value.attachment), true);
  assert.equal(value.events.length, 1);
});

test('unsupported versions, unsafe metadata and tenant failures never create records', async t => {
  for (const [name, version, authorization, metadata] of [
    ['version', 2, auth('attachment:write'), {contentType: 'application/pdf', sizeBytes: 100, sha256: HASH}],
    ['type', 1, auth('attachment:write'), {contentType: 'text/html', sizeBytes: 100, sha256: HASH}],
    ['size', 1, auth('attachment:write'), {contentType: 'application/pdf', sizeBytes: 1_000_001, sha256: HASH}],
    ['digest', 1, auth('attachment:write'), {contentType: 'application/pdf', sizeBytes: 100, sha256: 'bad'}],
    ['tenant', 1, {...auth('attachment:write'), resourceOrganizationId: 'org-2'}, {contentType: 'application/pdf', sizeBytes: 100, sha256: HASH}],
  ]) {
    await t.test(name, async () => {
      const value = fixture();
      assert.deepEqual(await beginAttachmentUpload(
        version,
        authorization,
        state,
        metadata,
        value.options,
      ), {accepted: false, code: 'attachment_rejected'});
      assert.equal(value.records.size, 0);
    });
  }
});

test('unverified and mismatched scan results leave objects quarantined', async () => {
  for (const override of [
    {evidence: 'unverified'},
    {sha256: 'b'.repeat(64)},
    {organizationId: 'org-2', objectKey: 'quarantine/org-2/attachment-2'},
  ]) {
    const value = fixture();
    const attachment = (await upload(value)).value.attachment;
    assert.deepEqual(await recordAttachmentScan(
      {...scan(attachment), ...override},
      value.options,
    ), {accepted: false, code: 'attachment_rejected'});
    assert.equal(value.records.get(attachment.attachmentId).status, 'quarantined');
  }
});

test('scanner errors stay quarantined and clean verdicts release downloads', async () => {
  const value = fixture();
  const attachment = (await upload(value)).value.attachment;
  assert.deepEqual(await recordAttachmentScan(
    {...scan(attachment), verdict: 'error'},
    value.options,
  ), {accepted: true, value: {status: 'quarantined'}});
  assert.deepEqual(await createAttachmentDownload(
    auth('attachment:read'),
    state,
    attachment.attachmentId,
    value.options,
  ), {accepted: false, code: 'attachment_rejected'});

  assert.deepEqual(await recordAttachmentScan(scan(attachment), value.options), {
    accepted: true,
    value: {status: 'clean'},
  });
  assert.equal((await createAttachmentDownload(
    auth('attachment:read'),
    state,
    attachment.attachmentId,
    value.options,
  )).accepted, true);
});

test('infected objects are deleted and can never be downloaded', async () => {
  const value = fixture();
  const attachment = (await upload(value)).value.attachment;
  assert.deepEqual(await recordAttachmentScan(
    {...scan(attachment), verdict: 'infected'},
    value.options,
  ), {accepted: true, value: {status: 'infected'}});
  assert.deepEqual(value.deleted, [attachment.objectKey]);
  assert.deepEqual(await createAttachmentDownload(
    auth('attachment:read'),
    state,
    attachment.attachmentId,
    value.options,
  ), {accepted: false, code: 'attachment_rejected'});
});

test('cross-tenant and wrong-permission downloads fail before URL creation', async () => {
  let urls = 0;
  const value = fixture({
    objects: {
      createUploadUrl: async key => 'https://objects.example/upload/' + key,
      createDownloadUrl: async () => { urls += 1; return 'https://unexpected'; },
      delete: async () => {},
    },
  });
  const attachment = (await upload(value)).value.attachment;
  await recordAttachmentScan(scan(attachment), value.options);
  for (const authorization of [
    {...auth('attachment:read'), resourceOrganizationId: 'org-2'},
    auth('attachment:write'),
  ]) {
    assert.deepEqual(await createAttachmentDownload(
      authorization,
      state,
      attachment.attachmentId,
      value.options,
    ), {accepted: false, code: 'attachment_rejected'});
  }
  assert.equal(urls, 0);
});
