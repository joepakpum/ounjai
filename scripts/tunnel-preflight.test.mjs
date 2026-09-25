import test from 'node:test'
import assert from 'node:assert/strict'
import { validateTunnelConfig } from './tunnel-preflight.mjs'

const valid = () => ({
  APP_BASE_URL: 'https://ounjai.finance',
  COOKIE_SECURE: 'true',
  MYSQL_PASSWORD: 'app-test-password-0123456789',
  MYSQL_ROOT_PASSWORD: 'root-test-password-9876543210',
  CLOUDFLARE_TUNNEL_TOKEN: 'synthetic-tunnel-token-for-test-only',
  SMTP_HOST: 'smtp.example.test',
  SMTP_PORT: '587',
  SMTP_SECURE: 'false',
  SMTP_FROM: 'Ounjai <noreply@example.test>',
  SYSTEM_ADMIN_EMAIL: 'admin@example.test',
})

test('accepts a complete secure configuration', () => assert.doesNotThrow(() => validateTunnelConfig(valid())))
test('accepts Gmail SMTP with credentials', () => {
  const config = { ...valid(), SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'sender@example.com', SMTP_PASSWORD: 'synthetic-app-password' }
  assert.doesNotThrow(() => validateTunnelConfig(config))
})

for (const [label, mutate] of [
  ['non-HTTPS URL', (config) => { config.APP_BASE_URL = 'http://ounjai.finance' }],
  ['local URL', (config) => { config.APP_BASE_URL = 'https://localhost' }],
  ['reserved placeholder domain', (config) => { config.APP_BASE_URL = 'https://ounjai.example.com' }],
  ['embedded URL credentials', (config) => { config.APP_BASE_URL = 'https://user:pass@ounjai.finance' }],
  ['insecure cookie', (config) => { config.COOKIE_SECURE = 'false' }],
  ['default database password', (config) => { config.MYSQL_PASSWORD = 'saving-local-app' }],
  ['example database placeholder', (config) => { config.MYSQL_PASSWORD = 'replace-with-a-long-random-password' }],
  ['short database password', (config) => { config.MYSQL_PASSWORD = 'short' }],
  ['reused database passwords', (config) => { config.MYSQL_ROOT_PASSWORD = config.MYSQL_PASSWORD }],
  ['missing tunnel token', (config) => { delete config.CLOUDFLARE_TUNNEL_TOKEN }],
  ['missing SMTP configuration', (config) => { delete config.SMTP_HOST }],
  ['unsafe SMTP transport', (config) => { config.SMTP_PORT = '587'; config.SMTP_SECURE = 'true' }],
  ['Gmail without credentials', (config) => { config.SMTP_HOST = 'smtp.gmail.com' }],
  ['missing Super Admin email', (config) => { delete config.SYSTEM_ADMIN_EMAIL }],
]) {
  test(`rejects ${label}`, () => {
    const config = valid()
    mutate(config)
    assert.throws(() => validateTunnelConfig(config))
  })
}
