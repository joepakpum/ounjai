export async function up(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      email VARCHAR(254) NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      email_verified_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_users_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `)
  await connection.query(`
    CREATE TABLE IF NOT EXISTS families (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(120) NOT NULL,
      created_by_user_id BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      CONSTRAINT fk_families_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `)
  await connection.query(`
    CREATE TABLE IF NOT EXISTS family_members (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      family_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      role ENUM('owner', 'member') NOT NULL DEFAULT 'member',
      joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      left_at DATETIME NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_family_member (family_id, user_id),
      INDEX idx_family_members_user (user_id, left_at),
      CONSTRAINT fk_family_members_family FOREIGN KEY (family_id) REFERENCES families(id),
      CONSTRAINT fk_family_members_user FOREIGN KEY (user_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `)
  await connection.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      id CHAR(64) NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_user_sessions_expiry (expires_at),
      CONSTRAINT fk_user_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `)
  await connection.query(`
    CREATE TABLE IF NOT EXISTS account_tokens (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      purpose ENUM('verify_email', 'reset_password') NOT NULL,
      token_hash CHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_account_tokens_hash (token_hash),
      INDEX idx_account_tokens_user_purpose (user_id, purpose, used_at),
      CONSTRAINT fk_account_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `)

  const [columns] = await connection.query(`
    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions'
  `)
  const names = new Set(columns.map((column) => column.COLUMN_NAME))
  if (!names.has('created_by_user_id')) {
    await connection.query('ALTER TABLE transactions ADD COLUMN created_by_user_id BIGINT UNSIGNED NULL')
    await connection.query('ALTER TABLE transactions ADD CONSTRAINT fk_transactions_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id)')
  }
  if (!names.has('family_id')) {
    await connection.query('ALTER TABLE transactions ADD COLUMN family_id BIGINT UNSIGNED NULL')
    await connection.query('ALTER TABLE transactions ADD CONSTRAINT fk_transactions_family FOREIGN KEY (family_id) REFERENCES families(id)')
  }
  const [indexes] = await connection.query(`
    SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions'
  `)
  const indexNames = new Set(indexes.map((index) => index.INDEX_NAME))
  if (!indexNames.has('idx_transactions_user_scope_date')) {
    await connection.query('CREATE INDEX idx_transactions_user_scope_date ON transactions (created_by_user_id, scope, occurred_at)')
  }
  if (!indexNames.has('idx_transactions_family_date')) {
    await connection.query('CREATE INDEX idx_transactions_family_date ON transactions (family_id, occurred_at)')
  }
}
