import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const architecture=JSON.parse(readFileSync('architecture/decisions.json','utf8'));

test('foundation records the required accepted architecture decisions',()=>{
 assert.equal(architecture.schemaVersion,1);
 assert.deepEqual(architecture.decisions.map(decision=>decision.id),['ADR-001','ADR-002','ADR-003']);
 for(const decision of architecture.decisions){
  assert.equal(decision.status,'accepted');
  assert.ok(readFileSync(decision.document,'utf8').includes('# '+decision.id+':'));
  assert.ok(decision.invariants.length>=3);
  assert.ok(decision.negativeTests.length>=2);
 }
});

test('tenant authorization decision fails closed for every boundary case',()=>{
 const authorization=architecture.decisions.find(decision=>decision.id==='ADR-002');
 const cases=authorization.negativeTests.join(' ');
 for(const required of ['missing tenant','inactive membership','cross-tenant','missing permission'])assert.match(cases,new RegExp(required));
 assert.match(authorization.invariants.join(' '),/denied before resource lookup/);
});
