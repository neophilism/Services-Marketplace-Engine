import test from 'node:test';
import assert from 'node:assert/strict';
import {recordFunnelAttributionEvent} from '../packages/contracts/dist/funnel-attribution.js';

const state={organizations:[{organizationId:'org',status:'active'}],memberships:[{
  subjectId:'analyst',organizationId:'org',status:'active',roleIds:['analyst']}],roles:[{
  roleId:'analyst',organizationId:'org',permissions:['analytics:funnel:write']}]};
const auth={subjectId:'analyst',organizationId:'org',resourceOrganizationId:'org',
  requiredPermission:'analytics:funnel:write'};
const input={requestKey:'event-1',crmRecordId:'crm-1',stage:'awareness',
  source:'organic',campaign:null,occurredAt:900,expectedVersion:0};

function fixture(){
  let snapshot=null; const events=new Map(); let sequence=0;
  const relationship={organizationId:'org',crmRecordId:'crm-1',
    providerOrganizationId:'provider-1',status:'active'};
  const options={store:{
    getRelationship:async()=>relationship,
    getOperator:async(_o,p,s)=>({organizationId:'org',providerOrganizationId:p,subjectId:s,
      status:'active',permissions:['analytics:funnel:write']}),
    getSnapshot:async()=>snapshot,
    getEventByRequestKey:async(_o,key)=>events.get(key)??null,
    commit:async(current,mutation)=>{
      if(current!==snapshot||events.has(mutation.event.requestKey))return false;
      snapshot=mutation.snapshot;events.set(mutation.event.requestKey,mutation);return true;
    }},
    audit:{sink:{append:async()=>{}},createOpaqueId:()=>`audit-${++sequence}`,now:()=>1000},
    createOpaqueId:()=>`funnel-${++sequence}`,now:()=>1000};
  return {options,relationship,snapshot:()=>snapshot};
}

test('records immutable first/last-touch attribution and exact replay',async()=>{
  const f=fixture();
  const first=await recordFunnelAttributionEvent(1,auth,state,input,f.options);
  assert.equal(first.accepted,true);assert.equal(first.value.snapshot.version,1);
  assert.deepEqual(first.value.snapshot.firstTouch,{source:'organic',campaign:null});
  assert.equal(Object.isFrozen(first.value.event),true);
  const replay=await recordFunnelAttributionEvent(1,auth,state,input,f.options);
  assert.equal(replay.accepted,true);assert.equal(replay.replayed,true);
  const lead=await recordFunnelAttributionEvent(1,auth,state,{...input,requestKey:'event-2',
    stage:'lead',source:'search',campaign:'fall',occurredAt:950,expectedVersion:1},f.options);
  assert.equal(lead.accepted,true);assert.equal(lead.value.snapshot.eventCount,2);
  assert.deepEqual(lead.value.snapshot.firstTouch,{source:'organic',campaign:null});
  assert.deepEqual(lead.value.snapshot.lastTouch,{source:'search',campaign:'fall'});
});

test('rejects stage regression, stale versions, future events and key contamination',async()=>{
  const f=fixture();
  await recordFunnelAttributionEvent(1,auth,state,{...input,stage:'lead'},f.options);
  assert.equal((await recordFunnelAttributionEvent(1,auth,state,{...input,requestKey:'back',
    stage:'awareness',expectedVersion:1},f.options)).accepted,false);
  assert.equal((await recordFunnelAttributionEvent(1,auth,state,{...input,requestKey:'stale'},f.options)).accepted,false);
  assert.equal((await recordFunnelAttributionEvent(1,auth,state,{...input,requestKey:'future',
    expectedVersion:1,occurredAt:1001},f.options)).accepted,false);
  assert.equal((await recordFunnelAttributionEvent(1,auth,state,{...input,source:'paid'},f.options)).accepted,false);
});

test('rejects cross-tenant relationships and contaminated provider operators',async()=>{
  const tenant=fixture();tenant.relationship.organizationId='other';
  assert.equal((await recordFunnelAttributionEvent(1,auth,state,input,tenant.options)).accepted,false);
  const operator=fixture();operator.options.store.getOperator=async(_o,_p,s)=>({
    organizationId:'org',providerOrganizationId:'provider-2',subjectId:s,status:'active',
    permissions:['analytics:funnel:write']});
  assert.equal((await recordFunnelAttributionEvent(1,auth,state,input,operator.options)).accepted,false);
});

test('fails closed on authorization, audit, identifiers and persistence',async()=>{
  assert.equal((await recordFunnelAttributionEvent(1,{...auth,resourceOrganizationId:'other'},
    state,input,fixture().options)).accepted,false);
  const audit=fixture();audit.options.audit.sink.append=async()=>{throw Error('down')};
  assert.equal((await recordFunnelAttributionEvent(1,auth,state,input,audit.options)).accepted,false);
  assert.equal((await recordFunnelAttributionEvent(1,auth,state,
    {...input,source:'Bad Source'},fixture().options)).accepted,false);
  const ids=fixture();ids.options.createOpaqueId=()=> 'same';
  assert.equal((await recordFunnelAttributionEvent(1,auth,state,input,ids.options)).accepted,false);
  const persistence=fixture();persistence.options.store.commit=async()=>false;
  assert.equal((await recordFunnelAttributionEvent(1,auth,state,input,persistence.options)).accepted,false);
  assert.equal(persistence.snapshot(),null);
});
