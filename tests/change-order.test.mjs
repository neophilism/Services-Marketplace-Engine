import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptChangeOrderMilestone, createChangeOrder} from '../packages/contracts/dist/change-order.js';

const state={organizations:[{organizationId:'org-1',status:'active'}],memberships:[{subjectId:'provider-1',organizationId:'org-1',status:'active',roleIds:['provider']},{subjectId:'customer-1',organizationId:'org-1',status:'active',roleIds:['customer']}],roles:[{roleId:'provider',organizationId:'org-1',permissions:['job-rooms:change-orders:create']},{roleId:'customer',organizationId:'org-1',permissions:['job-rooms:change-orders:accept']}]};
const auth=(subjectId,requiredPermission)=>({subjectId,organizationId:'org-1',resourceOrganizationId:'org-1',requiredPermission});
const input={requestKey:'change-1',jobRoomId:'room-1',estimateId:'estimate-1',currency:'USD',reason:'Customer requested upgraded fixtures',milestones:[{milestoneId:'rough-in',label:'Rough-in',acceptanceCriteria:'New wiring inspected',amountDeltaMinor:12000,dueAt:2_000_000},{milestoneId:'finish',label:'Finish',acceptanceCriteria:'Fixtures installed and tested',amountDeltaMinor:-2000,dueAt:3_000_000}]};

function fixture(){
  let sequence=0,order=null,createReplay=null,acceptanceReplay=null,rejectWrite=false;
  const memberships={['provider-1']:{membershipId:'provider-member',organizationId:'org-1',jobRoomId:'room-1',subjectId:'provider-1',role:'provider',status:'active'},['customer-1']:{membershipId:'customer-member',organizationId:'org-1',jobRoomId:'room-1',subjectId:'customer-1',role:'customer',status:'active'}};
  const options={store:{getRoom:async()=>({organizationId:'org-1',jobRoomId:'room-1',customerSubjectId:'customer-1',status:'active'}),getMembership:async(_o,_r,subjectId)=>memberships[subjectId]??null,getApprovedEstimate:async()=>({estimateId:'estimate-1',organizationId:'org-1',jobRoomId:'room-1',currency:'USD',status:'approved'}),getChangeOrder:async()=>order,getChangeOrderByRequestKey:async()=>createReplay,createChangeOrder:async value=>{if(rejectWrite)return false;order=value;createReplay=value;return true;},getAcceptanceByRequestKey:async()=>acceptanceReplay,acceptMilestone:async(before,after,acceptance)=>{if(rejectWrite||order!==before)return false;order=after;acceptanceReplay=acceptance;return true;}},audit:{sink:{append:async()=>{}},createOpaqueId:()=>`audit-${++sequence}`,now:()=>1_000_000},createOpaqueId:()=>`opaque-${++sequence}`,now:()=>1_000_000};
  return{options,order:()=>order,setAcceptanceReplay:value=>{acceptanceReplay=value;},setRejectWrite:value=>{rejectWrite=value;}};
}

test('creates immutable estimate-bound orders and exact replay',async()=>{
  const f=fixture(),result=await createChangeOrder(1,auth('provider-1','job-rooms:change-orders:create'),state,input,f.options);
  assert.equal(result.accepted,true);assert.equal(result.value.totalDeltaMinor,10000);assert.equal(result.value.status,'proposed');
  assert.equal((await createChangeOrder(1,auth('provider-1','job-rooms:change-orders:create'),state,input,f.options)).replayed,true);
  assert.equal((await createChangeOrder(1,auth('provider-1','job-rooms:change-orders:create'),state,{...input,reason:'Changed'},f.options)).accepted,false);
});

test('customer accepts milestones in order through atomic revisions',async()=>{
  const f=fixture(),created=await createChangeOrder(1,auth('provider-1','job-rooms:change-orders:create'),state,input,f.options);f.setAcceptanceReplay(null);
  const firstInput={requestKey:'accept-1',jobRoomId:'room-1',changeOrderId:created.value.changeOrderId,milestoneId:'rough-in',expectedRevision:1};
  assert.equal((await acceptChangeOrderMilestone(1,auth('customer-1','job-rooms:change-orders:accept'),state,firstInput,f.options)).accepted,true);assert.equal(f.order().status,'partially_accepted');assert.equal(f.order().revision,2);
  assert.equal((await acceptChangeOrderMilestone(1,auth('customer-1','job-rooms:change-orders:accept'),state,firstInput,f.options)).replayed,true);
  f.setAcceptanceReplay(null);assert.equal((await acceptChangeOrderMilestone(1,auth('customer-1','job-rooms:change-orders:accept'),state,{requestKey:'accept-2',jobRoomId:'room-1',changeOrderId:created.value.changeOrderId,milestoneId:'finish',expectedRevision:2},f.options)).accepted,true);assert.equal(f.order().status,'accepted');assert.equal(f.order().revision,3);
});

test('rejects tenant, role, customer, estimate and ordering violations',async()=>{
  assert.equal((await createChangeOrder(1,{...auth('provider-1','job-rooms:change-orders:create'),resourceOrganizationId:'org-2'},state,input,fixture().options)).accepted,false);
  const wrong=fixture();wrong.options.store.getApprovedEstimate=async()=>({estimateId:'estimate-1',organizationId:'org-1',jobRoomId:'room-2',currency:'USD',status:'approved'});assert.equal((await createChangeOrder(1,auth('provider-1','job-rooms:change-orders:create'),state,input,wrong.options)).accepted,false);
  const f=fixture(),created=await createChangeOrder(1,auth('provider-1','job-rooms:change-orders:create'),state,input,f.options);f.setAcceptanceReplay(null);
  assert.equal((await acceptChangeOrderMilestone(1,auth('provider-1','job-rooms:change-orders:accept'),state,{requestKey:'a',jobRoomId:'room-1',changeOrderId:created.value.changeOrderId,milestoneId:'rough-in',expectedRevision:1},f.options)).accepted,false);
  assert.equal((await acceptChangeOrderMilestone(1,auth('customer-1','job-rooms:change-orders:accept'),state,{requestKey:'a',jobRoomId:'room-1',changeOrderId:created.value.changeOrderId,milestoneId:'finish',expectedRevision:1},f.options)).accepted,false);
});

test('rejects malformed milestones, stale revisions and failed dependencies',async()=>{
  assert.equal((await createChangeOrder(1,auth('provider-1','job-rooms:change-orders:create'),state,{...input,milestones:[input.milestones[0],input.milestones[0]]},fixture().options)).accepted,false);
  const failed=fixture();failed.setRejectWrite(true);assert.equal((await createChangeOrder(1,auth('provider-1','job-rooms:change-orders:create'),state,input,failed.options)).accepted,false);
  const f=fixture(),created=await createChangeOrder(1,auth('provider-1','job-rooms:change-orders:create'),state,input,f.options);f.setAcceptanceReplay(null);
  assert.equal((await acceptChangeOrderMilestone(1,auth('customer-1','job-rooms:change-orders:accept'),state,{requestKey:'a',jobRoomId:'room-1',changeOrderId:created.value.changeOrderId,milestoneId:'rough-in',expectedRevision:2},f.options)).accepted,false);
  const audit=fixture();audit.options.audit.sink.append=async()=>{throw Error('down');};assert.equal((await createChangeOrder(1,auth('provider-1','job-rooms:change-orders:create'),state,input,audit.options)).accepted,false);
});
