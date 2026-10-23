import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeSubcontractorPermission, grantSubcontractorPermissions, revokeSubcontractorPermissions} from '../packages/contracts/dist/subcontractor-permission.js';

const state={organizations:[{organizationId:'org-1',status:'active'}],memberships:[{subjectId:'provider-1',organizationId:'org-1',status:'active',roleIds:['provider']}],roles:[{roleId:'provider',organizationId:'org-1',permissions:['job-rooms:subcontractors:manage']}]};
const auth={subjectId:'provider-1',organizationId:'org-1',resourceOrganizationId:'org-1',requiredPermission:'job-rooms:subcontractors:manage'};
const input={requestKey:'grant-1',jobRoomId:'room-1',subcontractorMembershipId:'sub-member',permissions:['job-room:tasks:complete','job-room:tasks:view'],expiresAt:2_000_000};

function fixture(){
  let sequence=0,delegation=null,grantReplay=null,revocationReplay=null,rejectWrite=false;
  const members={['provider-1']:{membershipId:'provider-member',organizationId:'org-1',jobRoomId:'room-1',subjectId:'provider-1',role:'provider',status:'active'},['sub-1']:{membershipId:'sub-member',organizationId:'org-1',jobRoomId:'room-1',subjectId:'sub-1',role:'subcontractor',status:'active'}};
  const store={getRoom:async()=>({organizationId:'org-1',jobRoomId:'room-1',status:'active'}),getMembership:async(_o,_r,subjectId)=>members[subjectId]??null,getMembershipById:async(_o,_r,membershipId)=>Object.values(members).find(value=>value.membershipId===membershipId)??null,getDelegation:async()=>delegation,getDelegationByRequestKey:async()=>grantReplay,getActiveDelegation:async()=>delegation?.status==='active'?delegation:null,createDelegation:async value=>{if(rejectWrite)return false;delegation=value;grantReplay=value;return true;},getRevocationByRequestKey:async()=>revocationReplay,revokeDelegation:async(before,after,revocation)=>{if(rejectWrite||delegation!==before)return false;delegation=after;revocationReplay=revocation;return true;}};
  const options={store,audit:{sink:{append:async()=>{}},createOpaqueId:()=>`audit-${++sequence}`,now:()=>1_000_000},createOpaqueId:()=>`opaque-${++sequence}`,now:()=>1_000_000};
  return{options,delegation:()=>delegation,setRejectWrite:value=>{rejectWrite=value;},setRoom:value=>{store.getRoom=async()=>value;}};
}

test('grants bounded sorted capabilities with exact replay',async()=>{
  const f=fixture(),result=await grantSubcontractorPermissions(1,auth,state,input,f.options);
  assert.equal(result.accepted,true);assert.deepEqual(result.value.permissions,input.permissions);assert.equal(result.value.revision,1);
  assert.equal((await grantSubcontractorPermissions(1,auth,state,input,f.options)).replayed,true);
  assert.equal((await grantSubcontractorPermissions(1,auth,state,{...input,expiresAt:2_000_001},f.options)).accepted,false);
});

test('authorizes only current active room-bound delegated capabilities',async()=>{
  const f=fixture();await grantSubcontractorPermissions(1,auth,state,input,f.options);
  assert.equal((await authorizeSubcontractorPermission(1,'org-1','sub-1','room-1','job-room:tasks:view',f.options)).accepted,true);
  assert.equal((await authorizeSubcontractorPermission(1,'org-1','sub-1','room-1','job-room:media:read',f.options)).accepted,false);
  assert.equal((await authorizeSubcontractorPermission(1,'org-2','sub-1','room-1','job-room:tasks:view',f.options)).accepted,false);
  f.setRoom({organizationId:'org-1',jobRoomId:'room-1',status:'closed'});assert.equal((await authorizeSubcontractorPermission(1,'org-1','sub-1','room-1','job-room:tasks:view',f.options)).accepted,false);
});

test('revokes atomically with exact provider and revision binding',async()=>{
  const f=fixture(),granted=await grantSubcontractorPermissions(1,auth,state,input,f.options);
  const revoke={requestKey:'revoke-1',delegationId:granted.value.delegationId,expectedRevision:1};
  const result=await revokeSubcontractorPermissions(1,auth,state,revoke,f.options);assert.equal(result.accepted,true);assert.equal(f.delegation().status,'revoked');assert.equal(f.delegation().revision,2);
  assert.equal((await revokeSubcontractorPermissions(1,auth,state,revoke,f.options)).replayed,true);
  assert.equal((await authorizeSubcontractorPermission(1,'org-1','sub-1','room-1','job-room:tasks:view',f.options)).accepted,false);
});

test('rejects privilege escalation, rebinding, stale writes and dependency failure',async()=>{
  assert.equal((await grantSubcontractorPermissions(1,auth,state,{...input,permissions:['job-room:tasks:view','job-room:tasks:complete']},fixture().options)).accepted,false);
  assert.equal((await grantSubcontractorPermissions(1,auth,state,{...input,permissions:['job-rooms:change-orders:accept']},fixture().options)).accepted,false);
  assert.equal((await grantSubcontractorPermissions(1,{...auth,resourceOrganizationId:'org-2'},state,input,fixture().options)).accepted,false);
  const failed=fixture();failed.setRejectWrite(true);assert.equal((await grantSubcontractorPermissions(1,auth,state,input,failed.options)).accepted,false);
  const f=fixture(),granted=await grantSubcontractorPermissions(1,auth,state,input,f.options);assert.equal((await revokeSubcontractorPermissions(1,auth,state,{requestKey:'revoke-1',delegationId:granted.value.delegationId,expectedRevision:2},f.options)).accepted,false);
  f.setRejectWrite(true);assert.equal((await revokeSubcontractorPermissions(1,auth,state,{requestKey:'revoke-1',delegationId:granted.value.delegationId,expectedRevision:1},f.options)).accepted,false);
});
