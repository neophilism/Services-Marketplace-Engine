import test from 'node:test';
import assert from 'node:assert/strict';
import {recordJobRoomReceipt, sendJobRoomMessage} from '../packages/contracts/dist/job-room-chat.js';

const state = {organizations: [{organizationId: 'org-1', status: 'active'}], memberships: [
  {subjectId: 'sender-1', organizationId: 'org-1', status: 'active', roleIds: ['member']},
  {subjectId: 'reader-1', organizationId: 'org-1', status: 'active', roleIds: ['member']},
], roles: [{roleId: 'member', organizationId: 'org-1', permissions: ['job-rooms:chat', 'job-rooms:receipts']}]};
const auth = (subjectId, permission) => ({subjectId, organizationId: 'org-1', resourceOrganizationId: 'org-1', requiredPermission: permission});
const sendInput = {requestKey: 'send-1', jobRoomId: 'room-1', body: 'Status update'};
const receiptInput = {requestKey: 'receipt-1', jobRoomId: 'room-1', messageId: 'message-existing', status: 'delivered'};

function fixture() {
  let sequence = 0, messageReplay = null, receiptReplay = null, previousReceipt = null, committed = null;
  const memberships = [
    {membershipId: 'member-sender', organizationId: 'org-1', jobRoomId: 'room-1', subjectId: 'sender-1', role: 'customer'},
    {membershipId: 'member-reader', organizationId: 'org-1', jobRoomId: 'room-1', subjectId: 'reader-1', role: 'provider'},
  ];
  const message = {messageId: 'message-existing', organizationId: 'org-1', requestKey: 'send-existing', jobRoomId: 'room-1', senderMembershipId: 'member-sender', senderSubjectId: 'sender-1', body: 'Hello', createdAt: 900};
  const options = {store: {
    getJobRoom: async () => ({organizationId: 'org-1', jobRoomId: 'room-1', status: 'active'}),
    getMembership: async (_org, _room, subject) => memberships.find(value => value.subjectId === subject) ?? null,
    listMemberships: async () => memberships,
    getMessage: async () => message,
    getMessageByRequestKey: async () => messageReplay,
    createMessage: async (value, notifications) => { committed = {message: value, notifications}; return true; },
    getReceiptByRequestKey: async () => receiptReplay,
    getReceipt: async () => previousReceipt,
    advanceReceipt: async (value, previousReceiptId) => { committed = {receipt: value, previousReceiptId}; previousReceipt = value; return true; },
  }, audit: {sink: {append: async () => {}}, createOpaqueId: () => 'audit-' + (++sequence), now: () => 1_000}, createOpaqueId: () => 'opaque-' + (++sequence), now: () => 1_000};
  return {options, memberships, message, committed: () => committed, setMessageReplay: value => { messageReplay = value; }, setReceiptReplay: value => { receiptReplay = value; }, setPreviousReceipt: value => { previousReceipt = value; }};
}

test('member sends one immutable message with metadata-only notifications and exact replay', async () => {
  const value = fixture(); const created = await sendJobRoomMessage(1, auth('sender-1', 'job-rooms:chat'), state, sendInput, value.options);
  assert.equal(created.accepted, true); assert.equal(created.replayed, false); assert.equal(created.value.notifications.length, 1); assert.equal('body' in created.value.notifications[0], false); assert.equal(Object.isFrozen(created.value.message), true);
  value.setMessageReplay(created.value.message); const replay = await sendJobRoomMessage(1, auth('sender-1', 'job-rooms:chat'), state, sendInput, value.options); assert.equal(replay.accepted, true); assert.equal(replay.replayed, true); assert.equal(replay.value.notifications.length, 0);
});

test('send rejects non-members, contaminated rosters, conflicting keys, and invalid bodies', async () => {
  const nonmember = fixture(); nonmember.options.store.getMembership = async () => null;
  assert.deepEqual(await sendJobRoomMessage(1, auth('sender-1', 'job-rooms:chat'), state, sendInput, nonmember.options), {accepted: false, code: 'job_room_chat_rejected'});
  const contaminated = fixture(); contaminated.options.store.listMemberships = async () => [...contaminated.memberships, {...contaminated.memberships[1], organizationId: 'org-2'}];
  assert.deepEqual(await sendJobRoomMessage(1, auth('sender-1', 'job-rooms:chat'), state, sendInput, contaminated.options), {accepted: false, code: 'job_room_chat_rejected'});
  const conflict = fixture(); conflict.setMessageReplay({...conflict.message, requestKey: 'send-1'});
  assert.deepEqual(await sendJobRoomMessage(1, auth('sender-1', 'job-rooms:chat'), state, sendInput, conflict.options), {accepted: false, code: 'job_room_chat_rejected'});
  assert.deepEqual(await sendJobRoomMessage(1, auth('sender-1', 'job-rooms:chat'), state, {...sendInput, body: ' padded '}, fixture().options), {accepted: false, code: 'job_room_chat_rejected'});
});

test('recipient records delivered then read receipts without downgrade and replays exactly', async () => {
  const value = fixture(); const delivered = await recordJobRoomReceipt(1, auth('reader-1', 'job-rooms:receipts'), state, receiptInput, value.options);
  assert.equal(delivered.accepted, true); assert.equal(delivered.value.status, 'delivered'); assert.equal(value.committed().previousReceiptId, null);
  const readInput = {...receiptInput, requestKey: 'receipt-2', status: 'read'}; const read = await recordJobRoomReceipt(1, auth('reader-1', 'job-rooms:receipts'), state, readInput, value.options);
  assert.equal(read.accepted, true); assert.equal(read.value.status, 'read'); assert.equal(value.committed().previousReceiptId, delivered.value.receiptId);
  value.setReceiptReplay(read.value); const replay = await recordJobRoomReceipt(1, auth('reader-1', 'job-rooms:receipts'), state, readInput, value.options); assert.equal(replay.accepted, true); assert.equal(replay.replayed, true);
  assert.deepEqual(await recordJobRoomReceipt(1, auth('reader-1', 'job-rooms:receipts'), state, {...receiptInput, requestKey: 'receipt-3'}, value.options), {accepted: false, code: 'job_room_chat_rejected'});
});

test('receipt rejects sender acknowledgements, cross-room messages, and conflicting replay', async () => {
  assert.deepEqual(await recordJobRoomReceipt(1, auth('sender-1', 'job-rooms:receipts'), state, receiptInput, fixture().options), {accepted: false, code: 'job_room_chat_rejected'});
  const crossRoom = fixture(); crossRoom.options.store.getMessage = async () => ({...crossRoom.message, jobRoomId: 'room-2'});
  assert.deepEqual(await recordJobRoomReceipt(1, auth('reader-1', 'job-rooms:receipts'), state, receiptInput, crossRoom.options), {accepted: false, code: 'job_room_chat_rejected'});
  const conflict = fixture(); conflict.setReceiptReplay({receiptId: 'receipt-old', organizationId: 'org-1', requestKey: 'receipt-1', jobRoomId: 'room-1', messageId: 'different', membershipId: 'member-reader', subjectId: 'reader-1', status: 'delivered', occurredAt: 950});
  assert.deepEqual(await recordJobRoomReceipt(1, auth('reader-1', 'job-rooms:receipts'), state, receiptInput, conflict.options), {accepted: false, code: 'job_room_chat_rejected'});
});

test('audit and atomic persistence failures fail closed', async () => {
  const audit = fixture(); audit.options.audit.sink.append = async () => { throw Error('down'); };
  assert.deepEqual(await sendJobRoomMessage(1, auth('sender-1', 'job-rooms:chat'), state, sendInput, audit.options), {accepted: false, code: 'job_room_chat_rejected'});
  const messageWrite = fixture(); messageWrite.options.store.createMessage = async () => false;
  assert.deepEqual(await sendJobRoomMessage(1, auth('sender-1', 'job-rooms:chat'), state, sendInput, messageWrite.options), {accepted: false, code: 'job_room_chat_rejected'});
  const receiptWrite = fixture(); receiptWrite.options.store.advanceReceipt = async () => false;
  assert.deepEqual(await recordJobRoomReceipt(1, auth('reader-1', 'job-rooms:receipts'), state, receiptInput, receiptWrite.options), {accepted: false, code: 'job_room_chat_rejected'});
});
