import test from 'node:test';
import assert from 'node:assert/strict';
import {recordReconciliationEvent} from '../packages/contracts/dist/commerce-reconciliation.js';

const state={organizations:[{organizationId:'org',status:'active'}],memberships:[{subjectId:'operator',organizationId:'org',status:'active',roleIds:['finance']}],roles:[{roleId:'finance',organizationId:'org',permissions:['commerce:reconciliation:record']}]};
const auth={subjectId:'operator',organizationId:'org',resourceOrganizationId:'org',requiredPermission:'commerce:reconciliation:record'};
const base={sourceType:'scheduled_charge',sourceId:'charge-1'};

function fixture(){
  let reconciliation=null,sequence=0;const entries=new Map();let event={provider:'stripe_connect',eventReference:'refund-1',eventType:'refund_succeeded',relatedEventReference:null,sourceReference:'processor-charge-1',amountMinor:2000,currency:'USD',destinationReference:null,status:'verified'};
  const options={store:{
    getSource:async()=>({organizationId:'org',sourceType:'scheduled_charge',sourceId:'charge-1',jobRoomId:'room-1',customerSubjectId:'customer',providerOrganizationId:'provider',sourceReference:'processor-charge-1',amountMinor:10000,currency:'USD',status:'succeeded'}),
    getReconciliation:async()=>reconciliation,getEntryByRequestKey:async(_o,key)=>entries.get(key)??null,getEntryByEventReference:async(_o,ref)=>[...entries.values()].find(value=>value.eventReference===ref)??null,
    getPayoutDestination:async()=>({organizationId:'org',providerOrganizationId:'provider',destinationReference:'acct-1',status:'active',payoutsEnabled:true}),
    applyEntry:async(before,after,entry)=>{if(before!==reconciliation||entries.has(entry.requestKey))return false;reconciliation=after;entries.set(entry.requestKey,entry);return true;},
  },verifier:{verifyEvent:async()=>event},audit:{sink:{append:async()=>{}},createOpaqueId:()=>`audit-${++sequence}`,now:()=>1000},now:()=>1000,createOpaqueId:()=>`opaque-${++sequence}`};
  return{options,setEvent:value=>{event=value;},current:()=>reconciliation,fail:()=>{options.store.applyEntry=async()=>false;}};
}
const input=(requestKey,eventReference,eventType,expectedRevision)=>({requestKey,...base,eventReference,eventType,expectedRevision});

test('records a bounded refund and exactly replays its immutable result',async()=>{
  const f=fixture(),request=input('request-1','refund-1','refund_succeeded',0);
  const first=await recordReconciliationEvent(1,auth,state,request,f.options);
  assert.equal(first.accepted,true);assert.equal(first.value.refundedMinor,2000);assert.equal(first.value.revision,1);
  const replay=await recordReconciliationEvent(1,auth,state,request,f.options);
  assert.equal(replay.accepted,true);assert.equal(replay.replayed,true);assert.deepEqual(replay.value,first.value);
  assert.equal((await recordReconciliationEvent(1,auth,state,{...request,eventReference:'refund-2'},f.options)).accepted,false);
});

test('fences a dispute and reconciles an exact loss before a bounded payout',async()=>{
  const f=fixture();f.setEvent({provider:'stripe_connect',eventReference:'dispute-1',eventType:'dispute_opened',relatedEventReference:null,sourceReference:'processor-charge-1',amountMinor:3000,currency:'USD',destinationReference:null,status:'verified'});
  assert.equal((await recordReconciliationEvent(1,auth,state,input('request-open','dispute-1','dispute_opened',0),f.options)).accepted,true);
  f.setEvent({provider:'stripe_connect',eventReference:'dispute-loss-1',eventType:'dispute_lost',relatedEventReference:'dispute-1',sourceReference:'processor-charge-1',amountMinor:3000,currency:'USD',destinationReference:null,status:'verified'});
  const lost=await recordReconciliationEvent(1,auth,state,input('request-loss','dispute-loss-1','dispute_lost',1),f.options);
  assert.equal(lost.accepted,true);assert.equal(lost.value.lostMinor,3000);assert.equal(lost.value.disputeStatus,'none');
  f.setEvent({provider:'stripe_connect',eventReference:'payout-1',eventType:'payout_succeeded',relatedEventReference:null,sourceReference:'processor-charge-1',amountMinor:7000,currency:'USD',destinationReference:'acct-1',status:'verified'});
  const paid=await recordReconciliationEvent(1,auth,state,input('request-payout','payout-1','payout_succeeded',2),f.options);
  assert.equal(paid.accepted,true);assert.equal(paid.value.paidOutMinor,7000);assert.equal(paid.value.revision,3);
});

test('rejects stale, overdrawn, contaminated, and unauthorized events',async()=>{
  const over=fixture();over.setEvent({provider:'stripe_connect',eventReference:'refund-1',eventType:'refund_succeeded',relatedEventReference:null,sourceReference:'processor-charge-1',amountMinor:10001,currency:'USD',destinationReference:null,status:'verified'});
  assert.equal((await recordReconciliationEvent(1,auth,state,input('request-1','refund-1','refund_succeeded',0),over.options)).accepted,false);
  const destination=fixture();destination.setEvent({provider:'stripe_connect',eventReference:'payout-1',eventType:'payout_succeeded',relatedEventReference:null,sourceReference:'processor-charge-1',amountMinor:1000,currency:'USD',destinationReference:'other-acct',status:'verified'});
  assert.equal((await recordReconciliationEvent(1,auth,state,input('request-1','payout-1','payout_succeeded',0),destination.options)).accepted,false);
  const rebound=fixture();rebound.options.store.getSource=async()=>({organizationId:'other',sourceType:'scheduled_charge',sourceId:'charge-1',jobRoomId:'room-1',customerSubjectId:'customer',providerOrganizationId:'provider',sourceReference:'processor-charge-1',amountMinor:10000,currency:'USD',status:'succeeded'});
  assert.equal((await recordReconciliationEvent(1,auth,state,input('request-1','refund-1','refund_succeeded',0),rebound.options)).accepted,false);
  assert.equal((await recordReconciliationEvent(1,{...auth,resourceOrganizationId:'other'},state,input('request-1','refund-1','refund_succeeded',0),fixture().options)).accepted,false);
});

test('fails closed on audit, verifier, and atomic persistence failures',async()=>{
  const audit=fixture();audit.options.audit.sink.append=async()=>{throw Error('down');};assert.equal((await recordReconciliationEvent(1,auth,state,input('request-1','refund-1','refund_succeeded',0),audit.options)).accepted,false);
  const verifier=fixture();verifier.options.verifier.verifyEvent=async()=>{throw Error('down');};assert.equal((await recordReconciliationEvent(1,auth,state,input('request-1','refund-1','refund_succeeded',0),verifier.options)).accepted,false);
  const store=fixture();store.fail();assert.equal((await recordReconciliationEvent(1,auth,state,input('request-1','refund-1','refund_succeeded',0),store.options)).accepted,false);assert.equal(store.current(),null);
});
