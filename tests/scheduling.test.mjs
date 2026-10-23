import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmSchedulingHold, createSchedulingHold} from '../packages/contracts/dist/scheduling.js';

const state = {
  organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [{subjectId: 'provider-1', organizationId: 'org-1', status: 'active',
    roleIds: ['provider']}],
  roles: [{roleId: 'provider', organizationId: 'org-1',
    permissions: ['job-rooms:scheduling:write']}],
};
const auth = {subjectId: 'provider-1', organizationId: 'org-1',
  resourceOrganizationId: 'org-1', requiredPermission: 'job-rooms:scheduling:write'};
const input = {requestKey: 'schedule-1', jobRoomId: 'room-1',
  contractEnvelopeId: 'envelope-1', summary: 'Kitchen installation',
  startAt: 3_600_000, endAt: 7_200_000, holdMinutes: 15};

function fixture() {
  let sequence = 0;
  let replay = null;
  let stored = null;
  let conflict = false;
  const options = {
    store: {
      getRoom: async () => ({organizationId: 'org-1', jobRoomId: 'room-1', status: 'active'}),
      getMembership: async () => ({membershipId: 'provider-member', organizationId: 'org-1',
        jobRoomId: 'room-1', subjectId: 'provider-1', role: 'provider'}),
      getSignedContract: async () => ({organizationId: 'org-1', jobRoomId: 'room-1',
        envelopeId: 'envelope-1', status: 'signed'}),
      getHoldByRequestKey: async () => replay,
      getHold: async () => stored,
      createHoldIfNoConflict: async value => {
        if (conflict) return false;
        stored = value;
        return true;
      },
      confirmHold: async value => { stored = value; return true; },
    },
    audit: {sink: {append: async () => {}}, createOpaqueId: () => `audit-${++sequence}`,
      now: () => 1_000},
    createOpaqueId: () => `hold-${++sequence}`,
    now: () => 1_000,
  };
  return {options, stored: () => stored, setReplay: value => { replay = value; },
    setConflict: value => { conflict = value; }};
}

test('creates a signed-contract-bound hold and replays the exact request', async () => {
  const fixtureState = fixture();
  const result = await createSchedulingHold(1, auth, state, input, fixtureState.options);
  assert.equal(result.accepted, true);
  assert.equal(result.value.status, 'held');
  assert.equal(result.value.providerMembershipId, 'provider-member');
  fixtureState.setReplay(result.value);
  const replay = await createSchedulingHold(1, auth, state, input, fixtureState.options);
  assert.equal(replay.accepted, true);
  assert.equal(replay.replayed, true);
});

test('rejects cross-tenant access, unsigned contracts, changed replay and conflicts', async () => {
  const wrongTenant = {...auth, resourceOrganizationId: 'org-2'};
  assert.equal((await createSchedulingHold(1, wrongTenant, state, input,
    fixture().options)).accepted, false);
  const unsigned = fixture();
  unsigned.options.store.getSignedContract = async () => ({organizationId: 'org-1',
    jobRoomId: 'room-1', envelopeId: 'envelope-1', status: 'pending'});
  assert.equal((await createSchedulingHold(1, auth, state, input, unsigned.options)).accepted, false);
  const changed = fixture();
  const first = await createSchedulingHold(1, auth, state, input, changed.options);
  changed.setReplay(first.value);
  assert.equal((await createSchedulingHold(1, auth, state, {...input, endAt: 8_000_000},
    changed.options)).accepted, false);
  const conflict = fixture();
  conflict.setConflict(true);
  assert.equal((await createSchedulingHold(1, auth, state, input, conflict.options)).accepted, false);
});

test('confirms an unexpired hold and returns deterministic folded ICS', async () => {
  const fixtureState = fixture();
  await createSchedulingHold(1, auth, state, input, fixtureState.options);
  const result = await confirmSchedulingHold(auth, state, fixtureState.stored().schedulingHoldId,
    fixtureState.options);
  assert.equal(result.accepted, true);
  assert.equal(result.value.hold.status, 'confirmed');
  assert.match(result.value.ics, /BEGIN:VCALENDAR\r\n/);
  assert.match(result.value.ics, /DTSTART:19700101T010000Z/);
  assert.match(result.value.ics, /SUMMARY:Kitchen installation/);
  assert.ok(result.value.ics.split('\r\n').every(line => line.length <= 74));
  const replay = await confirmSchedulingHold(auth, state,
    fixtureState.stored().schedulingHoldId, fixtureState.options);
  assert.equal(replay.replayed, true);
  assert.equal(replay.value.ics, result.value.ics);
});

test('expired, contaminated and failed compare-and-set confirmations fail closed', async () => {
  const expired = fixture();
  const created = await createSchedulingHold(1, auth, state, input, expired.options);
  expired.options.now = () => created.value.expiresAt;
  assert.equal((await confirmSchedulingHold(auth, state, created.value.schedulingHoldId,
    expired.options)).accepted, false);
  const contaminated = fixture();
  await createSchedulingHold(1, auth, state, input, contaminated.options);
  contaminated.options.store.getHold = async () => ({...contaminated.stored(), organizationId: 'org-2'});
  assert.equal((await confirmSchedulingHold(auth, state, contaminated.stored().schedulingHoldId,
    contaminated.options)).accepted, false);
  const wrongProvider = fixture();
  await createSchedulingHold(1, auth, state, input, wrongProvider.options);
  wrongProvider.options.store.getMembership = async () => ({membershipId: 'other-provider',
    organizationId: 'org-1', jobRoomId: 'room-1', subjectId: 'provider-1', role: 'provider'});
  assert.equal((await confirmSchedulingHold(auth, state, wrongProvider.stored().schedulingHoldId,
    wrongProvider.options)).accepted, false);
  const failed = fixture();
  await createSchedulingHold(1, auth, state, input, failed.options);
  failed.options.store.confirmHold = async () => false;
  assert.equal((await confirmSchedulingHold(auth, state, failed.stored().schedulingHoldId,
    failed.options)).accepted, false);
});

test('exact retry does not revive an expired hold', async () => {
  const fixtureState = fixture();
  const created = await createSchedulingHold(1, auth, state, input, fixtureState.options);
  fixtureState.setReplay(created.value);
  fixtureState.options.now = () => created.value.expiresAt;
  assert.equal((await createSchedulingHold(1, auth, state, input,
    fixtureState.options)).accepted, false);
});
