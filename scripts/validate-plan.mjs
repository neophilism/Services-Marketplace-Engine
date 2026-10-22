import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const requiredDecisionIds = ['ADR-001', 'ADR-002', 'ADR-003'];

export function validateRegistry(registry) {
  if (
    registry.schemaVersion !== 1 ||
    registry.repository !== 'neophilism/Services-Marketplace-Engine' ||
    !registry.planVerified ||
    registry.plannedPrCount !== registry.units.length ||
    Number.isNaN(Date.parse(registry.observedAt))
  ) {
    throw Error('Invalid registry metadata');
  }

  const ids = new Map(registry.units.map((unit, index) => [unit.id, index]));
  if (ids.size !== registry.units.length) throw Error('Duplicate IDs');

  const claimedPrs = new Map();
  for (const [index, unit] of registry.units.entries()) {
    if (!Array.isArray(unit.prs) || !Array.isArray(unit.dependsOn) || !unit.acceptanceCriteria) {
      throw Error('Invalid unit ' + unit.id);
    }
    for (const dependency of unit.dependsOn) {
      const dependencyIndex = ids.get(dependency);
      if (dependencyIndex === undefined) throw Error('Unknown dependency ' + dependency);
      if (dependencyIndex >= index) throw Error('Dependency must precede ' + unit.id + ': ' + dependency);
    }
    for (const pr of unit.prs) {
      if (!Number.isInteger(pr) || pr <= 0) throw Error('Invalid PR number for ' + unit.id);
      if (claimedPrs.has(pr)) throw Error('PR #' + pr + ' is claimed by multiple units');
      claimedPrs.set(pr, unit.id);
    }
    if (unit.status === 'merged') {
      if (!/^[0-9a-f]{40}$/.test(unit.mergedCommit ?? '')) {
        throw Error('Missing merged commit for ' + unit.id);
      }
      const evidence = Array.isArray(unit.acceptanceEvidence) ? unit.acceptanceEvidence.join(' ') : '';
      for (const pr of unit.prs) {
        const url = `https://github.com/${registry.repository}/pull/${pr}`;
        if (!evidence.includes(url)) throw Error('Missing PR evidence for ' + unit.id);
      }
      if (!/Exact-head/.test(evidence) || !/Merged-main/.test(evidence)) {
        throw Error('Missing exact-head or merged-main evidence for ' + unit.id);
      }
    }
  }

  const pullRequests = Array.isArray(registry.pullRequests) ? registry.pullRequests : [];
  const observedPrs = new Map();
  for (const pr of pullRequests) {
    if (observedPrs.has(pr.number)) throw Error('Duplicate observed PR #' + pr.number);
    observedPrs.set(pr.number, pr);
    if (claimedPrs.get(pr.number) !== pr.unitId) {
      throw Error('Observed PR #' + pr.number + ' does not match a planned unit');
    }
    if (pr.merged && pr.state !== 'closed') throw Error('Merged PR must be closed: #' + pr.number);
  }
  for (const [pr, unitId] of claimedPrs) {
    const observed = observedPrs.get(pr);
    if (!observed) throw Error('Missing observed PR #' + pr);
    const unit = registry.units[ids.get(unitId)];
    if (unit.status === 'merged' && !observed.merged) {
      throw Error('Merged unit has unmerged PR #' + pr);
    }
  }
}

export function validatePlan(root = process.cwd()) {
  const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
  const registry = JSON.parse(read('registry/prs.json'));
  validateRegistry(registry);

  const architecture = JSON.parse(read('architecture/decisions.json'));
  if (architecture.schemaVersion !== 1 || !Array.isArray(architecture.decisions)) {
    throw Error('Invalid architecture registry');
  }
  if (architecture.decisions.map(decision => decision.id).join(',') !== requiredDecisionIds.join(',')) {
    throw Error('Missing required architecture decisions');
  }
  for (const decision of architecture.decisions) {
    if (
      decision.status !== 'accepted' ||
      !Array.isArray(decision.invariants) ||
      decision.invariants.length < 3 ||
      !Array.isArray(decision.negativeTests) ||
      decision.negativeTests.length < 2
    ) {
      throw Error('Incomplete architecture decision ' + decision.id);
    }
    if (!decision.document.startsWith('docs/adr/') || !read(decision.document).includes('# ' + decision.id + ':')) {
      throw Error('Missing architecture document ' + decision.id);
    }
  }
  const authorization = architecture.decisions.find(decision => decision.id === 'ADR-002').negativeTests.join(' ');
  for (const required of ['missing tenant', 'inactive membership', 'cross-tenant', 'missing permission']) {
    if (!authorization.includes(required)) throw Error('Missing authorization-negative case ' + required);
  }
  return {units: registry.units.length, decisions: architecture.decisions.length};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = validatePlan();
  console.log('Validated ' + result.units + ' units and ' + result.decisions + ' architecture decisions');
}
