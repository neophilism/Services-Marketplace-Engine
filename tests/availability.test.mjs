import test from 'node:test';
import assert from 'node:assert/strict';
import {listAppointmentSlots, putAvailabilitySchedule} from '../packages/contracts/dist/availability.js';

const permissions = ['availability:read', 'availability:write'];
const state = {
  organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [{subjectId: 'operator-1', organizationId: 'org-1', status: 'active', roleIds: ['admin']}],
  roles: [{roleId: 'admin', organizationId: 'org-1', permissions}],
};
const auth = requiredPermission => ({subjectId: 'operator-1', organizationId: 'org-1',
  resourceOrganizationId: 'org-1', requiredPermission});
const minute = 60_000;
const day = 86_400_000;

function fixture() {
  let sequence = 0;
  let now = 1_000_000;
  let schedule = null;
  let busyIntervals = [];
  const provider = {providerOrganizationId: 'provider-1', organizationId: 'org-1', status: 'active'};
  const service = {organizationId: 'org-1', serviceKey: 'pipe-repair', revision: 2,
    status: 'published'};
  const options = {
    store: {
      getProvider: async () => provider,
      getPublishedService: async () => service,
      getSchedule: async () => schedule,
      replaceSchedule: async (current, replacement) => {
        if (schedule !== current) return false;
        schedule = replacement;
        return true;
      },
      listBusyIntervals: async () => busyIntervals,
    },
    audit: {sink: {append: async () => {}}, createOpaqueId: () => 'audit-' + (++sequence), now: () => now},
    createOpaqueId: () => 'availability-' + (++sequence),
    now: () => now,
  };
  return {
    options, provider, service,
    getSchedule: () => schedule,
    setSchedule: value => { schedule = value; },
    setBusy: value => { busyIntervals = value; },
    setNow: value => { now = value; },
  };
}

const input = {
  providerOrganizationId: 'provider-1', serviceKey: 'pipe-repair', slotDurationMinutes: 30,
  minimumNoticeMinutes: 60, bookingHorizonDays: 30, status: 'active',
  windows: [{startAt: 2_800_000, endAt: 6_400_000}, {startAt: 8_200_000, endAt: 10_000_000}],
};
const put = (value, changedInput = input, expectedVersion = 0,
  authorization = auth('availability:write'), version = 1) =>
  putAvailabilitySchedule(version, authorization, state, changedInput, expectedVersion, value.options);

test('stores normalized immutable availability bound to canonical parents', async () => {
  const value = fixture();
  const result = await put(value, {...input, windows: [...input.windows].reverse()});
  assert.equal(result.accepted, true);
  assert.equal(result.value.serviceRevision, 2);
  assert.deepEqual(result.value.windows, input.windows);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.windows[0]), true);
});

test('rejects unauthorized, malformed and inactive-parent schedule writes', async () => {
  assert.deepEqual(await put(fixture(), input, 0, auth('availability:read')),
    {accepted: false, code: 'availability_rejected'});
  assert.deepEqual(await put(fixture(), {...input, slotDurationMinutes: 0}),
    {accepted: false, code: 'availability_rejected'});
  assert.deepEqual(await put(fixture(), {...input, windows: [
    {startAt: 2_800_000, endAt: 6_400_000}, {startAt: 6_000_000, endAt: 8_000_000},
  ]}), {accepted: false, code: 'availability_rejected'});
  const inactive = fixture();
  inactive.provider.status = 'suspended';
  assert.deepEqual(await put(inactive), {accepted: false, code: 'availability_rejected'});
  const draft = fixture();
  draft.service.status = 'draft';
  assert.deepEqual(await put(draft), {accepted: false, code: 'availability_rejected'});
});

test('updates schedules with optimistic concurrency and refreshed service revision', async () => {
  const value = fixture();
  const created = await put(value);
  value.service.revision = 3;
  value.setNow(2_000_000);
  const updated = await put(value, {...input, minimumNoticeMinutes: 120}, 1);
  assert.equal(updated.accepted, true);
  assert.equal(updated.value.version, 2);
  assert.equal(updated.value.serviceRevision, 3);
  assert.equal(updated.value.availabilityScheduleId, created.value.availabilityScheduleId);
  assert.deepEqual(await put(value, input, 1), {accepted: false, code: 'availability_rejected'});
});

test('projects deterministic slots within notice and horizon while excluding busy intervals', async () => {
  const value = fixture();
  await put(value, {...input, minimumNoticeMinutes: 30});
  value.setBusy([{busyIntervalId: 'busy-1', organizationId: 'org-1',
    providerOrganizationId: 'provider-1', serviceKey: 'pipe-repair',
    startAt: 4_600_000, endAt: 6_400_000}]);
  const result = await listAppointmentSlots(auth('availability:read'), state, {
    providerOrganizationId: 'provider-1', serviceKey: 'pipe-repair',
    startAt: 1_000_000, endAt: 12_000_000, limit: 3,
  }, value.options);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.value.map(slot => [slot.startAt, slot.endAt]), [
    [2_800_000, 4_600_000], [8_200_000, 10_000_000],
  ]);
  assert.equal(result.value[0].scheduleVersion, 1);
});

test('enforces query bounds, exact permissions and canonical current revision', async () => {
  const value = fixture();
  await put(value);
  const query = {providerOrganizationId: 'provider-1', serviceKey: 'pipe-repair',
    startAt: 1_000_000, endAt: 2_000_000 + day, limit: 10};
  assert.deepEqual(await listAppointmentSlots(auth('availability:write'), state, query, value.options),
    {accepted: false, code: 'availability_rejected'});
  assert.deepEqual(await listAppointmentSlots(auth('availability:read'), state,
    {...query, limit: 501}, value.options), {accepted: false, code: 'availability_rejected'});
  value.service.revision = 3;
  assert.deepEqual(await listAppointmentSlots(auth('availability:read'), state, query, value.options),
    {accepted: false, code: 'availability_rejected'});
});

test('fails closed on tenant contamination, duplicates and unavailable boundaries', async () => {
  const contaminated = fixture();
  await put(contaminated);
  contaminated.setBusy([{busyIntervalId: 'busy-1', organizationId: 'org-2',
    providerOrganizationId: 'provider-1', serviceKey: 'pipe-repair', startAt: 1, endAt: 2}]);
  const query = {providerOrganizationId: 'provider-1', serviceKey: 'pipe-repair',
    startAt: 1_000_000, endAt: 12_000_000, limit: 10};
  assert.deepEqual(await listAppointmentSlots(auth('availability:read'), state, query,
    contaminated.options), {accepted: false, code: 'availability_rejected'});
  const duplicate = fixture();
  await put(duplicate);
  const busy = {busyIntervalId: 'busy-1', organizationId: 'org-1',
    providerOrganizationId: 'provider-1', serviceKey: 'pipe-repair', startAt: 1, endAt: 2};
  duplicate.setBusy([busy, busy]);
  assert.deepEqual(await listAppointmentSlots(auth('availability:read'), state, query,
    duplicate.options), {accepted: false, code: 'availability_rejected'});
  const audit = fixture();
  audit.options.audit.sink.append = async () => { throw new Error('unavailable'); };
  assert.deepEqual(await put(audit), {accepted: false, code: 'availability_rejected'});
  const persistence = fixture();
  persistence.options.store.replaceSchedule = async () => { throw new Error('unavailable'); };
  assert.deepEqual(await put(persistence), {accepted: false, code: 'availability_rejected'});
});
