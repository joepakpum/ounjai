import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import argon2 from 'argon2'
import nodemailer from 'nodemailer'
import mysql from 'mysql2/promise'
import { migrate } from './migrate.js'

const port = Number(process.env.PORT || 3000)
const appBaseUrl = process.env.APP_BASE_URL || 'http://localhost:5173'
const cookieName = process.env.COOKIE_SECURE === 'true' ? '__Host-saving_session' : 'saving_session'
const sessionDays = 14
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  database: process.env.MYSQL_DATABASE || 'saving',
  user: process.env.MYSQL_USER || 'saving_app',
  password: process.env.MYSQL_PASSWORD || 'saving-local-app',
  charset: 'utf8mb4', waitForConnections: true, connectionLimit: 10,
  decimalNumbers: true, dateStrings: true, timezone: '+07:00',
})

const authLimits = new Map()
const dummyPasswordHash = await argon2.hash(randomBytes(24).toString('base64url'), { type: argon2.argon2id })
function send(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...extraHeaders,
  })
  response.end(JSON.stringify(payload))
}

async function readJson(request) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    const error = new Error('ต้องส่งข้อมูลในรูปแบบ JSON')
    error.status = 415
    throw error
  }
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 32_000) {
      const error = new Error('Request body is too large')
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch {
    const error = new Error('รูปแบบข้อมูลไม่ถูกต้อง')
    error.status = 400
    throw error
  }
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function readCookie(request, name) {
  const cookies = (request.headers.cookie || '').split(';')
  for (const entry of cookies) {
    const [key, ...parts] = entry.trim().split('=')
    if (key === name) return decodeURIComponent(parts.join('='))
  }
  return null
}

function sessionCookie(value, maxAge = sessionDays * 24 * 60 * 60) {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''
  return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`
}

function checkOrigin(request) {
  const origin = request.headers.origin
  let matches = !origin
  try { if (origin) matches = new URL(origin).origin === new URL(appBaseUrl).origin } catch { matches = false }
  if (!matches) {
    const error = new Error('คำขอมาจากเว็บไซต์ที่ไม่อนุญาต')
    error.status = 403
    throw error
  }
}

function rateLimit(request, response, bucket, maximum = 10) {
  const proxyAddress = request.headers['x-real-ip']
  const address = typeof proxyAddress === 'string' && proxyAddress ? proxyAddress : request.socket.remoteAddress || 'unknown'
  const key = `${bucket}:${address}`
  const now = Date.now()
  if (authLimits.size > 10_000) {
    for (const [entryKey, entry] of authLimits) if (now - entry.startedAt > 15 * 60_000) authLimits.delete(entryKey)
  }
  const entry = authLimits.get(key)
  if (!entry || now - entry.startedAt > 15 * 60_000) {
    authLimits.set(key, { startedAt: now, count: 1 })
    return false
  }
  entry.count += 1
  if (entry.count <= maximum) return false
  send(response, 429, { error: 'ทำรายการบ่อยเกินไป กรุณารอสักครู่แล้วลองอีกครั้ง' }, { 'retry-after': '900' })
  return true
}

function getMailer() {
  const host = process.env.SMTP_HOST
  const from = process.env.SMTP_FROM
  if (!host || !from) return null
  const portNumber = Number(process.env.SMTP_PORT || 587)
  return {
    from,
    transport: nodemailer.createTransport({
      host, port: portNumber, secure: process.env.SMTP_SECURE === 'true' || portNumber === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || '' } : undefined,
      requireTLS: portNumber !== 465,
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
    }),
  }
}

async function sendAccountEmail(email, subject, link, action) {
  const mailer = getMailer()
  if (!mailer) {
    const error = new Error('ยังไม่ได้ตั้งค่า SMTP สำหรับอีเมลยืนยันบัญชี')
    error.status = 503
    throw error
  }
  await mailer.transport.sendMail({
    from: mailer.from, to: email, subject,
    text: `${action}\n\n${link}\n\nลิงก์นี้ใช้ได้ครั้งเดียวและมีเวลาหมดอายุ หากคุณไม่ได้เป็นผู้ทำรายการนี้ ให้เพิกเฉยต่ออีเมลฉบับนี้`,
  })
}

async function issueAccountToken(userId, purpose, lifetimeHours) {
  const token = randomBytes(32).toString('base64url')
  await pool.execute(`
    INSERT INTO account_tokens (user_id, purpose, token_hash, expires_at)
    VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR))
  `, [userId, purpose, digest(token), lifetimeHours])
  return token
}

async function currentUser(request) {
  const token = readCookie(request, cookieName)
  if (!token || !/^[A-Za-z0-9_-]{40,50}$/.test(token)) return null
  const [rows] = await pool.execute(`
    SELECT u.id, u.email, u.display_name, u.system_role
    FROM user_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > UTC_TIMESTAMP() AND u.email_verified_at IS NOT NULL
  `, [digest(token)])
  if (!rows.length) return null
  const [families] = await pool.execute(`
    SELECT f.id, f.name, fm.role
    FROM family_members fm JOIN families f ON f.id = fm.family_id
    WHERE fm.user_id = ? AND fm.left_at IS NULL ORDER BY f.id
  `, [rows[0].id])
  return {
    id: Number(rows[0].id), email: rows[0].email, displayName: rows[0].display_name,
    systemRole: rows[0].system_role,
    families: families.map((family) => ({ id: Number(family.id), name: family.name, role: family.role })),
  }
}

async function syncConfiguredSuperAdmin() {
  const email = String(process.env.SYSTEM_ADMIN_EMAIL || '').trim().toLowerCase()
  if (!email) return
  await pool.execute(`
    UPDATE users SET system_role = CASE
      WHEN LOWER(email) = ? AND email_verified_at IS NOT NULL THEN 'superadmin'
      ELSE 'user'
    END
    WHERE system_role = 'superadmin' OR LOWER(email) = ?
  `, [email, email])
}

async function createSession(userId, response) {
  const token = randomBytes(32).toString('base64url')
  await pool.execute(`
    INSERT INTO user_sessions (id, user_id, expires_at)
    VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY))
  `, [digest(token), userId, sessionDays])
  response.setHeader('set-cookie', sessionCookie(token))
}

function mapTransaction(row) {
  const occurredAt = String(row.occurred_at).replace(' ', 'T') + '+07:00'
  const account = row.kind === 'transfer' ? `${row.source_account} → ${row.destination_account}` : row.source_account
  const date = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(new Date(occurredAt))
  return {
    id: Number(row.id), title: row.title, category: row.category, kind: row.kind,
    amount: Number(row.amount), scope: row.scope, date, account,
    owner: row.owner_name, payer: row.payer_name || undefined,
    recorder: row.recorder_name, icon: row.icon,
  }
}

async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)
  const method = request.method || 'GET'
  const pathname = url.pathname

  if (method === 'GET' && pathname === '/api/health') {
    await pool.query('SELECT 1')
    return send(response, 200, { ok: true, database: 'mysql' })
  }

  if (method !== 'GET' && pathname.startsWith('/api/')) checkOrigin(request)

  if (method === 'POST' && pathname === '/api/auth/register') {
    if (rateLimit(request, response, 'register', 5)) return
    const body = await readJson(request)
    const email = String(body.email || '').trim().toLowerCase()
    const displayName = String(body.displayName || '').trim()
    const password = String(body.password || '')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return send(response, 400, { error: 'กรุณากรอกอีเมลให้ถูกต้อง' })
    if (!displayName || displayName.length > 100) return send(response, 400, { error: 'กรุณากรอกชื่อไม่เกิน 100 ตัวอักษร' })
    if (password.length < 15 || Buffer.byteLength(password, 'utf8') > 128) return send(response, 400, { error: 'รหัสผ่านต้องยาวอย่างน้อย 15 ตัวอักษรและไม่เกิน 128 ไบต์' })
    if (!getMailer()) return send(response, 503, { error: 'ผู้ดูแลระบบยังไม่ได้ตั้งค่าอีเมลสำหรับยืนยันบัญชี' })
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id })
    let userId
    try {
      const [result] = await pool.execute('INSERT INTO users (email, display_name, password_hash) VALUES (?, ?, ?)', [email, displayName, passwordHash])
      userId = result.insertId
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        const [[existing]] = await pool.execute('SELECT id, email_verified_at FROM users WHERE email = ?', [email])
        if (existing && !existing.email_verified_at) {
          await pool.execute("UPDATE account_tokens SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND purpose = 'verify_email' AND used_at IS NULL", [existing.id])
          const token = await issueAccountToken(existing.id, 'verify_email', 24)
          const verificationLink = new URL('/', appBaseUrl)
          verificationLink.searchParams.set('verify', token)
          await sendAccountEmail(email, 'ยืนยันบัญชีอุ่นใจ', verificationLink.href, 'กดลิงก์ด้านล่างเพื่อยืนยันอีเมลและเปิดใช้งานบัญชี')
        }
        return send(response, 202, { message: 'หากอีเมลนี้ยังไม่ได้ยืนยัน ระบบจะส่งลิงก์ยืนยันให้ทางอีเมล' })
      }
      throw error
    }
    const token = await issueAccountToken(userId, 'verify_email', 24)
    const verificationLink = new URL('/', appBaseUrl)
    verificationLink.searchParams.set('verify', token)
    try {
      await sendAccountEmail(email, 'ยืนยันบัญชีอุ่นใจ', verificationLink.href, 'กดลิงก์ด้านล่างเพื่อยืนยันอีเมลและเปิดใช้งานบัญชี')
    } catch (error) {
      await pool.execute('DELETE FROM users WHERE id = ?', [userId])
      throw error
    }
    return send(response, 202, { message: 'ส่งลิงก์ยืนยันบัญชีไปทางอีเมลแล้ว' })
  }

  if (method === 'POST' && pathname === '/api/auth/resend-verification') {
    if (rateLimit(request, response, 'resend-verification', 3)) return
    const body = await readJson(request)
    const email = String(body.email || '').trim().toLowerCase()
    const [users] = email.length <= 254 ? await pool.execute('SELECT id FROM users WHERE email = ? AND email_verified_at IS NULL', [email]) : [[]]
    if (users.length && getMailer()) {
      await pool.execute("UPDATE account_tokens SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND purpose = 'verify_email' AND used_at IS NULL", [users[0].id])
      const token = await issueAccountToken(users[0].id, 'verify_email', 24)
      const verificationLink = new URL('/', appBaseUrl)
      verificationLink.searchParams.set('verify', token)
      await sendAccountEmail(email, 'ยืนยันบัญชีอุ่นใจ', verificationLink.href, 'กดลิงก์ด้านล่างเพื่อยืนยันอีเมลและเปิดใช้งานบัญชี')
    }
    return send(response, 202, { message: 'หากบัญชียังไม่ได้ยืนยัน ระบบจะส่งลิงก์ให้ทางอีเมล' })
  }

  if (method === 'POST' && pathname === '/api/auth/verify-email') {
    const { token = '' } = await readJson(request)
    if (typeof token !== 'string' || token.length > 100) return send(response, 400, { error: 'ลิงก์ยืนยันไม่ถูกต้องหรือหมดอายุแล้ว' })
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const [tokens] = await connection.execute(`
        SELECT id, user_id FROM account_tokens
        WHERE token_hash = ? AND purpose = 'verify_email' AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()
        FOR UPDATE
      `, [digest(token)])
      if (!tokens.length) {
        await connection.rollback()
        return send(response, 400, { error: 'ลิงก์ยืนยันไม่ถูกต้องหรือหมดอายุแล้ว' })
      }
      await connection.execute('UPDATE account_tokens SET used_at = UTC_TIMESTAMP() WHERE id = ?', [tokens[0].id])
      await connection.execute('UPDATE users SET email_verified_at = UTC_TIMESTAMP() WHERE id = ?', [tokens[0].user_id])
      const configuredAdminEmail = String(process.env.SYSTEM_ADMIN_EMAIL || '').trim().toLowerCase()
      if (configuredAdminEmail) {
        await connection.execute(`
          UPDATE users SET system_role = IF(LOWER(email) = ?, 'superadmin', 'user') WHERE id = ?
        `, [configuredAdminEmail, tokens[0].user_id])
      }
      const [families] = await connection.execute('SELECT id FROM families WHERE created_by_user_id = ? LIMIT 1', [tokens[0].user_id])
      let familyId = families[0]?.id
      if (!familyId) {
        const [users] = await connection.execute('SELECT display_name FROM users WHERE id = ?', [tokens[0].user_id])
        const [family] = await connection.execute('INSERT INTO families (name, created_by_user_id) VALUES (?, ?)', [`${users[0].display_name} ของครอบครัว`, tokens[0].user_id])
        familyId = family.insertId
      }
      await connection.execute(`
        INSERT INTO family_members (family_id, user_id, role) VALUES (?, ?, 'owner')
        ON DUPLICATE KEY UPDATE left_at = NULL, role = 'owner'
      `, [familyId, tokens[0].user_id])
      await connection.commit()
      const [users] = await pool.execute('SELECT id FROM users WHERE id = ?', [tokens[0].user_id])
      await createSession(users[0].id, response)
      const user = await currentUser({ headers: { cookie: `${cookieName}=${readCookieValue(response.getHeader('set-cookie'))}` } })
      return send(response, 200, { user })
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  if (method === 'POST' && pathname === '/api/auth/login') {
    if (rateLimit(request, response, 'login', 10)) return
    const body = await readJson(request)
    const email = String(body.email || '').trim().toLowerCase()
    const password = String(body.password || '')
    if (password.length > 128 || email.length > 254) return send(response, 400, { error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' })
    const [users] = await pool.execute('SELECT id, email, display_name, password_hash, email_verified_at FROM users WHERE email = ?', [email])
    const valid = await argon2.verify(users[0]?.password_hash || dummyPasswordHash, password).catch(() => false) && users.length > 0
    if (!valid) return send(response, 401, { error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' })
    if (!users[0].email_verified_at) return send(response, 403, { error: 'กรุณายืนยันอีเมลก่อนเข้าสู่ระบบ' })
    await createSession(users[0].id, response)
    return send(response, 200, { user: await currentUser({ headers: { cookie: `${cookieName}=${readCookieValue(response.getHeader('set-cookie'))}` } }) })
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    const token = readCookie(request, cookieName)
    if (token) await pool.execute('DELETE FROM user_sessions WHERE id = ?', [digest(token)])
    return send(response, 200, { ok: true }, { 'set-cookie': sessionCookie('', 0) })
  }

  if (method === 'GET' && pathname === '/api/auth/me') {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    return send(response, 200, { user })
  }

  if (method === 'POST' && pathname === '/api/auth/forgot-password') {
    if (rateLimit(request, response, 'forgot-password', 3)) return
    const body = await readJson(request)
    const email = String(body.email || '').trim().toLowerCase()
    const [users] = email.length <= 254 ? await pool.execute('SELECT id FROM users WHERE email = ? AND email_verified_at IS NOT NULL', [email]) : [[]]
    if (users.length && getMailer()) {
      await pool.execute("UPDATE account_tokens SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND purpose = 'reset_password' AND used_at IS NULL", [users[0].id])
      const token = await issueAccountToken(users[0].id, 'reset_password', 1)
      const resetLink = new URL('/', appBaseUrl)
      resetLink.searchParams.set('reset', token)
      await sendAccountEmail(email, 'รีเซ็ตรหัสผ่านอุ่นใจ', resetLink.href, 'กดลิงก์ด้านล่างเพื่อตั้งรหัสผ่านใหม่')
    }
    return send(response, 202, { message: 'หากมีบัญชีที่ยืนยันอีเมลแล้ว ระบบจะส่งลิงก์รีเซ็ตรหัสผ่านให้' })
  }

  if (method === 'POST' && pathname === '/api/auth/reset-password') {
    if (rateLimit(request, response, 'reset-password', 5)) return
    const body = await readJson(request)
    const token = String(body.token || '')
    const password = String(body.password || '')
    if (token.length > 100) return send(response, 400, { error: 'ลิงก์รีเซ็ตรหัสผ่านไม่ถูกต้องหรือหมดอายุแล้ว' })
    if (password.length < 15 || Buffer.byteLength(password, 'utf8') > 128) return send(response, 400, { error: 'รหัสผ่านต้องยาวอย่างน้อย 15 ตัวอักษรและไม่เกิน 128 ไบต์' })
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id })
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const [tokens] = await connection.execute(`
        SELECT id, user_id FROM account_tokens
        WHERE token_hash = ? AND purpose = 'reset_password' AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()
        FOR UPDATE
      `, [digest(token)])
      if (!tokens.length) {
        await connection.rollback()
        return send(response, 400, { error: 'ลิงก์รีเซ็ตรหัสผ่านไม่ถูกต้องหรือหมดอายุแล้ว' })
      }
      await connection.execute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, tokens[0].user_id])
      await connection.execute('UPDATE account_tokens SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND purpose = \'reset_password\' AND used_at IS NULL', [tokens[0].user_id])
      await connection.execute('DELETE FROM user_sessions WHERE user_id = ?', [tokens[0].user_id])
      await connection.commit()
      return send(response, 200, { message: 'เปลี่ยนรหัสผ่านแล้ว กรุณาเข้าสู่ระบบอีกครั้ง' }, { 'set-cookie': sessionCookie('', 0) })
    } catch (error) {
      await connection.rollback()
      throw error
    } finally { connection.release() }
  }

  if (method === 'GET' && pathname === '/api/transactions') {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const [rows] = await pool.execute(`
      SELECT t.id, t.title, t.category, t.kind, t.amount, t.scope, t.occurred_at,
             t.source_account, t.destination_account, t.owner_name, t.payer_name,
             u.display_name AS recorder_name, t.icon
      FROM transactions t
      LEFT JOIN users u ON u.id = t.created_by_user_id
      WHERE (t.scope = 'personal' AND t.created_by_user_id = ?)
         OR (t.scope = 'family' AND t.family_id IN (
           SELECT family_id FROM family_members WHERE user_id = ? AND left_at IS NULL
         ))
      ORDER BY t.occurred_at DESC, t.id DESC LIMIT 500
    `, [user.id, user.id])
    return send(response, 200, rows.map(mapTransaction))
  }

  if (method === 'POST' && pathname === '/api/transactions') {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const body = await readJson(request)
    const kind = body.kind
    const scope = body.scope
    const amount = Number(body.amount)
    const title = String(body.title || '').trim()
    const category = String(body.category || '').trim()
    const sourceAccount = String(body.sourceAccount || '').trim()
    const destinationAccount = kind === 'transfer' ? String(body.destinationAccount || '').trim() : null
    const owner = String(body.owner || '').trim()
    const payer = kind === 'expense' ? String(body.payer || '').trim() : null
    const icon = String(body.icon || '🧾').slice(0, 12)
    if (!['income', 'expense', 'transfer'].includes(kind)) return send(response, 400, { error: 'ประเภทรายการไม่ถูกต้อง' })
    if (!['family', 'personal'].includes(scope)) return send(response, 400, { error: 'ขอบเขตรายการไม่ถูกต้อง' })
    if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100) return send(response, 400, { error: 'จำนวนเงินต้องมากกว่าศูนย์และไม่เกินสองตำแหน่งทศนิยม' })
    if (!title || title.length > 160 || !category || category.length > 80 || !sourceAccount || sourceAccount.length > 100) return send(response, 400, { error: 'กรอกข้อมูลรายการให้ครบและอยู่ในความยาวที่กำหนด' })
    if (owner.length > 100 || (payer && payer.length > 100)) return send(response, 400, { error: 'ชื่อผู้เกี่ยวข้องยาวเกินกำหนด' })
    if (kind === 'transfer' && (!destinationAccount || destinationAccount.length > 100 || destinationAccount === sourceAccount)) return send(response, 400, { error: 'เลือกบัญชีต้นทางและปลายทางให้ต่างกัน' })

    let familyId = null
    let permittedNames = [user.displayName]
    if (scope === 'family') {
      const requestedFamilyId = Number(body.familyId)
      const [memberships] = requestedFamilyId
        ? await pool.execute('SELECT family_id FROM family_members WHERE user_id = ? AND family_id = ? AND left_at IS NULL', [user.id, requestedFamilyId])
        : await pool.execute('SELECT family_id FROM family_members WHERE user_id = ? AND left_at IS NULL ORDER BY family_id LIMIT 1', [user.id])
      if (!memberships.length) return send(response, 403, { error: 'คุณไม่มีสิทธิ์บันทึกรายการในครอบครัวนี้' })
      familyId = memberships[0].family_id
      const [members] = await pool.execute(`
        SELECT u.display_name FROM family_members fm JOIN users u ON u.id = fm.user_id
        WHERE fm.family_id = ? AND fm.left_at IS NULL
      `, [familyId])
      permittedNames = [...members.map((member) => member.display_name), 'ครอบครัว']
    }
    if (!permittedNames.includes(owner)) return send(response, 403, { error: 'เจ้าของรายการต้องเป็นสมาชิกที่ยังอยู่ในขอบเขตนี้' })
    if (payer && !permittedNames.includes(payer)) return send(response, 403, { error: 'ผู้จ่ายต้องเป็นสมาชิกที่ยังอยู่ในขอบเขตนี้' })
    const [result] = await pool.execute(`
      INSERT INTO transactions
        (title, category, kind, amount, scope, occurred_at, source_account,
         destination_account, owner_name, payer_name, recorder_name, icon, created_by_user_id, family_id)
      VALUES (?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?)
    `, [title, category, kind, amount, scope, sourceAccount, destinationAccount, owner, payer || null, user.displayName, icon, user.id, familyId])
    const [rows] = await pool.execute(`
      SELECT t.id, t.title, t.category, t.kind, t.amount, t.scope, t.occurred_at,
             t.source_account, t.destination_account, t.owner_name, t.payer_name,
             u.display_name AS recorder_name, t.icon
      FROM transactions t JOIN users u ON u.id = t.created_by_user_id WHERE t.id = ?
    `, [result.insertId])
    return send(response, 201, mapTransaction(rows[0]))
  }

  return send(response, 404, { error: 'ไม่พบเส้นทางนี้' })
}

function readCookieValue(setCookie) {
  return String(setCookie || '').split(';')[0].slice(cookieName.length + 1)
}

const server = http.createServer((request, response) => {
  handle(request, response).catch((error) => {
    if (!response.headersSent) send(response, error.status || 500, { error: error.status ? error.message : 'เกิดข้อผิดพลาดภายในระบบ' })
    else response.end()
    if (!error.status) console.error(error)
  })
})

await migrate(pool)
await syncConfiguredSuperAdmin()
server.listen(port, '0.0.0.0', () => console.log(`saving API listening on ${port}`))

async function shutdown() {
  server.close()
  await pool.end()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
