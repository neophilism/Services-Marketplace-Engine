import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {collectStaticViolations} from '../scripts/check-static.mjs';

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sme-static-'));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, content);
  }
  return root;
}

test('static checks accept clean, industry-neutral workspace sources', t => {
  const root = fixture({
    'packages/contracts/src/index.ts': "export const version = 1;\n",
    'apps/api/src/index.ts': "import {version} from '@services-marketplace/contracts';\n",
    'package.json': '{"private":true}\n',
  });
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  assert.deepEqual(collectStaticViolations(root).violations, []);
});

test('static checks report text hygiene and invalid JSON together', t => {
  const root = fixture({'package.json': '{\r\n\t"private": true\r\n}'});
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const violations = collectStaticViolations(root).violations.join('\n');
  assert.match(violations, /CRLF/);
  assert.match(violations, /tab characters/);
  assert.match(violations, /missing final newline/);
});

test('static checks reject reverse adapter imports and industry terms', t => {
  const root = fixture({
    'packages/contracts/src/index.ts': "import '@services-marketplace/api';\nexport const vessel = true;\n",
    'apps/api/src/index.ts': "import '@services-marketplace/worker';\n",
    'apps/worker/src/index.ts': "import '@services-marketplace/api';\n",
  });
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const violations = collectStaticViolations(root).violations.join('\n');
  assert.match(violations, /contracts cannot import/);
  assert.match(violations, /industry-neutral/);
  assert.match(violations, /API cannot import/);
  assert.match(violations, /worker cannot import/);
});

test('static checks reject committed build output', t => {
  const root = fixture({'apps/api/dist/index.js': 'export {};\n'});
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  assert.match(collectStaticViolations(root).violations.join('\n'), /generated output/);
});
