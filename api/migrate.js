import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const migrationsDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

export async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(120) NOT NULL PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.js')).sort()
  for (const file of files) {
    const [[alreadyApplied]] = await pool.execute('SELECT version FROM schema_migrations WHERE version = ?', [file])
    if (alreadyApplied) continue
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const migration = await import(path.join(migrationsDirectory, file))
      await migration.up(connection)
      await connection.execute('INSERT INTO schema_migrations (version) VALUES (?)', [file])
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }
}
