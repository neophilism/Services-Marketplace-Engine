import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const requiredDecisionIds=['ADR-001','ADR-002','ADR-003'];

export function validatePlan(root=process.cwd()){
 const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
 const registry=JSON.parse(read('registry/prs.json'));
 if(registry.schemaVersion!==1||!registry.planVerified||registry.plannedPrCount!==registry.units.length)throw Error('Invalid registry totals');
 const ids=new Set(registry.units.map(unit=>unit.id));
 if(ids.size!==registry.units.length)throw Error('Duplicate IDs');
 for(const unit of registry.units){
  if(!Array.isArray(unit.prs)||!Array.isArray(unit.dependsOn)||!unit.acceptanceCriteria)throw Error('Invalid unit '+unit.id);
  for(const dependency of unit.dependsOn)if(!ids.has(dependency))throw Error('Unknown dependency '+dependency);
 }
 const architecture=JSON.parse(read('architecture/decisions.json'));
 if(architecture.schemaVersion!==1||!Array.isArray(architecture.decisions))throw Error('Invalid architecture registry');
 if(architecture.decisions.map(decision=>decision.id).join(',')!==requiredDecisionIds.join(','))throw Error('Missing required architecture decisions');
 for(const decision of architecture.decisions){
  if(decision.status!=='accepted'||!Array.isArray(decision.invariants)||decision.invariants.length<3||!Array.isArray(decision.negativeTests)||decision.negativeTests.length<2)throw Error('Incomplete architecture decision '+decision.id);
  if(!decision.document.startsWith('docs/adr/')||!read(decision.document).includes('# '+decision.id+':'))throw Error('Missing architecture document '+decision.id);
 }
 const authorization=architecture.decisions.find(decision=>decision.id==='ADR-002').negativeTests.join(' ');
 for(const required of ['missing tenant','inactive membership','cross-tenant','missing permission'])if(!authorization.includes(required))throw Error('Missing authorization-negative case '+required);
 return {units:registry.units.length,decisions:architecture.decisions.length};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const result=validatePlan();
 console.log('Validated '+result.units+' units and '+result.decisions+' architecture decisions');
}
