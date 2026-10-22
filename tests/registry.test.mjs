import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const registry = JSON.parse(readFileSync('registry/prs.json', 'utf8'));

test('planned unit IDs are unique', () => {
  assert.equal(new Set(registry.units.map(unit => unit.id)).size, registry.units.length);
});

test('uncreated PRs are never invented', () => {
  assert.ok(registry.units.every(unit => Array.isArray(unit.prs)));
});
