import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const checkedExtensions = new Set(['.json', '.md', '.mjs', '.sh', '.sql', '.ts', '.yaml', '.yml']);
const ignoredDirectories = new Set(['.git', 'dist', 'node_modules']);

function listFiles(root, relative = '') {
  const directory = path.join(root, relative);
  const files = [];
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) files.push(...listFiles(root, child));
    } else if (checkedExtensions.has(path.extname(entry.name))) {
      files.push(child.split(path.sep).join('/'));
    }
  }
  return files.sort();
}

export function collectStaticViolations(root = process.cwd()) {
  const violations = [];
  const files = listFiles(root);
  for (const relative of files) {
    const content = fs.readFileSync(path.join(root, relative), 'utf8');
    if (content.includes('\r')) violations.push(relative + ': CRLF line endings are not allowed');
    if (content.includes('\t')) violations.push(relative + ': tab characters are not allowed');
    if (content.length > 0 && !content.endsWith('\n')) violations.push(relative + ': missing final newline');
    if (relative.endsWith('.json')) {
      try {
        JSON.parse(content);
      } catch {
        violations.push(relative + ': invalid JSON');
      }
    }
    if (relative.startsWith('packages/contracts/src/')) {
      if (/from\s+['"](?:\.\.\/)*apps\//.test(content) || /@services-marketplace\/(?:api|worker)/.test(content)) {
        violations.push(relative + ': contracts cannot import application adapters');
      }
      if (/\b(?:boat|dock|marine|vessel|yacht)\b/i.test(content)) {
        violations.push(relative + ': contracts must remain industry-neutral');
      }
    }
    if (relative.startsWith('apps/api/src/') && /@services-marketplace\/worker|apps\/worker/.test(content)) {
      violations.push(relative + ': API cannot import the worker adapter');
    }
    if (relative.startsWith('apps/worker/src/') && /@services-marketplace\/api|apps\/api/.test(content)) {
      violations.push(relative + ': worker cannot import the API adapter');
    }
  }

  for (const generated of ['apps/api/dist', 'apps/worker/dist', 'packages/contracts/dist']) {
    if (fs.existsSync(path.join(root, generated))) violations.push(generated + ': generated output must not be committed');
  }
  return {files: files.length, violations};
}

export function checkStatic(root = process.cwd()) {
  const result = collectStaticViolations(root);
  if (result.violations.length > 0) throw Error(result.violations.join('\n'));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkStatic();
  console.log('Static checks passed for ' + result.files + ' first-party files');
}
