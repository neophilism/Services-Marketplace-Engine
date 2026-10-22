import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getProviderEmployee,
  inviteProviderEmployee,
  listProviderEmployees,
  replaceProviderEmployeePermissions,
  transitionProviderEmployee,
} from '../packages/contracts/dist/provider-employee.js';

const permissions = [
  'provider-employee:read', 'provider-employee:write', 'provider-permission:grant',
];
const state = {
  organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [{subjectId: 'admin-1', organizationId: 'org-1', status: 'active', roleIds: ['admin']}],
  roles: [{roleId: 'admin', organizationId: 'org-1', permissions}],
};
const auth = requiredPermission => ({
  subjectId: 'admin-1', organizationId: 'org-1', resourceOrganizationId: 'org-1', requiredPermission,
});
const invite = {
  providerOrganizationId: 'provider-1', subjectId: 'employee-1', displayName: 'Taylor Employee',
  permissions: ['job:read', 'quote:write', 'job:read'],
};

function fixture() {
  let sequence = 0;
  let now = 1_000;
  const provider = {
    providerOrganizationId: 'provider-1', organizationId: 'org-1',
    legalName: 'Example Services Incorporated', publicName: 'Example Services', status: 'draft',
    version: 1, createdAt: 1, updatedAt: 1,
  };
  const employees = new Map();
  const options = {
    store: {
      getProvider: async (organizationId, id) =>
        provider.organizationId === organizationId && provider.providerOrganizationId === id ? provider : null,
      createEmployee: async value => {
        if ([...employees.values()].some(candidate =>
          candidate.organizationId === value.organizationId &&
          candidate.providerOrganizationId === value.providerOrganizationId &&
          candidate.subjectId === value.subjectId && candidate.status !== 'revoked')) return false;
        employees.set(value.providerEmployeeId, value);
        return true;
      },
      getEmployee: async (organizationId, id) => {
        const value = employees.get(id);
        return value?.organizationId === organizationId ? value : null;
      },
      replaceEmployee: async (current, replacement) => {
        if (employees.get(current.providerEmployeeId) !== current) return false;
        employees.set(current.providerEmployeeId, replacement);
        return true;
      },
      listEmployees: async (organizationId, providerOrganizationId) => [...employees.values()].filter(
        value => value.organizationId === organizationId &&
          value.providerOrganizationId === providerOrganizationId,
      ),
    },
    audit: {
      sink: {append: async () => {}},
      createOpaqueId: () => 'audit-' + (++sequence),
      now: () => now,
    },
    permissionCatalog: new Set(['job:read', 'job:write', 'quote:read', 'quote:write']),
    createOpaqueId: () => 'employee-record-' + (++sequence),
    now: () => now,
  };
  return {employees, options, provider, setNow: value => { now = value; }};
}

const inviteEmployee = value => inviteProviderEmployee(
  1, auth('provider-employee:write'), state, invite, value.options,
);

test('invites a tenant-bound employee with normalized catalog permissions', async () => {
  const value = fixture();
  const result = await inviteEmployee(value);
  assert.equal(result.accepted, true);
  assert.equal(result.value.status, 'invited');
  assert.deepEqual(result.value.permissions, ['job:read', 'quote:write']);
  assert.equal(Object.isFrozen(result.value.permissions), true);
  assert.deepEqual(await inviteEmployee(value), {accepted: false, code: 'provider_employee_rejected'});
});

test('invitation rejects contract, tenant, permission, parent and grant failures', async () => {
  for (const [version, authorization, input, mutate] of [
    [2, auth('provider-employee:write'), invite],
    [1, auth('provider-employee:read'), invite],
    [1, {...auth('provider-employee:write'), resourceOrganizationId: 'org-2'}, invite],
    [1, auth('provider-employee:write'), {...invite, providerOrganizationId: 'missing'}],
    [1, auth('provider-employee:write'), {...invite, permissions: ['owner:all']}],
    [1, auth('provider-employee:write'), {...invite, permissions: []}],
    [1, auth('provider-employee:write'), invite, value => {
      value.options.store.getProvider = async () => ({...value.provider, organizationId: 'org-2'});
    }],
  ]) {
    const value = fixture();
    mutate?.(value);
    assert.deepEqual(await inviteProviderEmployee(version, authorization, state, input, value.options), {
      accepted: false, code: 'provider_employee_rejected',
    });
    assert.equal(value.employees.size, 0);
  }
});

test('employee reads require exact authority and reject contaminated adapters', async () => {
  const value = fixture();
  const employee = (await inviteEmployee(value)).value;
  assert.deepEqual(await getProviderEmployee(
    auth('provider-employee:read'), state, employee.providerOrganizationId,
    employee.providerEmployeeId, value.options,
  ), {accepted: true, value: employee});
  assert.deepEqual(await getProviderEmployee(
    auth('provider-employee:write'), state, employee.providerOrganizationId,
    employee.providerEmployeeId, value.options,
  ), {accepted: false, code: 'provider_employee_rejected'});
  for (const contaminated of [
    {...employee, organizationId: 'org-2'},
    {...employee, providerEmployeeId: 'other'},
    {...employee, providerOrganizationId: 'provider-2'},
  ]) {
    value.options.store.getEmployee = async () => contaminated;
    assert.deepEqual(await getProviderEmployee(
      auth('provider-employee:read'), state, employee.providerOrganizationId,
      employee.providerEmployeeId, value.options,
    ), {accepted: false, code: 'provider_employee_rejected'});
  }
});

test('permission replacement needs separate grant authority and current version', async () => {
  const value = fixture();
  const employee = (await inviteEmployee(value)).value;
  value.setNow(2_000);
  const updated = await replaceProviderEmployeePermissions(
    auth('provider-permission:grant'), state, employee.providerOrganizationId,
    employee.providerEmployeeId, 1,
    ['job:write', 'job:read'], value.options,
  );
  assert.equal(updated.accepted, true);
  assert.equal(updated.value.version, 2);
  assert.deepEqual(updated.value.permissions, ['job:read', 'job:write']);
  assert.deepEqual(await replaceProviderEmployeePermissions(
    auth('provider-employee:write'), state, employee.providerOrganizationId,
    employee.providerEmployeeId, 2,
    ['job:read'], value.options,
  ), {accepted: false, code: 'provider_employee_rejected'});
  assert.deepEqual(await replaceProviderEmployeePermissions(
    auth('provider-permission:grant'), state, employee.providerOrganizationId,
    employee.providerEmployeeId, 1,
    ['job:read'], value.options,
  ), {accepted: false, code: 'provider_employee_rejected'});
});

test('lifecycle transitions are explicit and revocation is terminal', async () => {
  const value = fixture();
  let employee = (await inviteEmployee(value)).value;
  for (const status of ['active', 'suspended', 'active', 'revoked']) {
    value.setNow(value.options.now() + 1);
    const result = await transitionProviderEmployee(
      auth('provider-employee:write'), state, employee.providerOrganizationId,
      employee.providerEmployeeId,
      employee.version, status, value.options,
    );
    assert.equal(result.accepted, true);
    employee = result.value;
  }
  assert.deepEqual(await transitionProviderEmployee(
    auth('provider-employee:write'), state, employee.providerOrganizationId,
    employee.providerEmployeeId,
    employee.version, 'active', value.options,
  ), {accepted: false, code: 'provider_employee_rejected'});
  assert.deepEqual(await getProviderEmployee(
    auth('provider-employee:read'), state, employee.providerOrganizationId,
    employee.providerEmployeeId, value.options,
  ), {accepted: false, code: 'provider_employee_rejected'});
});

test('inactive providers block invitations, grants and activation but permit revocation', async () => {
  const value = fixture();
  let employee = (await inviteEmployee(value)).value;
  value.options.store.getProvider = async () => ({...value.provider, status: 'suspended'});
  value.setNow(2_000);
  assert.deepEqual(await replaceProviderEmployeePermissions(
    auth('provider-permission:grant'), state, employee.providerOrganizationId,
    employee.providerEmployeeId, 1,
    ['job:read'], value.options,
  ), {accepted: false, code: 'provider_employee_rejected'});
  assert.deepEqual(await transitionProviderEmployee(
    auth('provider-employee:write'), state, employee.providerOrganizationId,
    employee.providerEmployeeId, 1, 'active', value.options,
  ), {accepted: false, code: 'provider_employee_rejected'});
  const revoked = await transitionProviderEmployee(
    auth('provider-employee:write'), state, employee.providerOrganizationId,
    employee.providerEmployeeId, 1, 'revoked', value.options,
  );
  assert.equal(revoked.accepted, true);
});

test('listing rejects adapter contamination and excludes revoked employees', async () => {
  const value = fixture();
  const employee = (await inviteEmployee(value)).value;
  value.options.store.listEmployees = async () => [{...employee, organizationId: 'org-2'}];
  assert.deepEqual(await listProviderEmployees(
    auth('provider-employee:read'), state, employee.providerOrganizationId, value.options,
  ), {accepted: false, code: 'provider_employee_rejected'});
});

test('audit failure prevents persistence', async () => {
  const value = fixture();
  value.options.audit.sink.append = async () => { throw Error('unavailable'); };
  assert.deepEqual(await inviteEmployee(value), {accepted: false, code: 'provider_employee_rejected'});
  assert.equal(value.employees.size, 0);
});
