import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const migrationPattern = /^(\d{4}_[a-z0-9_]+)\.(up|down)\.sql$/;

export function discoverMigrations(root = process.cwd()) {
  const directory = path.join(root, 'database', 'migrations');
  const discovered = new Map();
  for (const file of fs.readdirSync(directory).sort()) {
    const match = migrationPattern.exec(file);
    if (!match) throw Error('Invalid migration filename: ' + file);
    const [, id, direction] = match;
    const migration = discovered.get(id) ?? {id};
    if (migration[direction]) throw Error('Duplicate ' + direction + ' migration: ' + id);
    migration[direction] = path.join(directory, file);
    discovered.set(id, migration);
  }

  const migrations = [...discovered.values()].sort((left, right) => left.id.localeCompare(right.id));
  if (migrations.length === 0) throw Error('No migrations found');
  for (const migration of migrations) {
    if (!migration.up || !migration.down) throw Error('Migration pair is incomplete: ' + migration.id);
  }
  return migrations;
}

export function runMigrations(direction, options = {}) {
  if (direction !== 'up' && direction !== 'down') throw Error('Direction must be up or down');
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw Error('DATABASE_URL is required');
  const psqlBin = options.psqlBin ?? process.env.PSQL_BIN ?? 'psql';
  const migrations = discoverMigrations(options.root ?? process.cwd());
  const ordered = direction === 'up' ? migrations : migrations.toReversed();

  for (const migration of ordered) {
    const result = spawnSync(
      psqlBin,
      [
        '--dbname', databaseUrl,
        '--no-psqlrc',
        '--set', 'ON_ERROR_STOP=1',
        '--single-transaction',
        '--file', migration[direction],
      ],
      {stdio: 'inherit', env: {...process.env, PGAPPNAME: 'services-marketplace-migrations'}},
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error(direction + ' migration failed: ' + migration.id);
  }
  return ordered.map(migration => migration.id);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const direction = process.argv[2];
  const applied = runMigrations(direction);
  console.log(direction + ' migrations completed: ' + applied.join(', '));
}
