import test from 'node:test';
import assert from 'node:assert/strict';
import {recordTechnicianWork} from '../packages/contracts/dist/work-record.js';

const state = {organizations: [{organizationId: 'org-1', status: 'active'}], memberships: [{subjectId: 'tech-1', organizationId: 'org-1', status: 'active', roleIds: ['tech']}], roles: [{roleId: 'tech', organizationId: 'org-1', permissions: ['job-rooms:work:record']}]};
const auth = {subjectId: 'tech-1', organizationId: 'org-1', resourceOrganizationId: 'org-1', requiredPermission: 'job-rooms:work:record'};
const input = {requestKey: 'work-1', jobRoomId: 'room-1', technicianTaskId: 'task-1', startedAt: 1_000, endedAt: 3_601_000, materials: [{inventoryItemId: 'wire', quantity: 3, expectedRevision: 2}]};

function fixture() {
  let replay = null; let overlap = false; let rejectWrite = false; let sequence = 0; let saved = null; let adjustments = null;
  const member = {membershipId: 'member-tech', organizationId: 'org-1', jobRoomId: 'room-1', subjectId: 'tech-1', role: 'provider', status: 'active'};
  const item = {inventoryItemId: 'wire', organizationId: 'org-1', providerMembershipId: 'member-tech', sku: 'WIRE-12', unit: 'meter', availableQuantity: 10, revision: 2, status: 'active'};
  const options = {store: {
    getRoom: async () => ({organizationId: 'org-1', jobRoomId: 'room-1', status: 'active'}), getMembership: async () => member,
    getTask: async () => ({technicianTaskId: 'task-1', organizationId: 'org-1', jobRoomId: 'room-1', assignedMembershipId: 'member-tech', status: 'active'}),
    getWorkByRequestKey: async () => replay, hasOverlappingWork: async () => overlap, getInventoryItem: async () => item,
    recordWork: async (value, values) => { if (rejectWrite) return false; saved = value; adjustments = values; replay = value; return true; },
  }, audit: {sink: {append: async () => {}}, createOpaqueId: () => `audit-${++sequence}`, now: () => 4_000_000}, createOpaqueId: () => `opaque-${++sequence}`, now: () => 4_000_000};
  return {options, member, item, saved: () => saved, adjustments: () => adjustments, setReplay: value => { replay = value; }, setOverlap: value => { overlap = value; }, setRejectWrite: value => { rejectWrite = value; }};
}

test('records time and atomically decrements revision-fenced inventory', async () => {
  const f = fixture(); const result = await recordTechnicianWork(1, auth, state, input, f.options);
  assert.equal(result.accepted, true); assert.equal(result.value.minutes, 60); assert.equal(result.value.materials[0].inventoryRevision, 3);
  assert.equal(f.adjustments()[0].after.availableQuantity, 7); assert.equal(f.adjustments()[0].after.revision, 3);
});

test('replays only an exact immutable work record', async () => {
  const f = fixture(); await recordTechnicianWork(1, auth, state, input, f.options);
  const replay = await recordTechnicianWork(1, auth, state, input, f.options); assert.equal(replay.accepted, true); assert.equal(replay.replayed, true);
  assert.equal((await recordTechnicianWork(1, auth, state, {...input, endedAt: input.endedAt + 1}, f.options)).accepted, false);
});

test('rejects cross-tenant, rebound assignment, overlap and insufficient inventory', async () => {
  assert.equal((await recordTechnicianWork(1, {...auth, resourceOrganizationId: 'org-2'}, state, input, fixture().options)).accepted, false);
  const rebound = fixture(); rebound.options.store.getMembership = async () => ({...rebound.member, membershipId: 'replacement'});
  assert.equal((await recordTechnicianWork(1, auth, state, input, rebound.options)).accepted, false);
  const overlap = fixture(); overlap.setOverlap(true); assert.equal((await recordTechnicianWork(1, auth, state, input, overlap.options)).accepted, false);
  const short = fixture(); short.options.store.getInventoryItem = async () => ({...short.item, availableQuantity: 2});
  assert.equal((await recordTechnicianWork(1, auth, state, input, short.options)).accepted, false);
});

test('rejects duplicate materials, stale inventory, contaminated replay and write failure', async () => {
  const duplicate = {...input, materials: [input.materials[0], input.materials[0]]};
  assert.equal((await recordTechnicianWork(1, auth, state, duplicate, fixture().options)).accepted, false);
  const stale = fixture(); stale.options.store.getInventoryItem = async () => ({...stale.item, revision: 3});
  assert.equal((await recordTechnicianWork(1, auth, state, input, stale.options)).accepted, false);
  const contaminated = fixture(); contaminated.setReplay({workRecordId: 'bad', organizationId: 'org-2'});
  assert.equal((await recordTechnicianWork(1, auth, state, input, contaminated.options)).accepted, false);
  const failed = fixture(); failed.setRejectWrite(true); assert.equal((await recordTechnicianWork(1, auth, state, input, failed.options)).accepted, false);
});
