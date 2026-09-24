CREATE TABLE IF NOT EXISTS transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title VARCHAR(160) NOT NULL,
  category VARCHAR(80) NOT NULL,
  kind ENUM('income', 'expense', 'transfer') NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  scope ENUM('family', 'personal') NOT NULL,
  occurred_at DATETIME NOT NULL,
  source_account VARCHAR(100) NOT NULL,
  destination_account VARCHAR(100) NULL,
  owner_name VARCHAR(100) NOT NULL,
  payer_name VARCHAR(100) NULL,
  recorder_name VARCHAR(100) NOT NULL,
  icon VARCHAR(12) NOT NULL DEFAULT '🧾',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_transactions_scope_date (scope, occurred_at),
  INDEX idx_transactions_kind_date (kind, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

SET NAMES utf8mb4 COLLATE utf8mb4_0900_ai_ci;
