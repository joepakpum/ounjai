export async function up(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS family_invitations (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      family_id BIGINT UNSIGNED NOT NULL,
      invited_by_user_id BIGINT UNSIGNED NOT NULL,
      token_hash CHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      accepted_at DATETIME NULL,
      accepted_by_user_id BIGINT UNSIGNED NULL,
      revoked_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_family_invitations_token (token_hash),
      INDEX idx_family_invitations_family_state (family_id, accepted_at, revoked_at, expires_at),
      CONSTRAINT fk_family_invitations_family FOREIGN KEY (family_id) REFERENCES families(id),
      CONSTRAINT fk_family_invitations_inviter FOREIGN KEY (invited_by_user_id) REFERENCES users(id),
      CONSTRAINT fk_family_invitations_acceptor FOREIGN KEY (accepted_by_user_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `)
}
