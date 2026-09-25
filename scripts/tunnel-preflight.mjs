import { isIP } from 'node:net'

const setting = (values, name) => {
  const value = String(values[name] ?? '').trim()
  if (!value || /^\$\{[^}]+\}$/.test(value)) throw new Error(`Set ${name} in .env.`)
  return value
}

export function validateTunnelConfig(values) {
  const baseUrl = setting(values, 'APP_BASE_URL')
  let url
  try { url = new URL(baseUrl) } catch { throw new Error('APP_BASE_URL must be an absolute public HTTPS URL.') }
  if (url.protocol !== 'https:' || !url.hostname.includes('.') || isIP(url.hostname) || url.hostname === 'localhost' || url.username || url.password || url.hostname.split('.').some((label) => ['example', 'test', 'invalid', 'localhost'].includes(label.toLowerCase()))) {
    throw new Error('APP_BASE_URL must be an absolute public HTTPS domain.')
  }

  if (setting(values, 'COOKIE_SECURE').toLowerCase() !== 'true') throw new Error('Set COOKIE_SECURE=true before starting the Tunnel.')
  const appPassword = setting(values, 'MYSQL_PASSWORD')
  const rootPassword = setting(values, 'MYSQL_ROOT_PASSWORD')
  for (const password of [appPassword, rootPassword]) {
    if (Buffer.byteLength(password, 'utf8') < 24 || ['saving-local-app', 'saving-local-root'].includes(password) || password.startsWith('replace-with-')) {
      throw new Error('Replace database defaults with separate passwords of at least 24 bytes.')
    }
  }
  if (appPassword === rootPassword) throw new Error('MYSQL_PASSWORD and MYSQL_ROOT_PASSWORD must be different.')
  setting(values, 'CLOUDFLARE_TUNNEL_TOKEN')
  const smtpHost = setting(values, 'SMTP_HOST').toLowerCase()
  const smtpPort = Number(setting(values, 'SMTP_PORT'))
  const smtpSecure = setting(values, 'SMTP_SECURE').toLowerCase()
  if (![465, 587].includes(smtpPort) || (smtpPort === 465 && smtpSecure !== 'true') || (smtpPort === 587 && smtpSecure !== 'false')) {
    throw new Error('Use SMTP port 465 with SMTP_SECURE=true or port 587 with SMTP_SECURE=false.')
  }
  if (smtpHost === 'smtp.gmail.com') {
    setting(values, 'SMTP_USER')
    setting(values, 'SMTP_PASSWORD')
  }
  setting(values, 'SMTP_FROM')
  const admin = setting(values, 'SYSTEM_ADMIN_EMAIL')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(admin)) throw new Error('SYSTEM_ADMIN_EMAIL must be a valid email address.')
}

if (process.argv[1]?.endsWith('tunnel-preflight.mjs')) {
  try {
    validateTunnelConfig(process.env)
    console.log('Tunnel configuration passed preflight.')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
