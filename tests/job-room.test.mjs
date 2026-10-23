import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptJobRoomInvitation, inviteJobRoomMember} from '../packages/contracts/dist/job-room.js';

const state = {organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [
    {subjectId: 'owner-1', organizationId: 'org-1', status: 'active', roleIds: ['owner']},
    {subjectId: 'invitee-1', organizationId: 'org-1', status: 'active', roleIds: ['invitee']},
  ], roles: [
    {roleId: 'owner', organizationId: 'org-1', permissions: ['job-rooms:invite']},
    {roleId: 'invitee', organizationId: 'org-1', permissions: ['job-rooms:join']},
  ]};
const auth = (subjectId, permission) => ({subjectId, organizationId: 'org-1',
  resourceOrganizationId: 'org-1', requiredPermission: permission});
const inviteInput = {requestKey: 'invite-1', jobRoomId: 'room-1',
  invitedSubjectId: 'invitee-1', role: 'provider', expiresAt: 2_000_000};
const acceptInput = {requestKey: 'accept-1', invitationId: 'invitation-1'};

function fixture() {
  let sequence = 0, invitationReplay = null, pending = null, member = null,
    acceptanceReplay = null, acceptedInvitation = null, committed = null;
  const invitation = {invitationId: 'invitation-1', organizationId: 'org-1',
    requestKey: 'invite-existing', jobRoomId: 'room-1', invitedSubjectId: 'invitee-1',
    role: 'provider', invitedBySubjectId: 'owner-1', expiresAt: 2_000_000,
    createdAt: 900_000};
  const options = {store: {
    getJobRoom: async () => ({organizationId: 'org-1', jobRoomId: 'room-1',
      customerSubjectId: 'customer-1', providerOrganizationId: 'provider-1', status: 'active'}),
    getMembership: async (_org, _room, subject) => subject === 'owner-1'
      ? {membershipId: 'owner-membership', organizationId: 'org-1', jobRoomId: 'room-1',
        subjectId: 'owner-1', role: 'customer', canInvite: true, invitationId: null,
        createdAt: 500_000} : member,
    getProviderOperator: async () => ({organizationId: 'org-1',
      providerOrganizationId: 'provider-1', subjectId: 'invitee-1', status: 'active',
      permissions: ['job-rooms:join']}),
    getInvitation: async () => invitation,
    getInvitationByRequestKey: async () => invitationReplay,
    getPendingInvitation: async () => pending,
    createInvitation: async value => { committed = value; return true; },
    getAcceptanceByRequestKey: async () => acceptanceReplay,
    getAcceptanceByInvitation: async () => acceptedInvitation,
    createMembershipFromInvitation: async (membership, acceptance) => {
      committed = {membership, acceptance}; member = membership; return true;
    },
  }, audit: {sink: {append: async () => {}}, createOpaqueId: () => 'audit-' + (++sequence),
    now: () => 1_000_000}, createOpaqueId: () => 'opaque-' + (++sequence),
  now: () => 1_000_000};
  return {options, invitation, committed: () => committed,
    setInvitationReplay: value => { invitationReplay = value; },
    setPending: value => { pending = value; }, setMember: value => { member = value; },
    setAcceptanceReplay: value => { acceptanceReplay = value; },
    setAcceptedInvitation: value => { acceptedInvitation = value; }};
}

test('active inviting member creates one bounded invitation and replays exactly', async () => {
  const value = fixture();
  const created = await inviteJobRoomMember(1, auth('owner-1', 'job-rooms:invite'), state,
    inviteInput, value.options);
  assert.equal(created.accepted, true); assert.equal(created.replayed, false);
  assert.equal(Object.isFrozen(created.value), true); assert.equal(value.committed(), created.value);
  value.setInvitationReplay(created.value);
  const replay = await inviteJobRoomMember(1, auth('owner-1', 'job-rooms:invite'), state,
    inviteInput, value.options);
  assert.equal(replay.accepted, true); assert.equal(replay.replayed, true);
});

test('rejects non-inviters, duplicate members, pending invitations, conflicts, and bad expiry', async () => {
  const noInvite = fixture();
  noInvite.options.store.getMembership = async () => ({membershipId: 'owner-membership',
    organizationId: 'org-1', jobRoomId: 'room-1', subjectId: 'owner-1', role: 'customer',
    canInvite: false, invitationId: null, createdAt: 500_000});
  assert.deepEqual(await inviteJobRoomMember(1, auth('owner-1', 'job-rooms:invite'), state,
    inviteInput, noInvite.options), {accepted: false, code: 'job_room_rejected'});
  const duplicate = fixture(); duplicate.setMember({membershipId: 'existing',
    organizationId: 'org-1', jobRoomId: 'room-1', subjectId: 'invitee-1', role: 'provider',
    canInvite: false, invitationId: 'old', createdAt: 800_000});
  assert.deepEqual(await inviteJobRoomMember(1, auth('owner-1', 'job-rooms:invite'), state,
    inviteInput, duplicate.options), {accepted: false, code: 'job_room_rejected'});
  const pending = fixture(); pending.setPending(pending.invitation);
  assert.deepEqual(await inviteJobRoomMember(1, auth('owner-1', 'job-rooms:invite'), state,
    inviteInput, pending.options), {accepted: false, code: 'job_room_rejected'});
  const conflict = fixture(); conflict.setInvitationReplay({...conflict.invitation,
    requestKey: 'invite-1', invitedSubjectId: 'other'});
  assert.deepEqual(await inviteJobRoomMember(1, auth('owner-1', 'job-rooms:invite'), state,
    inviteInput, conflict.options), {accepted: false, code: 'job_room_rejected'});
  assert.deepEqual(await inviteJobRoomMember(1, auth('owner-1', 'job-rooms:invite'), state,
    {...inviteInput, expiresAt: 1_000_000}, fixture().options),
  {accepted: false, code: 'job_room_rejected'});
});

test('named active provider operator accepts once into an immutable membership', async () => {
  const value = fixture();
  const created = await acceptJobRoomInvitation(1,
    auth('invitee-1', 'job-rooms:join'), state, acceptInput, value.options);
  assert.equal(created.accepted, true); assert.equal(created.replayed, false);
  assert.equal(created.value.role, 'provider'); assert.equal(created.value.canInvite, false);
  assert.equal(Object.isFrozen(created.value), true);
  value.setAcceptanceReplay(value.committed().acceptance);
  const replay = await acceptJobRoomInvitation(1,
    auth('invitee-1', 'job-rooms:join'), state, acceptInput, value.options);
  assert.equal(replay.accepted, true); assert.equal(replay.replayed, true);
});

test('rejects wrong subject, expired or contaminated invitation, and inactive provider operator', async () => {
  assert.deepEqual(await acceptJobRoomInvitation(1,
    auth('owner-1', 'job-rooms:join'), state, acceptInput, fixture().options),
  {accepted: false, code: 'job_room_rejected'});
  const expired = fixture(); expired.options.store.getInvitation = async () =>
    ({...expired.invitation, expiresAt: 1_000_000});
  assert.deepEqual(await acceptJobRoomInvitation(1,
    auth('invitee-1', 'job-rooms:join'), state, acceptInput, expired.options),
  {accepted: false, code: 'job_room_rejected'});
  const contaminated = fixture(); contaminated.options.store.getJobRoom = async () =>
    ({organizationId: 'org-2', jobRoomId: 'room-1', customerSubjectId: 'customer-1',
      providerOrganizationId: 'provider-1', status: 'active'});
  assert.deepEqual(await acceptJobRoomInvitation(1,
    auth('invitee-1', 'job-rooms:join'), state, acceptInput, contaminated.options),
  {accepted: false, code: 'job_room_rejected'});
  const inactive = fixture(); inactive.options.store.getProviderOperator = async () =>
    ({organizationId: 'org-1', providerOrganizationId: 'provider-1',
      subjectId: 'invitee-1', status: 'inactive', permissions: ['job-rooms:join']});
  assert.deepEqual(await acceptJobRoomInvitation(1,
    auth('invitee-1', 'job-rooms:join'), state, acceptInput, inactive.options),
  {accepted: false, code: 'job_room_rejected'});
});

test('fails closed for conflicting acceptance, audit outage, and atomic write failure', async () => {
  const conflict = fixture(); conflict.setAcceptedInvitation({acceptanceId: 'accepted',
    organizationId: 'org-1', requestKey: 'old', invitationId: 'invitation-1',
    membershipId: 'existing', acceptedBySubjectId: 'invitee-1', acceptedAt: 900_000});
  assert.deepEqual(await acceptJobRoomInvitation(1,
    auth('invitee-1', 'job-rooms:join'), state, acceptInput, conflict.options),
  {accepted: false, code: 'job_room_rejected'});
  const audit = fixture(); audit.options.audit.sink.append = async () => { throw Error('down'); };
  assert.deepEqual(await inviteJobRoomMember(1, auth('owner-1', 'job-rooms:invite'), state,
    inviteInput, audit.options), {accepted: false, code: 'job_room_rejected'});
  const write = fixture(); write.options.store.createMembershipFromInvitation = async () => false;
  assert.deepEqual(await acceptJobRoomInvitation(1,
    auth('invitee-1', 'job-rooms:join'), state, acceptInput, write.options),
  {accepted: false, code: 'job_room_rejected'});
});
