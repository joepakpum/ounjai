export async function up(connection) {
  await connection.query(`
    ALTER TABLE transaction_audit_logs
    MODIFY COLUMN action ENUM('created', 'updated', 'trashed', 'restored', 'allocations_updated') NOT NULL
  `)
}
