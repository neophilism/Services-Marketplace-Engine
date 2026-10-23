import test from 'node:test';
import assert from 'node:assert/strict';
import {recordExternalPayment} from '../packages/contracts/dist/external-payment-record.js';

const state={organizations:[{organizationId:'org',status:'active'}],memberships:[{subjectId:'customer',organizationId:'org',status:'active',roleIds:['customer']}],roles:[{roleId:'customer',organizationId:'org',permissions:['commerce:external-payments:record']}]};
const auth={subjectId:'customer',organizationId:'org',resourceOrganizationId:'org',requiredPermission:'commerce:external-payments:record'};
const input={requestKey:'request-1',jobRoomId:'room-1',method:'check',externalReference:'check-100',amountMinor:4500,currency:'USD',paidAt:900,evidenceAttachmentId:'evidence-1'};

function fixture(){
  let saved=null,sequence=0;
  const options={store:{
    getRoom:async()=>({organizationId:'org',jobRoomId:'room-1',customerSubjectId:'customer',providerOrganizationId:'provider-org',status:'active'}),
    getReporter:async()=>({organizationId:'org',jobRoomId:'room-1',subjectId:'customer',role:'customer',providerOrganizationId:null,status:'active'}),
    getEvidence:async()=>({organizationId:'org',jobRoomId:'room-1',attachmentId:'evidence-1',status:'clean'}),
    getByRequestKey:async()=>saved,
    createRecord:async value=>{if(saved!==null)return false;saved=value;return true;},
  },audit:{sink:{append:async()=>{}},createOpaqueId:()=>`audit-${++sequence}`,now:()=>1000},now:()=>1000,createOpaqueId:()=>`external-${++sequence}`};
  return{options,saved:()=>saved};
}

test('records and exactly replays customer-reported external payment evidence',async()=>{
  const f=fixture(),first=await recordExternalPayment(1,auth,state,input,f.options);
  assert.equal(first.accepted,true);assert.equal(first.value.reporterRole,'customer');assert.equal(first.value.status,'reported');
  const replay=await recordExternalPayment(1,auth,state,input,f.options);
  assert.equal(replay.accepted,true);assert.equal(replay.replayed,true);assert.equal(replay.value.externalPaymentRecordId,first.value.externalPaymentRecordId);
});

test('accepts only the exact active provider participant',async()=>{
  const f=fixture();
  f.options.store.getReporter=async()=>({organizationId:'org',jobRoomId:'room-1',subjectId:'provider-user',role:'provider',providerOrganizationId:'provider-org',status:'active'});
  const providerState={...state,memberships:[{subjectId:'provider-user',organizationId:'org',status:'active',roleIds:['customer']}]};
  const providerAuth={...auth,subjectId:'provider-user'};
  assert.equal((await recordExternalPayment(1,providerAuth,providerState,input,f.options)).accepted,true);
  const rebound=fixture();rebound.options.store.getReporter=async()=>({organizationId:'org',jobRoomId:'room-1',subjectId:'provider-user',role:'provider',providerOrganizationId:'other-provider',status:'active'});
  assert.equal((await recordExternalPayment(1,providerAuth,providerState,input,rebound.options)).accepted,false);
});

test('rejects tenant, participant, evidence and time rebound',async()=>{
  assert.equal((await recordExternalPayment(1,{...auth,resourceOrganizationId:'other'},state,input,fixture().options)).accepted,false);
  const customer=fixture();customer.options.store.getRoom=async()=>({organizationId:'org',jobRoomId:'room-1',customerSubjectId:'other',providerOrganizationId:'provider-org',status:'active'});
  assert.equal((await recordExternalPayment(1,auth,state,input,customer.options)).accepted,false);
  const evidence=fixture();evidence.options.store.getEvidence=async()=>({organizationId:'org',jobRoomId:'other-room',attachmentId:'evidence-1',status:'clean'});
  assert.equal((await recordExternalPayment(1,auth,state,input,evidence.options)).accepted,false);
  assert.equal((await recordExternalPayment(1,auth,state,{...input,paidAt:1001},fixture().options)).accepted,false);
});

test('fails closed on audit, replay mismatch and persistence failure',async()=>{
  const audit=fixture();audit.options.audit.sink.append=async()=>{throw Error('down')};
  assert.equal((await recordExternalPayment(1,auth,state,input,audit.options)).accepted,false);
  const replay=fixture();await recordExternalPayment(1,auth,state,input,replay.options);
  assert.equal((await recordExternalPayment(1,auth,state,{...input,amountMinor:4501},replay.options)).accepted,false);
  const persistence=fixture();persistence.options.store.createRecord=async()=>false;
  assert.equal((await recordExternalPayment(1,auth,state,input,persistence.options)).accepted,false);
});
