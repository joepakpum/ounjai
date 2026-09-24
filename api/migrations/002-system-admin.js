export async function up(connection) {
  const [columns] = await connection.query(`
    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
  `)
  if (!new Set(columns.map((column) => column.COLUMN_NAME)).has('system_role')) {
    await connection.query("ALTER TABLE users ADD COLUMN system_role ENUM('user', 'superadmin') NOT NULL DEFAULT 'user' AFTER password_hash")
  }
}
