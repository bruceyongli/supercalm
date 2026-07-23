function namesFor(db, table) {
  return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((row) => row.name));
}

export function ensureColumn(db, table, name, definition) {
  if (namesFor(db, table).has(name)) return false;
  db.exec(`ALTER TABLE "${table}" ADD COLUMN "${name}" ${definition}`);
  return true;
}

export function ensureMigrationLedger(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at  INTEGER NOT NULL
    )
  `);
}

export function appliedMigrationIds(db) {
  ensureMigrationLedger(db);
  return new Set(db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((row) => row.id));
}

export function applyMigrations(db, migrations, { now = () => Date.now() } = {}) {
  ensureMigrationLedger(db);
  const applied = appliedMigrationIds(db);
  const insert = db.prepare('INSERT INTO schema_migrations (id, description, applied_at) VALUES (?,?,?)');
  const newlyApplied = [];
  for (const migration of migrations) {
    if (!migration?.id || typeof migration.up !== 'function') throw new Error('invalid schema migration');
    if (applied.has(migration.id)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      insert.run(migration.id, migration.description || migration.id, now());
      db.exec('COMMIT');
      applied.add(migration.id);
      newlyApplied.push(migration.id);
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw new Error(`schema migration ${migration.id} failed: ${error?.message || error}`, { cause: error });
    }
  }
  return newlyApplied;
}
