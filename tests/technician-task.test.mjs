import test from 'node:test';
import assert from 'node:assert/strict';
import {completeTechnicianChecklistItem, createTechnicianTask} from '../packages/contracts/dist/technician-task.js';

const state = {
  organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [{subjectId: 'supervisor-1', organizationId: 'org-1', status: 'active', roleIds: ['supervisor']}, {subjectId: 'tech-1', organizationId: 'org-1', status: 'active', roleIds: ['technician']}],
  roles: [{roleId: 'supervisor', organizationId: 'org-1', permissions: ['job-rooms:tasks:write']}, {roleId: 'technician', organizationId: 'org-1', permissions: ['job-rooms:tasks:complete']}],
};
const createAuth = {subjectId: 'supervisor-1', organizationId: 'org-1', resourceOrganizationId: 'org-1', requiredPermission: 'job-rooms:tasks:write'};
const completeAuth = {subjectId: 'tech-1', organizationId: 'org-1', resourceOrganizationId: 'org-1', requiredPermission: 'job-rooms:tasks:complete'};
const createInput = {requestKey: 'task-request-1', jobRoomId: 'room-1', schedulingHoldId: 'hold-1', assignedMembershipId: 'member-tech', title: 'Install cabinets', checklist: [{checklistItemId: 'measure', label: 'Verify measurements'}, {checklistItemId: 'install', label: 'Install and secure cabinets'}]};

function fixture() {
  let sequence = 0;
  let task = null;
  let taskReplay = null;
  let completionReplay = null;
  let rejectWrite = false;
  const members = {
    'supervisor-1': {membershipId: 'member-supervisor', organizationId: 'org-1', jobRoomId: 'room-1', subjectId: 'supervisor-1', role: 'provider', status: 'active'},
    'tech-1': {membershipId: 'member-tech', organizationId: 'org-1', jobRoomId: 'room-1', subjectId: 'tech-1', role: 'provider', status: 'active'},
  };
  const options = {
    store: {
      getRoom: async () => ({organizationId: 'org-1', jobRoomId: 'room-1', status: 'active'}),
      getMembership: async (_organizationId, _jobRoomId, subjectId) => members[subjectId] ?? null,
      getMembershipById: async (_organizationId, _jobRoomId, membershipId) => Object.values(members).find(member => member.membershipId === membershipId) ?? null,
      getSchedule: async () => ({schedulingHoldId: 'hold-1', organizationId: 'org-1', jobRoomId: 'room-1', providerMembershipId: 'member-supervisor', status: 'confirmed'}),
      getTaskByRequestKey: async () => taskReplay,
      getTask: async () => task,
      createTask: async value => { if (rejectWrite) return false; task = value; return true; },
      getCompletionByRequestKey: async () => completionReplay,
      completeChecklistItem: async (value, completion) => { if (rejectWrite) return false; task = value; completionReplay = completion; return true; },
    },
    audit: {sink: {append: async () => {}}, createOpaqueId: () => `audit-${++sequence}`, now: () => 1_000},
    createOpaqueId: () => `opaque-${++sequence}`,
    now: () => 1_000,
  };
  return {options, task: () => task, setTaskReplay: value => { taskReplay = value; }, setTask: value => { task = value; }, setCompletionReplay: value => { completionReplay = value; }, setRejectWrite: value => { rejectWrite = value; }, members};
}

test('creates a confirmed-schedule task and replays only the exact checklist', async () => {
  const f = fixture();
  const created = await createTechnicianTask(1, createAuth, state, createInput, f.options);
  assert.equal(created.accepted, true);
  assert.equal(created.value.assignedMembershipId, 'member-tech');
  assert.deepEqual(created.value.checklist.map(item => item.status), ['pending', 'pending']);
  f.setTaskReplay(created.value);
  const replay = await createTechnicianTask(1, createAuth, state, createInput, f.options);
  assert.equal(replay.accepted, true);
  assert.equal(replay.replayed, true);
  assert.equal((await createTechnicianTask(1, createAuth, state, {...createInput, title: 'Changed'}, f.options)).accepted, false);
});

test('rejects cross-tenant creation, held schedules and invalid technician assignments', async () => {
  const crossTenant = {...createAuth, resourceOrganizationId: 'org-2'};
  assert.equal((await createTechnicianTask(1, crossTenant, state, createInput, fixture().options)).accepted, false);
  const held = fixture();
  held.options.store.getSchedule = async () => ({schedulingHoldId: 'hold-1', organizationId: 'org-1', jobRoomId: 'room-1', providerMembershipId: 'member-supervisor', status: 'held'});
  assert.equal((await createTechnicianTask(1, createAuth, state, createInput, held.options)).accepted, false);
  const customer = fixture();
  customer.members['tech-1'] = {...customer.members['tech-1'], role: 'customer'};
  assert.equal((await createTechnicianTask(1, createAuth, state, createInput, customer.options)).accepted, false);
});

test('assigned technician completes ordered checklist items with exact retry', async () => {
  const f = fixture();
  await createTechnicianTask(1, createAuth, state, createInput, f.options);
  const input = {requestKey: 'completion-1', technicianTaskId: f.task().technicianTaskId, checklistItemId: 'measure', expectedRevision: 1};
  const completed = await completeTechnicianChecklistItem(1, completeAuth, state, input, f.options);
  assert.equal(completed.accepted, true);
  assert.equal(completed.value.revision, 2);
  assert.equal(completed.value.status, 'active');
  assert.equal(completed.value.checklist[0].completedByMembershipId, 'member-tech');
  const replay = await completeTechnicianChecklistItem(1, completeAuth, state, input, f.options);
  assert.equal(replay.accepted, true);
  assert.equal(replay.replayed, true);
  f.setCompletionReplay(null);
  const final = await completeTechnicianChecklistItem(1, completeAuth, state, {requestKey: 'completion-2', technicianTaskId: f.task().technicianTaskId, checklistItemId: 'install', expectedRevision: 2}, f.options);
  assert.equal(final.value.status, 'completed');
  assert.equal(final.value.completedAt, 1_000);
});

test('rejects another member, stale revisions, changed replays and failed writes', async () => {
  const other = fixture();
  await createTechnicianTask(1, createAuth, state, createInput, other.options);
  other.members['tech-1'] = {...other.members['tech-1'], membershipId: 'rebound-member'};
  assert.equal((await completeTechnicianChecklistItem(1, completeAuth, state, {requestKey: 'completion-1', technicianTaskId: other.task().technicianTaskId, checklistItemId: 'measure', expectedRevision: 1}, other.options)).accepted, false);
  const stale = fixture();
  await createTechnicianTask(1, createAuth, state, createInput, stale.options);
  assert.equal((await completeTechnicianChecklistItem(1, completeAuth, state, {requestKey: 'completion-1', technicianTaskId: stale.task().technicianTaskId, checklistItemId: 'measure', expectedRevision: 2}, stale.options)).accepted, false);
  const changed = fixture();
  await createTechnicianTask(1, createAuth, state, createInput, changed.options);
  const first = {requestKey: 'completion-1', technicianTaskId: changed.task().technicianTaskId, checklistItemId: 'measure', expectedRevision: 1};
  await completeTechnicianChecklistItem(1, completeAuth, state, first, changed.options);
  assert.equal((await completeTechnicianChecklistItem(1, completeAuth, state, {...first, checklistItemId: 'install'}, changed.options)).accepted, false);
  const failed = fixture();
  await createTechnicianTask(1, createAuth, state, createInput, failed.options);
  failed.setRejectWrite(true);
  assert.equal((await completeTechnicianChecklistItem(1, completeAuth, state, {requestKey: 'completion-1', technicianTaskId: failed.task().technicianTaskId, checklistItemId: 'measure', expectedRevision: 1}, failed.options)).accepted, false);
});

test('contaminated stored task and duplicate checklist identifiers fail closed', async () => {
  const duplicate = fixture();
  assert.equal((await createTechnicianTask(1, createAuth, state, {...createInput, checklist: [{checklistItemId: 'same', label: 'First'}, {checklistItemId: 'same', label: 'Second'}]}, duplicate.options)).accepted, false);
  const contaminated = fixture();
  await createTechnicianTask(1, createAuth, state, createInput, contaminated.options);
  contaminated.setTask({...contaminated.task(), organizationId: 'org-2'});
  assert.equal((await completeTechnicianChecklistItem(1, completeAuth, state, {requestKey: 'completion-1', technicianTaskId: contaminated.task().technicianTaskId, checklistItemId: 'measure', expectedRevision: 1}, contaminated.options)).accepted, false);
});
