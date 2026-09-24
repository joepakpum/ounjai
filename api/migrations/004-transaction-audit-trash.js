export async function up(connection) {
  const [columns] = await connection.query(`
    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions'
  `)
  const names = new Set(columns.map((column) => column.COLUMN_NAME))
  if (!names.has('deleted_at')) await connection.query('ALTER TABLE transactions ADD COLUMN deleted_at DATETIME NULL')
  if (!names.has('updated_by_user_id')) {
    await connection.query('ALTER TABLE transactions ADD COLUMN updated_by_user_id BIGINT UNSIGNED NULL')
    await connection.query('ALTER TABLE transactions ADD CONSTRAINT fk_transactions_updated_by FOREIGN KEY (updated_by_user_id) REFERENCES users(id)')
  }
  const [indexes] = await connection.query(`
    SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions'
  `)
  const indexNames = new Set(indexes.map((index) => index.INDEX_NAME))
  if (!indexNames.has('idx_transactions_deleted_personal')) await connection.query('CREATE INDEX idx_transactions_deleted_personal ON transactions (created_by_user_id, deleted_at, occurred_at)')
  if (!indexNames.has('idx_transactions_deleted_family')) await connection.query('CREATE INDEX idx_transactions_deleted_family ON transactions (family_id, deleted_at, occurred_at)')

  await connection.query(`
    CREATE TABLE IF NOT EXISTS transaction_audit_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      transaction_id BIGINT UNSIGNED NOT NULL,
      actor_user_id BIGINT UNSIGNED NOT NULL,
      action ENUM('created', 'updated', 'trashed', 'restored') NOT NULL,
      before_snapshot JSON NULL,
      after_snapshot JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_transaction_audit_history (transaction_id, created_at),
      INDEX idx_transaction_audit_actor (actor_user_id, created_at),
      CONSTRAINT fk_transaction_audit_transaction FOREIGN KEY (transaction_id) REFERENCES transactions(id),
      CONSTRAINT fk_transaction_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `)
}
