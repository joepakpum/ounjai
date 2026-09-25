export async function up(connection) {
  const [columns] = await connection.query(`
    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
  `)
  if (!new Set(columns.map((column) => column.COLUMN_NAME)).has('deleted_at')) {
    await connection.query('ALTER TABLE users ADD COLUMN deleted_at DATETIME NULL AFTER email_verified_at')
  }
  const [indexes] = await connection.query(`
    SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
  `)
  if (!new Set(indexes.map((index) => index.INDEX_NAME)).has('idx_users_deleted_at')) {
    await connection.query('CREATE INDEX idx_users_deleted_at ON users (deleted_at)')
  }
}
