import fs from 'node:fs';
const r=JSON.parse(fs.readFileSync('registry/prs.json','utf8'));
if(r.schemaVersion!==1||!r.planVerified||r.plannedPrCount!==r.units.length)throw Error('Invalid registry totals');
const ids=new Set(r.units.map(u=>u.id));if(ids.size!==r.units.length)throw Error('Duplicate IDs');
for(const u of r.units){if(!Array.isArray(u.prs)||!Array.isArray(u.dependsOn)||!u.acceptanceCriteria)throw Error('Invalid unit '+u.id);for(const d of u.dependsOn)if(!ids.has(d))throw Error('Unknown dependency '+d)}
console.log('Validated '+r.units.length+' units');
