const incomeCategories = [
  ['เงินเดือน', '💼'], ['โบนัส', '🎁'], ['รายได้เสริม', '✨'], ['ดอกเบี้ย', '🏦'], ['เงินคืน', '↩️'], ['อื่น ๆ', '💰'],
]
const expenseCategories = [
  ['อาหาร', '🍜'], ['เดินทาง', '🚗'], ['ของใช้ในบ้าน', '🧺'], ['บ้าน', '🏠'], ['การศึกษา', '📚'], ['สุขภาพ', '🩺'], ['ช้อปปิ้ง', '🛍️'], ['อื่น ๆ', '🧾'],
]

export async function up(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS money_accounts (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      owner_type ENUM('user', 'family') NOT NULL,
      owner_ref BIGINT UNSIGNED NOT NULL,
      owner_user_id BIGINT UNSIGNED NULL,
      family_id BIGINT UNSIGNED NULL,
      name VARCHAR(100) NOT NULL,
      account_type ENUM('cash', 'bank', 'other') NOT NULL,
      opening_balance DECIMAL(14,2) NOT NULL DEFAULT 0,
      opening_date DATE NOT NULL,
      created_by_user_id BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      archived_at DATETIME NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_money_account_owner_name (owner_type, owner_ref, name),
      INDEX idx_money_accounts_user (owner_user_id, archived_at),
      INDEX idx_money_accounts_family (family_id, archived_at),
      CONSTRAINT fk_money_accounts_user FOREIGN KEY (owner_user_id) REFERENCES users(id),
      CONSTRAINT fk_money_accounts_family FOREIGN KEY (family_id) REFERENCES families(id),
      CONSTRAINT fk_money_accounts_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id),
      CONSTRAINT chk_money_accounts_owner CHECK ((owner_type = 'user' AND owner_user_id IS NOT NULL AND family_id IS NULL AND owner_ref = owner_user_id) OR (owner_type = 'family' AND family_id IS NOT NULL AND owner_user_id IS NULL AND owner_ref = family_id))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `)
  await connection.query(`
    CREATE TABLE IF NOT EXISTS transaction_categories (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      owner_type ENUM('user', 'family') NOT NULL,
      owner_ref BIGINT UNSIGNED NOT NULL,
      owner_user_id BIGINT UNSIGNED NULL,
      family_id BIGINT UNSIGNED NULL,
      kind ENUM('income', 'expense') NOT NULL,
      name VARCHAR(80) NOT NULL,
      icon VARCHAR(12) NOT NULL DEFAULT '🧾',
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      created_by_user_id BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      archived_at DATETIME NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_category_owner_kind_name (owner_type, owner_ref, kind, name),
      INDEX idx_categories_user (owner_user_id, kind, archived_at),
      INDEX idx_categories_family (family_id, kind, archived_at),
      CONSTRAINT fk_categories_user FOREIGN KEY (owner_user_id) REFERENCES users(id),
      CONSTRAINT fk_categories_family FOREIGN KEY (family_id) REFERENCES families(id),
      CONSTRAINT fk_categories_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id),
      CONSTRAINT chk_categories_owner CHECK ((owner_type = 'user' AND owner_user_id IS NOT NULL AND family_id IS NULL AND owner_ref = owner_user_id) OR (owner_type = 'family' AND family_id IS NOT NULL AND owner_user_id IS NULL AND owner_ref = family_id))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `)

  const [transactionColumns] = await connection.query(`
    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions'
  `)
  const names = new Set(transactionColumns.map((column) => column.COLUMN_NAME))
  if (!names.has('category_id')) {
    await connection.query('ALTER TABLE transactions ADD COLUMN category_id BIGINT UNSIGNED NULL')
    await connection.query('ALTER TABLE transactions ADD CONSTRAINT fk_transactions_category FOREIGN KEY (category_id) REFERENCES transaction_categories(id)')
  }
  if (!names.has('source_account_id')) {
    await connection.query('ALTER TABLE transactions ADD COLUMN source_account_id BIGINT UNSIGNED NULL')
    await connection.query('ALTER TABLE transactions ADD CONSTRAINT fk_transactions_source_account FOREIGN KEY (source_account_id) REFERENCES money_accounts(id)')
  }
  if (!names.has('destination_account_id')) {
    await connection.query('ALTER TABLE transactions ADD COLUMN destination_account_id BIGINT UNSIGNED NULL')
    await connection.query('ALTER TABLE transactions ADD CONSTRAINT fk_transactions_destination_account FOREIGN KEY (destination_account_id) REFERENCES money_accounts(id)')
  }

  await connection.query(`
    CREATE TABLE IF NOT EXISTS transaction_allocations (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      transaction_id BIGINT UNSIGNED NOT NULL,
      category_id BIGINT UNSIGNED NULL,
      owner_user_id BIGINT UNSIGNED NULL,
      owner_is_family BOOLEAN NOT NULL DEFAULT FALSE,
      amount DECIMAL(14,2) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_allocations_transaction (transaction_id),
      CONSTRAINT fk_allocations_transaction FOREIGN KEY (transaction_id) REFERENCES transactions(id),
      CONSTRAINT fk_allocations_category FOREIGN KEY (category_id) REFERENCES transaction_categories(id),
      CONSTRAINT fk_allocations_owner FOREIGN KEY (owner_user_id) REFERENCES users(id),
      CONSTRAINT chk_allocations_amount CHECK (amount > 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `)

  await connection.query(`
    CREATE TABLE IF NOT EXISTS budgets (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      owner_type ENUM('user', 'family') NOT NULL,
      owner_ref BIGINT UNSIGNED NOT NULL,
      owner_user_id BIGINT UNSIGNED NULL,
      family_id BIGINT UNSIGNED NULL,
      category_id BIGINT UNSIGNED NOT NULL,
      amount DECIMAL(14,2) NOT NULL,
      period_type ENUM('monthly', 'custom') NOT NULL DEFAULT 'monthly',
      cycle_start_day TINYINT UNSIGNED NOT NULL DEFAULT 1,
      period_start DATE NULL,
      period_end DATE NULL,
      alert_percent TINYINT UNSIGNED NOT NULL DEFAULT 80,
      created_by_user_id BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      archived_at DATETIME NULL,
      PRIMARY KEY (id),
      INDEX idx_budgets_user (owner_user_id, archived_at),
      INDEX idx_budgets_family (family_id, archived_at),
      CONSTRAINT fk_budgets_user FOREIGN KEY (owner_user_id) REFERENCES users(id),
      CONSTRAINT fk_budgets_family FOREIGN KEY (family_id) REFERENCES families(id),
      CONSTRAINT fk_budgets_category FOREIGN KEY (category_id) REFERENCES transaction_categories(id),
      CONSTRAINT fk_budgets_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id),
      CONSTRAINT chk_budgets_owner CHECK ((owner_type = 'user' AND owner_user_id IS NOT NULL AND family_id IS NULL AND owner_ref = owner_user_id) OR (owner_type = 'family' AND family_id IS NOT NULL AND owner_user_id IS NULL AND owner_ref = family_id)),
      CONSTRAINT chk_budgets_period CHECK ((period_type = 'monthly' AND cycle_start_day BETWEEN 1 AND 28) OR (period_type = 'custom' AND period_start IS NOT NULL AND period_end >= period_start)),
      CONSTRAINT chk_budgets_amount CHECK (amount > 0),
      CONSTRAINT chk_budgets_alert CHECK (alert_percent BETWEEN 1 AND 100)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `)
  await connection.query(`
    CREATE TABLE IF NOT EXISTS budget_movements (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      owner_type ENUM('user', 'family') NOT NULL,
      owner_ref BIGINT UNSIGNED NOT NULL,
      from_budget_id BIGINT UNSIGNED NOT NULL,
      to_budget_id BIGINT UNSIGNED NOT NULL,
      amount DECIMAL(14,2) NOT NULL,
      moved_by_user_id BIGINT UNSIGNED NOT NULL,
      note VARCHAR(255) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      CONSTRAINT fk_budget_movements_from FOREIGN KEY (from_budget_id) REFERENCES budgets(id),
      CONSTRAINT fk_budget_movements_to FOREIGN KEY (to_budget_id) REFERENCES budgets(id),
      CONSTRAINT fk_budget_movements_user FOREIGN KEY (moved_by_user_id) REFERENCES users(id),
      CONSTRAINT chk_budget_movements_amount CHECK (amount > 0 AND from_budget_id <> to_budget_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `)

  await connection.query(`
    CREATE TABLE IF NOT EXISTS receipt_attachments (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      transaction_id BIGINT UNSIGNED NULL,
      owner_user_id BIGINT UNSIGNED NOT NULL,
      family_id BIGINT UNSIGNED NULL,
      storage_key VARCHAR(128) NOT NULL,
      original_name VARCHAR(255) NOT NULL,
      mime_type VARCHAR(100) NOT NULL,
      size_bytes INT UNSIGNED NOT NULL,
      content_sha256 CHAR(64) NOT NULL,
      processing_status ENUM('uploaded', 'pending_review', 'confirmed', 'failed') NOT NULL DEFAULT 'uploaded',
      extracted_data JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at DATETIME NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_receipt_storage_key (storage_key),
      INDEX idx_receipts_owner (owner_user_id, created_at),
      INDEX idx_receipts_family (family_id, created_at),
      CONSTRAINT fk_receipts_transaction FOREIGN KEY (transaction_id) REFERENCES transactions(id),
      CONSTRAINT fk_receipts_owner FOREIGN KEY (owner_user_id) REFERENCES users(id),
      CONSTRAINT fk_receipts_family FOREIGN KEY (family_id) REFERENCES families(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `)

  await connection.query(`
    CREATE TABLE IF NOT EXISTS recurring_rules (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      owner_type ENUM('user', 'family') NOT NULL,
      owner_ref BIGINT UNSIGNED NOT NULL,
      owner_user_id BIGINT UNSIGNED NULL,
      family_id BIGINT UNSIGNED NULL,
      created_by_user_id BIGINT UNSIGNED NOT NULL,
      kind ENUM('income', 'expense', 'transfer') NOT NULL,
      title VARCHAR(160) NOT NULL,
      category_id BIGINT UNSIGNED NULL,
      amount DECIMAL(14,2) NOT NULL,
      source_account_id BIGINT UNSIGNED NOT NULL,
      destination_account_id BIGINT UNSIGNED NULL,
      owner_name VARCHAR(100) NOT NULL,
      payer_name VARCHAR(100) NULL,
      icon VARCHAR(12) NOT NULL DEFAULT '🧾',
      frequency ENUM('weekly', 'monthly', 'yearly') NOT NULL,
      interval_count TINYINT UNSIGNED NOT NULL DEFAULT 1,
      day_of_month TINYINT UNSIGNED NULL,
      starts_on DATE NOT NULL,
      ends_on DATE NULL,
      paused_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_recurring_due (paused_at, starts_on, ends_on, frequency),
      CONSTRAINT fk_recurring_user FOREIGN KEY (owner_user_id) REFERENCES users(id),
      CONSTRAINT fk_recurring_family FOREIGN KEY (family_id) REFERENCES families(id),
      CONSTRAINT fk_recurring_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id),
      CONSTRAINT fk_recurring_category FOREIGN KEY (category_id) REFERENCES transaction_categories(id),
      CONSTRAINT fk_recurring_source FOREIGN KEY (source_account_id) REFERENCES money_accounts(id),
      CONSTRAINT fk_recurring_destination FOREIGN KEY (destination_account_id) REFERENCES money_accounts(id),
      CONSTRAINT chk_recurring_owner CHECK ((owner_type = 'user' AND owner_user_id IS NOT NULL AND family_id IS NULL AND owner_ref = owner_user_id) OR (owner_type = 'family' AND family_id IS NOT NULL AND owner_user_id IS NULL AND owner_ref = family_id)),
      CONSTRAINT chk_recurring_amount CHECK (amount > 0 AND interval_count > 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `)
  await connection.query(`
    CREATE TABLE IF NOT EXISTS recurring_reviews (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      recurring_rule_id BIGINT UNSIGNED NOT NULL,
      cycle_key VARCHAR(24) NOT NULL,
      review_date DATE NOT NULL,
      payload JSON NOT NULL,
      status ENUM('pending', 'confirmed', 'dismissed') NOT NULL DEFAULT 'pending',
      transaction_id BIGINT UNSIGNED NULL,
      reviewed_by_user_id BIGINT UNSIGNED NULL,
      reviewed_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_recurring_review_cycle (recurring_rule_id, cycle_key),
      INDEX idx_recurring_reviews_pending (status, review_date),
      CONSTRAINT fk_recurring_reviews_rule FOREIGN KEY (recurring_rule_id) REFERENCES recurring_rules(id),
      CONSTRAINT fk_recurring_reviews_transaction FOREIGN KEY (transaction_id) REFERENCES transactions(id),
      CONSTRAINT fk_recurring_reviews_user FOREIGN KEY (reviewed_by_user_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `)

  for (const [kind, categories] of [['income', incomeCategories], ['expense', expenseCategories]]) {
    for (const [name, icon] of categories) {
      await connection.execute(`
        INSERT IGNORE INTO transaction_categories (owner_type, owner_ref, owner_user_id, kind, name, icon, is_default, created_by_user_id)
        SELECT 'user', id, id, ?, ?, ?, TRUE, id FROM users
      `, [kind, name, icon])
      await connection.execute(`
        INSERT IGNORE INTO transaction_categories (owner_type, owner_ref, family_id, kind, name, icon, is_default, created_by_user_id)
        SELECT 'family', f.id, f.id, ?, ?, ?, TRUE, f.created_by_user_id FROM families f
      `, [kind, name, icon])
    }
  }
}
