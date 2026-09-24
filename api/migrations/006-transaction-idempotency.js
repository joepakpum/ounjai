export async function up(connection) {
  const [columns] = await connection.query(`
    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions'
  `)
  if (!columns.some((column) => column.COLUMN_NAME === 'client_request_id')) {
    await connection.query('ALTER TABLE transactions ADD COLUMN client_request_id CHAR(36) NULL')
  }
  const [indexes] = await connection.query(`
    SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions'
  `)
  if (!indexes.some((index) => index.INDEX_NAME === 'uq_transactions_creator_request')) {
    await connection.query('CREATE UNIQUE INDEX uq_transactions_creator_request ON transactions (created_by_user_id, client_request_id)')
  }
}
