import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateRegistry} from '../scripts/validate-plan.mjs';

const registry = JSON.parse(readFileSync('registry/prs.json', 'utf8'));
const clone = () => structuredClone(registry);

test('canonical registry preserves dependency and PR evidence integrity', () => {
  assert.doesNotThrow(() => validateRegistry(clone()));
});

test('registry rejects forward dependencies', () => {
  const changed = clone();
  changed.units[0].dependsOn = ['SME-002'];
  assert.throws(() => validateRegistry(changed), /Dependency must precede/);
});

test('registry rejects PRs claimed by multiple units', () => {
  const changed = clone();
  changed.units[2].prs = [3];
  assert.throws(() => validateRegistry(changed), /claimed by multiple units/);
});

test('registry rejects merged units without exact-head and merged-main evidence', () => {
  const changed = clone();
  changed.units[1].acceptanceEvidence = [
    'https://github.com/neophilism/Services-Marketplace-Engine/pull/3',
  ];
  assert.throws(() => validateRegistry(changed), /exact-head or merged-main evidence/);
});

test('registry rejects observed PRs assigned to the wrong unit', () => {
  const changed = clone();
  changed.pullRequests[1].unitId = 'SME-003';
  assert.throws(() => validateRegistry(changed), /does not match a planned unit/);
});
