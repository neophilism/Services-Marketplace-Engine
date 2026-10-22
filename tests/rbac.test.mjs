import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeOrganizationAction} from '../packages/contracts/dist/rbac.js';

const request = {
  subjectId: 'subject-1',
  organizationId: 'org-1',
  resourceOrganizationId: 'org-1',
  requiredPermission: 'members:read',
};

const state = () => ({
  organizations: [{organizationId: 'org-1', status: 'active'}],
  memberships: [{
    subjectId: 'subject-1',
    organizationId: 'org-1',
    status: 'active',
    roleIds: ['viewer'],
  }],
  roles: [{
    roleId: 'viewer',
    organizationId: 'org-1',
    permissions: ['members:read'],
  }],
});

test('active organization membership resolves role permissions', () => {
  assert.deepEqual(authorizeOrganizationAction(request, state()), {
    authorized: true,
    organizationId: 'org-1',
    subjectId: 'subject-1',
    roleIds: ['viewer'],
  });
});

test('permissions are the union of all assigned roles', () => {
  const value = state();
  value.memberships[0].roleIds = ['viewer', 'editor'];
  value.roles.push({
    roleId: 'editor',
    organizationId: 'org-1',
    permissions: ['members:write'],
  });
  assert.equal(authorizeOrganizationAction(
    {...request, requiredPermission: 'members:write'},
    value,
  ).authorized, true);
});

test('tenant and lifecycle failures share one non-disclosing denial', async t => {
  const cases = [
    ['missing subject', {...request, subjectId: undefined}, state()],
    ['missing tenant', {...request, organizationId: undefined}, state()],
    ['cross-tenant resource', {...request, resourceOrganizationId: 'org-2'}, state()],
    ['closed organization', request, {...state(), organizations: [{organizationId: 'org-1', status: 'closed'}]}],
    ['invited membership', request, {...state(), memberships: [{...state().memberships[0], status: 'invited'}]}],
    ['revoked membership', request, {...state(), memberships: [{...state().memberships[0], status: 'revoked'}]}],
    ['missing permission', {...request, requiredPermission: 'members:write'}, state()],
  ];
  for (const [name, candidateRequest, candidateState] of cases) {
    await t.test(name, () => {
      assert.deepEqual(authorizeOrganizationAction(candidateRequest, candidateState), {
        authorized: false,
        code: 'authorization_denied',
      });
    });
  }
});

test('ambiguous memberships and role assignments fail closed', async t => {
  const cases = [
    ['duplicate membership', value => value.memberships.push({...value.memberships[0]})],
    ['no roles', value => { value.memberships[0].roleIds = []; }],
    ['duplicate role assignment', value => { value.memberships[0].roleIds = ['viewer', 'viewer']; }],
    ['unknown role', value => { value.memberships[0].roleIds = ['unknown']; }],
    ['duplicate role definition', value => value.roles.push({...value.roles[0]})],
    ['cross-tenant role', value => { value.roles[0].organizationId = 'org-2'; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const value = state();
      mutate(value);
      assert.deepEqual(authorizeOrganizationAction(request, value), {
        authorized: false,
        code: 'authorization_denied',
      });
    });
  }
});
