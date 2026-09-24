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

INSERT INTO transactions
  (title, category, kind, amount, scope, occurred_at, source_account, destination_account, owner_name, payer_name, recorder_name, icon)
VALUES
  ('รับเงินเข้าครอบครัว', 'รายรับครอบครัว', 'income', 68400.00, 'family', '2026-09-24 09:00:00', 'KBank •• 4821', NULL, 'ครอบครัว', NULL, 'คุณ', '💰'),
  ('ซื้อของเข้าบ้าน', 'ของใช้ในบ้าน', 'expense', 1280.00, 'family', '2026-09-24 10:42:00', 'บัตรเครดิต KBank', NULL, 'ครอบครัว', 'คุณ', 'คุณ', '🛒'),
  ('เงินเดือน', 'เงินเดือน', 'income', 42500.00, 'personal', '2026-09-24 09:00:00', 'KBank •• 4821', NULL, 'คุณ', NULL, 'คุณ', '💼'),
  ('ค่าอาหารเย็น', 'อาหาร', 'expense', 860.00, 'family', '2026-09-23 19:30:00', 'เงินสด', NULL, 'ครอบครัว', 'คุณ', 'คุณ', '🍜'),
  ('ค่าเรียนพิเศษ', 'การศึกษา', 'expense', 2500.00, 'family', '2026-09-23 16:15:00', 'SCB •• 1092', NULL, 'น้องมีนา', 'คุณ', 'คุณ', '📚'),
  ('ค่าดูแลบ้าน', 'บ้าน', 'expense', 25700.00, 'family', '2026-09-23 12:00:00', 'KBank •• 4821', NULL, 'ครอบครัว', 'คุณ', 'คุณ', '🏠'),
  ('โอนให้แม่', 'โอนเงิน', 'transfer', 3000.00, 'family', '2026-09-22 13:08:00', 'KBank •• 4821', 'เงินสด', 'ครอบครัว', 'คุณ', 'คุณ', '↗'),
  ('ค่าน้ำค่าไฟ', 'บ้าน', 'expense', 2140.00, 'family', '2026-09-21 08:24:00', 'KBank •• 4821', NULL, 'ครอบครัว', 'คุณ', 'คุณ', '🏠');
