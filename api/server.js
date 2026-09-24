import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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
const execFileAsync = promisify(execFile)
const receiptDirectory = process.env.RECEIPT_STORAGE_PATH || '/var/lib/saving/receipts'
const budgetSpentScopeSql = `((b.owner_type = 'user' AND t.scope = 'personal' AND t.created_by_user_id = b.owner_user_id) OR (b.owner_type = 'family' AND t.scope = 'family' AND t.family_id = b.family_id))`

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

async function readJson(request, maximumBytes = 32_000) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    const error = new Error('ต้องส่งข้อมูลในรูปแบบ JSON')
    error.status = 415
    throw error
  }
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maximumBytes) {
      const error = new Error('ข้อมูลมีขนาดใหญ่เกินกำหนด')
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

function bangkokDateKey(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value)
}

function bangkokDateTimeKey(value) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(value)
  const fields = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  return `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute}:${fields.second}`
}

function localBangkokDateTime(value) {
  const input = String(value)
  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(input)) {
    const instant = new Date(input)
    return Number.isNaN(instant.getTime()) ? '' : bangkokDateTimeKey(instant)
  }
  return input.replace('T', ' ').slice(0, 19)
}

function validDateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value))
  if (!match) return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() + 1 === Number(match[2]) && date.getUTCDate() === Number(match[3])
}

function validLocalDateTime(value) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) || !validDateKey(value.slice(0, 10))) return false
  const [hour, minute, second] = value.slice(11).split(':').map(Number)
  return hour < 24 && minute < 60 && second < 60
}

function recurringReviewDates(rule, todayKey) {
  const startKey = String(rule.starts_on).slice(0, 10)
  if (!validDateKey(startKey) || todayKey < startKey) return []
  const effectiveToday = rule.ends_on && todayKey > String(rule.ends_on).slice(0, 10) ? String(rule.ends_on).slice(0, 10) : todayKey
  if (effectiveToday < startKey) return []
  const [sy, sm, sd] = startKey.split('-').map(Number)
  const [ty, tm, td] = effectiveToday.split('-').map(Number)
  const interval = Math.max(1, Number(rule.interval_count) || 1)
  const dateKey = (date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
  const dates = []
  if (rule.frequency === 'weekly') {
    const start = Date.UTC(sy, sm - 1, sd); const today = Date.UTC(ty, tm - 1, td)
    const last = Math.floor((today - start) / 604800000 / interval)
    for (let i = 0; i <= last && dates.length < 1200; i += 1) dates.push(dateKey(new Date(start + i * interval * 604800000)))
    return dates
  }
  if (rule.frequency === 'monthly') {
    const lastMonth = (ty - sy) * 12 + tm - sm
    for (let months = 0; months <= lastMonth && dates.length < 1200; months += interval) {
      const targetMonth = sm - 1 + months
      const year = sy + Math.floor(targetMonth / 12); const month = targetMonth % 12
      const day = Math.min(Number(rule.day_of_month) || sd, new Date(Date.UTC(year, month + 1, 0)).getUTCDate())
      const due = dateKey(new Date(Date.UTC(year, month, day)))
      if (due >= startKey && due <= effectiveToday) dates.push(due)
    }
    return dates
  }
  const lastYear = ty - sy
  for (let years = 0; years <= lastYear && dates.length < 1200; years += interval) {
    const year = sy + years; const month = sm - 1
    const day = Math.min(sd, new Date(Date.UTC(year, month + 1, 0)).getUTCDate())
    const due = dateKey(new Date(Date.UTC(year, month, day)))
    if (due >= startKey && due <= effectiveToday) dates.push(due)
  }
  return dates
}

async function processRecurringReviews() {
  const today = bangkokDateKey()
  const [rules] = await pool.execute("SELECT * FROM recurring_rules WHERE paused_at IS NULL AND (ends_on IS NULL OR ends_on >= starts_on)")
  for (const rule of rules) {
    const dates = recurringReviewDates(rule, today)
    if (!dates.length) continue
    const [latestRows] = await pool.execute('SELECT MAX(review_date) AS latest_date FROM recurring_reviews WHERE recurring_rule_id = ?', [rule.id])
    const latestDate = latestRows[0]?.latest_date ? String(latestRows[0].latest_date).slice(0, 10) : null
    const dueDates = dates.filter((date) => !latestDate || date > latestDate)
    if (!dueDates.length) continue
    const values = dueDates.map((reviewDate) => {
      const payload = { ruleId: Number(rule.id), kind: rule.kind, title: rule.title, categoryId: rule.category_id == null ? null : Number(rule.category_id), amount: Number(rule.amount), sourceAccountId: Number(rule.source_account_id), destinationAccountId: rule.destination_account_id == null ? null : Number(rule.destination_account_id), owner: rule.owner_name, payer: rule.payer_name, icon: rule.icon, occurredAt: `${reviewDate} 12:00:00` }
      return [rule.id, reviewDate, reviewDate, JSON.stringify(payload)]
    })
    await pool.query('INSERT IGNORE INTO recurring_reviews (recurring_rule_id, cycle_key, review_date, payload) VALUES ?', [values])
  }
}

function receiptSuggestions(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const totalLine = lines.find((line) => /ยอดสุทธิ|ยอดชำระ|รวมทั้งสิ้น|grand total|total/i.test(line))
  const amountCandidates = (totalLine ? [totalLine] : lines).flatMap((line) => [...line.matchAll(/(?:฿|บาท)?\s*(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})/g)].map((match) => Number(`${match[1].replaceAll(',', '')}.${match[2]}`)))
  const amount = amountCandidates.length ? amountCandidates[amountCandidates.length - 1] : null
  const dateMatch = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/)
  let year = dateMatch ? Number(dateMatch[3]) : 0
  if (year > 0 && year < 100) year += 2500
  if (year > 2400) year -= 543
  const date = dateMatch ? `${year}-${String(Number(dateMatch[2])).padStart(2, '0')}-${String(Number(dateMatch[1])).padStart(2, '0')}` : null
  const combined = text.toLowerCase()
  const category = /restaurant|อาหาร|cafe|กาแฟ|food|ข้าว/.test(combined) ? 'อาหาร' : /taxi|grab|เดินทาง|รถไฟ|fuel|น้ำมัน/.test(combined) ? 'เดินทาง' : /pharmacy|hospital|ยา|คลินิก|สุขภาพ/.test(combined) ? 'สุขภาพ' : null
  return { merchant: lines[0]?.slice(0, 160) || null, amount, date, category, rawText: text.slice(0, 8000) }
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
  let matches = false
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
    occurredAt: `${String(row.occurred_at).replace(' ', 'T')}+07:00`,
    categoryId: row.category_id == null ? null : Number(row.category_id),
    sourceAccountId: row.source_account_id == null ? null : Number(row.source_account_id),
    destinationAccountId: row.destination_account_id == null ? null : Number(row.destination_account_id),
    receiptId: row.receipt_id == null ? null : Number(row.receipt_id),
    owner: row.owner_name, payer: row.payer_name || undefined,
    recorder: row.recorder_name, icon: row.icon,
  }
}

function transactionSnapshot(row) {
  if (!row) return null
  return {
    id: Number(row.id), title: row.title, category: row.category, kind: row.kind,
    amount: String(row.amount), scope: row.scope, occurredAt: row.occurred_at,
    sourceAccount: row.source_account, destinationAccount: row.destination_account,
    sourceAccountId: row.source_account_id == null ? null : Number(row.source_account_id),
    destinationAccountId: row.destination_account_id == null ? null : Number(row.destination_account_id),
    owner: row.owner_name, payer: row.payer_name, recorder: row.recorder_name,
    icon: row.icon, createdByUserId: Number(row.created_by_user_id),
    familyId: row.family_id == null ? null : Number(row.family_id),
    deletedAt: row.deleted_at, updatedByUserId: row.updated_by_user_id == null ? null : Number(row.updated_by_user_id),
  }
}

async function mapAuditSnapshotForUser(connection, value, user) {
  if (!value) return null
  const snapshot = typeof value === 'string' ? JSON.parse(value) : { ...value }
  const ids = [...new Set([snapshot.sourceAccountId, snapshot.destinationAccountId].filter(Boolean))]
  if (snapshot.scope === 'family' && ids.length) {
    const [accounts] = await connection.query(`SELECT id, owner_type, owner_user_id FROM money_accounts WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
    const privateIds = new Set(accounts.filter((account) => account.owner_type === 'user' && Number(account.owner_user_id) !== user.id).map((account) => Number(account.id)))
    if (privateIds.has(Number(snapshot.sourceAccountId))) snapshot.sourceAccount = 'บัญชีสมาชิก'
    if (privateIds.has(Number(snapshot.destinationAccountId))) snapshot.destinationAccount = 'บัญชีสมาชิก'
  }
  delete snapshot.sourceAccountId; delete snapshot.destinationAccountId
  delete snapshot.createdByUserId; delete snapshot.familyId; delete snapshot.updatedByUserId
  return snapshot
}

async function maskPrivateAccountReferences(connection, value, user) {
  if (!value) return value
  const record = typeof value === 'string' ? JSON.parse(value) : { ...value }
  const familyId = record.familyId ?? record.family_id
  const isFamilyRecord = record.scope === 'family' || familyId != null
  const sourceIdKey = 'sourceAccountId' in record ? 'sourceAccountId' : 'source_account_id'
  const destinationIdKey = 'destinationAccountId' in record ? 'destinationAccountId' : 'destination_account_id'
  const ids = [...new Set([record[sourceIdKey], record[destinationIdKey]].filter((id) => id != null).map(Number))]
  if (!isFamilyRecord || !ids.length) return record
  const [accounts] = await connection.query(`SELECT id, owner_type, owner_user_id FROM money_accounts WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
  const privateIds = new Set(accounts.filter((account) => account.owner_type === 'user' && Number(account.owner_user_id) !== user.id).map((account) => Number(account.id)))
  for (const [idKey, nameKey] of [[sourceIdKey, 'sourceAccount' in record ? 'sourceAccount' : 'source_account'], [destinationIdKey, 'destinationAccount' in record ? 'destinationAccount' : 'destination_account']]) {
    if (privateIds.has(Number(record[idKey]))) {
      record[idKey] = null
      if (nameKey in record) record[nameKey] = 'บัญชีสมาชิก'
    }
  }
  return record
}

async function getTransactionRecord(connection, id, lock = false) {
  const [rows] = await connection.execute(`
    SELECT t.*, u.display_name AS recorder_name FROM transactions t
    LEFT JOIN users u ON u.id = t.created_by_user_id WHERE t.id = ? ${lock ? 'FOR UPDATE' : ''}
  `, [id])
  return rows[0] || null
}

async function mapTransactionForUser(connection, row, user) {
  if (!row) return null
  if (row.receipt_id == null) {
    const [receipts] = await connection.execute('SELECT id FROM receipt_attachments WHERE transaction_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', [row.id])
    row = { ...row, receipt_id: receipts[0]?.id ?? null }
  }
  if (row.scope !== 'family') return mapTransaction(row)
  const sourceId = row.kind === 'income' ? row.destination_account_id : row.source_account_id
  const destinationId = row.destination_account_id
  let sourceName = row.source_account
  let destinationName = row.destination_account
  let sourceAccountId = row.source_account_id
  let destinationAccountId = row.destination_account_id
  const accountIds = [...new Set([sourceId, destinationId].filter(Boolean))]
  if (accountIds.length) {
    const [accounts] = await connection.query(`SELECT id, owner_type, owner_user_id FROM money_accounts WHERE id IN (${accountIds.map(() => '?').join(',')})`, accountIds)
    const accountByKey = new Map(accounts.map((account) => [Number(account.id), account]))
    const source = sourceId ? accountByKey.get(Number(sourceId)) : null
    const destination = destinationId ? accountByKey.get(Number(destinationId)) : null
    if (source?.owner_type === 'user' && Number(source.owner_user_id) !== user.id) {
      sourceName = 'บัญชีสมาชิก'
      if (row.kind === 'income') destinationAccountId = null
      else sourceAccountId = null
    }
    if (destination?.owner_type === 'user' && Number(destination.owner_user_id) !== user.id) {
      destinationName = 'บัญชีสมาชิก'
      destinationAccountId = null
    }
  }
  return mapTransaction({ ...row, source_account: sourceName, destination_account: destinationName, source_account_id: sourceAccountId, destination_account_id: destinationAccountId })
}

function canManageTransaction(user, row) {
  if (row.scope === 'personal') return Number(row.created_by_user_id) === user.id
  const membership = user.families.find((family) => family.id === Number(row.family_id))
  return Boolean(membership && (membership.role === 'owner' || Number(row.created_by_user_id) === user.id))
}

function canManageRecurringRule(user, rule) {
  if (rule.owner_type === 'user') return Number(rule.created_by_user_id) === user.id
  const membership = user.families.find((family) => family.id === Number(rule.family_id))
  return Boolean(membership && (membership.role === 'owner' || Number(rule.created_by_user_id) === user.id))
}

async function auditTransaction(connection, transactionId, userId, action, before, after) {
  await connection.execute(`
    INSERT INTO transaction_audit_logs (transaction_id, actor_user_id, action, before_snapshot, after_snapshot)
    VALUES (?, ?, ?, ?, ?)
  `, [transactionId, userId, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null])
}

async function ensureDefaultAccounts(user) {
  await pool.execute(`
    INSERT IGNORE INTO money_accounts (owner_type, owner_ref, owner_user_id, name, account_type, opening_date, created_by_user_id)
    VALUES ('user', ?, ?, 'เงินสด', 'cash', CURDATE(), ?)
  `, [user.id, user.id, user.id])
  for (const family of user.families) {
    await pool.execute(`
      INSERT IGNORE INTO money_accounts (owner_type, owner_ref, family_id, name, account_type, opening_date, created_by_user_id)
      VALUES ('family', ?, ?, 'เงินสดครอบครัว', 'cash', CURDATE(), ?)
    `, [family.id, family.id, user.id])
  }
}

async function ensureDefaultCategories(user) {
  const defaults = {
    income: [['เงินเดือน', '💼'], ['โบนัส', '🎁'], ['รายได้เสริม', '✨'], ['ดอกเบี้ย', '🏦'], ['เงินคืน', '↩️'], ['อื่น ๆ', '💰']],
    expense: [['อาหาร', '🍜'], ['เดินทาง', '🚗'], ['ของใช้ในบ้าน', '🧺'], ['บ้าน', '🏠'], ['การศึกษา', '📚'], ['สุขภาพ', '🩺'], ['ช้อปปิ้ง', '🛍️'], ['อื่น ๆ', '🧾']],
  }
  for (const [kind, items] of Object.entries(defaults)) for (const [name, icon] of items) {
    await pool.execute(`INSERT IGNORE INTO transaction_categories (owner_type, owner_ref, owner_user_id, kind, name, icon, is_default, created_by_user_id) VALUES ('user', ?, ?, ?, ?, ?, TRUE, ?)`, [user.id, user.id, kind, name, icon, user.id])
    for (const family of user.families) await pool.execute(`INSERT IGNORE INTO transaction_categories (owner_type, owner_ref, family_id, kind, name, icon, is_default, created_by_user_id) VALUES ('family', ?, ?, ?, ?, ?, TRUE, ?)`, [family.id, family.id, kind, name, icon, user.id])
  }
}

async function accountById(connection, accountId) {
  const [rows] = await connection.execute('SELECT * FROM money_accounts WHERE id = ? AND archived_at IS NULL', [accountId])
  return rows[0] || null
}

async function accountVisibleToUser(user, account, scope, familyId, purpose = 'source', kind = 'expense') {
  if (!account || account.archived_at) return false
  if (scope === 'personal') return account.owner_type === 'user' && Number(account.owner_user_id) === user.id
  if (account.owner_type === 'family') return Number(account.family_id) === Number(familyId) && user.families.some((family) => family.id === Number(familyId))
  if (account.owner_type !== 'user') return false
  if (Number(account.owner_user_id) === user.id) return true
  if (purpose !== 'destination' || kind !== 'transfer' || !user.families.some((family) => family.id === Number(familyId))) return false
  const [membership] = await pool.execute('SELECT 1 FROM family_members WHERE family_id = ? AND user_id = ? AND left_at IS NULL', [familyId, account.owner_user_id])
  return membership.length > 0
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
    const inviteToken = typeof body.inviteToken === 'string' ? body.inviteToken : ''
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
          if (inviteToken) verificationLink.searchParams.set('invite', inviteToken)
          await sendAccountEmail(email, 'ยืนยันบัญชีอุ่นใจ', verificationLink.href, 'กดลิงก์ด้านล่างเพื่อยืนยันอีเมลและเปิดใช้งานบัญชี')
        }
        return send(response, 202, { message: 'หากอีเมลนี้ยังไม่ได้ยืนยัน ระบบจะส่งลิงก์ยืนยันให้ทางอีเมล' })
      }
      throw error
    }
    const token = await issueAccountToken(userId, 'verify_email', 24)
    const verificationLink = new URL('/', appBaseUrl)
    verificationLink.searchParams.set('verify', token)
    if (inviteToken) verificationLink.searchParams.set('invite', inviteToken)
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
    const { token = '', inviteToken = '' } = await readJson(request)
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
      let invitation = null
      if (inviteToken) {
        if (typeof inviteToken !== 'string' || inviteToken.length > 100) {
          await connection.rollback()
          return send(response, 400, { error: 'ลิงก์เชิญไม่ถูกต้องหรือหมดอายุแล้ว' })
        }
        const [invitations] = await connection.execute(`
          SELECT id, family_id FROM family_invitations
          WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()
          FOR UPDATE
        `, [digest(inviteToken)])
        if (!invitations.length) {
          await connection.rollback()
          return send(response, 400, { error: 'ลิงก์เชิญไม่ถูกต้องหรือหมดอายุแล้ว' })
        }
        invitation = invitations[0]
      }
      await connection.execute('UPDATE account_tokens SET used_at = UTC_TIMESTAMP() WHERE id = ?', [tokens[0].id])
      await connection.execute('UPDATE users SET email_verified_at = UTC_TIMESTAMP() WHERE id = ?', [tokens[0].user_id])
      const configuredAdminEmail = String(process.env.SYSTEM_ADMIN_EMAIL || '').trim().toLowerCase()
      if (configuredAdminEmail) {
        await connection.execute(`
          UPDATE users SET system_role = IF(LOWER(email) = ?, 'superadmin', 'user') WHERE id = ?
        `, [configuredAdminEmail, tokens[0].user_id])
      }
      if (invitation) {
        await connection.execute(`
          INSERT INTO family_members (family_id, user_id, role) VALUES (?, ?, 'member')
          ON DUPLICATE KEY UPDATE left_at = NULL, role = 'member', joined_at = CURRENT_TIMESTAMP
        `, [invitation.family_id, tokens[0].user_id])
        await connection.execute('UPDATE family_invitations SET accepted_at = UTC_TIMESTAMP(), accepted_by_user_id = ? WHERE id = ?', [tokens[0].user_id, invitation.id])
      } else {
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
      }
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

  if (method === 'GET' && pathname === '/api/account/export') {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const familyIds = user.families.map((family) => family.id)
    const familyPlaceholders = familyIds.length ? familyIds.map(() => '?').join(',') : 'NULL'
    const familyParams = familyIds
    const [[profile]] = await pool.execute('SELECT id, email, display_name, email_verified_at, created_at FROM users WHERE id = ?', [user.id])
    const [memberships] = await pool.execute(`
      SELECT f.id AS family_id, f.name, fm.role, fm.joined_at, fm.left_at
      FROM family_members fm JOIN families f ON f.id = fm.family_id
      WHERE fm.user_id = ? ORDER BY fm.joined_at, fm.id
    `, [user.id])
    const [accounts] = await pool.execute(`
      SELECT a.id, a.owner_type, a.owner_ref, a.owner_user_id, a.family_id, a.name, a.account_type,
        a.opening_balance, a.opening_date, a.archived_at, a.created_by_user_id, a.created_at,
        a.opening_balance + COALESCE(SUM(CASE
          WHEN t.kind = 'income' AND t.destination_account_id = a.id THEN t.amount
          WHEN t.kind = 'expense' AND t.source_account_id = a.id THEN -t.amount
          WHEN t.kind = 'transfer' AND t.source_account_id = a.id THEN -t.amount
          WHEN t.kind = 'transfer' AND t.destination_account_id = a.id THEN t.amount
          ELSE 0 END), 0) AS balance
      FROM money_accounts a LEFT JOIN transactions t ON (t.source_account_id = a.id OR t.destination_account_id = a.id)
        AND t.deleted_at IS NULL AND DATE(t.occurred_at) >= a.opening_date
      WHERE (a.owner_type = 'user' AND a.owner_user_id = ?) OR (a.owner_type = 'family' AND a.family_id IN (${familyPlaceholders}))
      GROUP BY a.id ORDER BY a.owner_type, a.name
    `, [user.id, ...familyParams])
    const [categories] = await pool.execute(`
      SELECT id, owner_type, owner_ref, owner_user_id, family_id, kind, name, icon, is_default, archived_at, created_by_user_id, created_at
      FROM transaction_categories
      WHERE (owner_type = 'user' AND owner_user_id = ?) OR (owner_type = 'family' AND family_id IN (${familyPlaceholders}))
      ORDER BY owner_type, kind, name
    `, [user.id, ...familyParams])
    const [budgets] = await pool.execute(`
      SELECT b.id, b.owner_type, b.owner_ref, b.owner_user_id, b.family_id, b.category_id, c.name AS category,
        b.amount, b.period_type, b.cycle_start_day, b.period_start, b.period_end, b.alert_percent,
        b.archived_at, b.created_by_user_id, b.created_at
      FROM budgets b JOIN transaction_categories c ON c.id = b.category_id
      WHERE (b.owner_type = 'user' AND b.owner_user_id = ?) OR (b.owner_type = 'family' AND b.family_id IN (${familyPlaceholders}))
      ORDER BY b.created_at, b.id
    `, [user.id, ...familyParams])
    const [budgetMovements] = await pool.execute(`
      SELECT bm.id, bm.owner_type, bm.owner_ref, bm.from_budget_id, bm.to_budget_id,
        c1.name AS from_category, c2.name AS to_category, bm.amount, bm.note, bm.moved_by_user_id,
        bm.created_at, u.display_name AS moved_by
      FROM budget_movements bm JOIN budgets b1 ON b1.id = bm.from_budget_id JOIN budgets b2 ON b2.id = bm.to_budget_id
      JOIN transaction_categories c1 ON c1.id = b1.category_id JOIN transaction_categories c2 ON c2.id = b2.category_id
      JOIN users u ON u.id = bm.moved_by_user_id
      WHERE (bm.owner_type = 'user' AND bm.owner_ref = ?) OR (bm.owner_type = 'family' AND bm.owner_ref IN (${familyPlaceholders}))
      ORDER BY bm.created_at, bm.id
    `, [user.id, ...familyParams])
    const transactionWhere = `(t.scope = 'personal' AND t.created_by_user_id = ?) OR (t.scope = 'family' AND t.family_id IN (${familyPlaceholders}) AND EXISTS (SELECT 1 FROM family_members export_member WHERE export_member.family_id = t.family_id AND export_member.user_id = ? AND export_member.left_at IS NULL))`
    const transactionParams = [user.id, ...familyParams, user.id]
    const [transactions] = await pool.execute(`
      SELECT t.id, t.title, COALESCE(c.name, t.category) AS category, t.category_id, t.kind, t.amount, t.scope,
        t.family_id, t.created_by_user_id, t.updated_by_user_id, t.category_id,
        CASE WHEN t.scope = 'family' AND sa.owner_type = 'user' AND sa.owner_user_id <> ? THEN NULL ELSE t.source_account_id END AS source_account_id,
        CASE WHEN t.scope = 'family' AND da.owner_type = 'user' AND da.owner_user_id <> ? THEN NULL ELSE t.destination_account_id END AS destination_account_id,
        t.occurred_at, t.created_at, t.updated_at, t.deleted_at,
        CASE WHEN sa.owner_type = 'user' AND sa.owner_user_id <> ? THEN 'บัญชีสมาชิก' ELSE COALESCE(sa.name, t.source_account) END AS source_account,
        CASE WHEN da.owner_type = 'user' AND da.owner_user_id <> ? THEN 'บัญชีสมาชิก' ELSE COALESCE(da.name, t.destination_account) END AS destination_account,
        t.owner_name, t.payer_name, recorder.display_name AS recorder_name, updater.display_name AS updated_by, t.icon
      FROM transactions t
      LEFT JOIN transaction_categories c ON c.id = t.category_id
      LEFT JOIN money_accounts sa ON sa.id = t.source_account_id
      LEFT JOIN money_accounts da ON da.id = t.destination_account_id
      LEFT JOIN users recorder ON recorder.id = t.created_by_user_id
      LEFT JOIN users updater ON updater.id = t.updated_by_user_id
      WHERE ${transactionWhere} ORDER BY t.occurred_at, t.id
    `, [user.id, user.id, user.id, user.id, ...transactionParams])
    const [allocations] = await pool.execute(`
      SELECT a.id, a.transaction_id, a.category_id, c.name AS category, a.owner_user_id, a.owner_is_family, u.display_name AS owner_name, a.amount
      FROM transaction_allocations a JOIN transactions t ON t.id = a.transaction_id
      LEFT JOIN transaction_categories c ON c.id = a.category_id LEFT JOIN users u ON u.id = a.owner_user_id
      WHERE ${transactionWhere} ORDER BY a.transaction_id, a.id
    `, transactionParams)
    const [history] = await pool.execute(`
      SELECT al.id, al.transaction_id, al.actor_user_id, al.action, al.before_snapshot, al.after_snapshot, al.created_at, actor.display_name AS actor
      FROM transaction_audit_logs al JOIN transactions t ON t.id = al.transaction_id
      JOIN users actor ON actor.id = al.actor_user_id
      WHERE ${transactionWhere} ORDER BY al.transaction_id, al.created_at, al.id
    `, transactionParams)
    const [recurringRules] = await pool.execute(`
      SELECT r.id, r.owner_type, r.owner_ref, r.owner_user_id, r.family_id, r.created_by_user_id, r.kind, r.title,
        r.category_id, c.name AS category, r.amount, r.source_account_id, r.destination_account_id,
        r.owner_name, r.payer_name, r.frequency, r.interval_count, r.day_of_month,
        r.starts_on, r.ends_on, r.paused_at, r.created_at
      FROM recurring_rules r LEFT JOIN transaction_categories c ON c.id = r.category_id
      WHERE (r.owner_type = 'user' AND r.owner_user_id = ?) OR (r.owner_type = 'family' AND r.family_id IN (${familyPlaceholders}))
      ORDER BY r.created_at, r.id
    `, [user.id, ...familyParams])
    const [recurringReviews] = await pool.execute(`
      SELECT rr.recurring_rule_id, rr.cycle_key, rr.review_date, rr.payload, rr.status, rr.reviewed_at,
        r.owner_type, r.family_id,
        rr.created_at, reviewer.display_name AS reviewed_by
      FROM recurring_reviews rr JOIN recurring_rules r ON r.id = rr.recurring_rule_id
      LEFT JOIN users reviewer ON reviewer.id = rr.reviewed_by_user_id
      WHERE (r.owner_type = 'user' AND r.owner_user_id = ?) OR (r.owner_type = 'family' AND r.family_id IN (${familyPlaceholders}))
      ORDER BY rr.review_date, rr.id
    `, [user.id, ...familyParams])
    const [receipts] = await pool.execute(`
      SELECT id, transaction_id, family_id, original_name, mime_type, size_bytes, content_sha256,
        processing_status, extracted_data, created_at, deleted_at, CONCAT('/api/receipts/', id, '/content') AS download_path
      FROM receipt_attachments
      WHERE (family_id IS NULL AND owner_user_id = ?) OR family_id IN (${familyPlaceholders})
      ORDER BY created_at, id
    `, [user.id, ...familyParams])
    const safeHistory = await Promise.all(history.map(async (entry) => ({
      ...entry,
      before_snapshot: await mapAuditSnapshotForUser(pool, entry.before_snapshot, user),
      after_snapshot: await mapAuditSnapshotForUser(pool, entry.after_snapshot, user),
    })))
    const safeRecurringRules = await Promise.all(recurringRules.map((rule) => maskPrivateAccountReferences(pool, rule, user)))
    const safeRecurringReviews = await Promise.all(recurringReviews.map(async (review) => {
      const payload = typeof review.payload === 'string' ? JSON.parse(review.payload) : { ...review.payload }
      payload.scope = review.owner_type === 'family' ? 'family' : 'personal'
      payload.familyId = review.family_id == null ? null : Number(review.family_id)
      return { ...review, payload: await maskPrivateAccountReferences(pool, payload, user) }
    }))
    const exportData = {
      format: 'ounjai-account-export-v1', generatedAt: new Date().toISOString(),
      profile: { id: Number(profile.id), email: profile.email, displayName: profile.display_name, emailVerifiedAt: profile.email_verified_at, createdAt: profile.created_at },
      memberships, accounts: accounts.map((account) => ({ ...account, id: Number(account.id), ownerUserId: account.owner_user_id == null ? null : Number(account.owner_user_id), familyId: account.family_id == null ? null : Number(account.family_id), openingBalance: Number(account.opening_balance), balance: Number(account.balance) })),
      categories, budgets, budgetMovements, transactions, allocations, history: safeHistory,
      recurringRules: safeRecurringRules, recurringReviews: safeRecurringReviews, receipts,
    }
    const date = bangkokDateKey()
    return send(response, 200, exportData, { 'content-disposition': `attachment; filename="ounjai-data-export-${date}.json"` })
  }

  if (method === 'GET' && pathname === '/api/families') {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const families = []
    for (const family of user.families) {
      const [members] = await pool.execute(`
        SELECT u.id, u.display_name, u.email, fm.role, fm.joined_at
        FROM family_members fm JOIN users u ON u.id = fm.user_id
        WHERE fm.family_id = ? AND fm.left_at IS NULL ORDER BY FIELD(fm.role, 'owner', 'member'), fm.joined_at
      `, [family.id])
      const pending = family.role === 'owner' ? await pool.execute(`
        SELECT id, expires_at, created_at FROM family_invitations
        WHERE family_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()
        ORDER BY created_at DESC
      `, [family.id]) : [[]]
      families.push({ ...family, members: members.map((member) => ({ id: Number(member.id), displayName: member.display_name, email: member.email, role: member.role, joinedAt: member.joined_at })), invitations: pending[0].map((invite) => ({ id: Number(invite.id), expiresAt: invite.expires_at })) })
    }
    return send(response, 200, families)
  }

  if (method === 'POST' && pathname === '/api/families/invitations/accept') {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const { token = '' } = await readJson(request)
    if (typeof token !== 'string' || token.length > 100) return send(response, 400, { error: 'ลิงก์เชิญไม่ถูกต้องหรือหมดอายุแล้ว' })
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const [invitations] = await connection.execute(`
        SELECT id, family_id FROM family_invitations
        WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()
        FOR UPDATE
      `, [digest(token)])
      if (!invitations.length) { await connection.rollback(); return send(response, 400, { error: 'ลิงก์เชิญถูกใช้แล้ว ถูกยกเลิก หรือหมดอายุแล้ว' }) }
      const invite = invitations[0]
      const [existing] = await connection.execute('SELECT left_at FROM family_members WHERE family_id = ? AND user_id = ? FOR UPDATE', [invite.family_id, user.id])
      if (existing.length && existing[0].left_at === null) { await connection.rollback(); return send(response, 409, { error: 'คุณเป็นสมาชิกครอบครัวนี้อยู่แล้ว' }) }
      await connection.execute(`
        INSERT INTO family_members (family_id, user_id, role) VALUES (?, ?, 'member')
        ON DUPLICATE KEY UPDATE left_at = NULL, role = 'member', joined_at = CURRENT_TIMESTAMP
      `, [invite.family_id, user.id])
      await connection.execute('UPDATE family_invitations SET accepted_at = UTC_TIMESTAMP(), accepted_by_user_id = ? WHERE id = ?', [user.id, invite.id])
      await connection.commit()
      return send(response, 200, { user: await currentUser(request), message: 'เข้าร่วมครอบครัวแล้ว' })
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
  }

  const familyRoute = pathname.match(/^\/api\/families\/(\d+)(?:\/(invitations(?:\/(\d+))?|leave))?$/)
  if (familyRoute && method !== 'GET') {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const familyId = Number(familyRoute[1])
    const action = familyRoute[2]?.startsWith('invitations') ? 'invitations' : familyRoute[2]
    const membership = user.families.find((family) => family.id === familyId)
    if (!membership) return send(response, 403, { error: 'คุณไม่มีสิทธิ์จัดการครอบครัวนี้' })
    if (action === 'invitations' && method === 'POST') {
      if (membership.role !== 'owner') return send(response, 403, { error: 'เฉพาะเจ้าของครอบครัวเท่านั้นที่เชิญสมาชิกได้' })
      const token = randomBytes(32).toString('base64url')
      const [result] = await pool.execute(`INSERT INTO family_invitations (family_id, invited_by_user_id, token_hash, expires_at) VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 DAY))`, [familyId, user.id, digest(token)])
      const link = new URL('/', appBaseUrl); link.searchParams.set('invite', token)
      return send(response, 201, { id: Number(result.insertId), link: link.href, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() })
    }
    if (action === 'invitations' && method === 'DELETE' && familyRoute[3]) {
      if (membership.role !== 'owner') return send(response, 403, { error: 'เฉพาะเจ้าของครอบครัวเท่านั้นที่ยกเลิกคำเชิญได้' })
      const [result] = await pool.execute(`UPDATE family_invitations SET revoked_at = UTC_TIMESTAMP() WHERE id = ? AND family_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`, [Number(familyRoute[3]), familyId])
      return result.affectedRows ? send(response, 200, { ok: true }) : send(response, 404, { error: 'ไม่พบคำเชิญที่ยังใช้งานได้' })
    }
    if (action === 'leave' && method === 'POST') {
      if (membership.role === 'owner') return send(response, 409, { error: 'เจ้าของครอบครัวยังออกไม่ได้ กรุณาโอนสิทธิ์เจ้าของก่อน' })
      await pool.execute('UPDATE family_members SET left_at = UTC_TIMESTAMP() WHERE family_id = ? AND user_id = ? AND left_at IS NULL', [familyId, user.id])
      return send(response, 200, { ok: true })
    }
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

  if (pathname === '/api/accounts' && method === 'GET') {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    await ensureDefaultAccounts(user)
    const scope = url.searchParams.get('scope') === 'family' ? 'family' : 'personal'
    const requestedFamily = Number(url.searchParams.get('familyId'))
    const familyId = requestedFamily || user.families[0]?.id || 0
    if (scope === 'family' && !user.families.some((family) => family.id === familyId)) return send(response, 403, { error: 'คุณไม่มีสิทธิ์ดูบัญชีเงินครอบครัวนี้' })
    const ownerFilter = scope === 'personal' ? 'a.owner_type = \'user\' AND a.owner_user_id = ?' : 'a.owner_type = \'family\' AND a.family_id = ?'
    const ownerId = scope === 'personal' ? user.id : familyId
    const [accounts] = await pool.execute(`
      SELECT a.id, a.owner_type, a.owner_user_id, a.family_id, a.name, a.account_type,
        a.opening_balance, a.opening_date,
        a.opening_balance + COALESCE(SUM(CASE
          WHEN t.kind = 'income' AND t.destination_account_id = a.id THEN t.amount
          WHEN t.kind = 'expense' AND t.source_account_id = a.id THEN -t.amount
          WHEN t.kind = 'transfer' AND t.source_account_id = a.id THEN -t.amount
          WHEN t.kind = 'transfer' AND t.destination_account_id = a.id THEN t.amount
          ELSE 0 END), 0) AS balance
      FROM money_accounts a LEFT JOIN transactions t ON (t.source_account_id = a.id OR t.destination_account_id = a.id)
        AND t.deleted_at IS NULL AND DATE(t.occurred_at) >= a.opening_date
      WHERE ${ownerFilter} AND a.archived_at IS NULL
      GROUP BY a.id ORDER BY a.account_type, a.name
    `, [ownerId])
    return send(response, 200, accounts.map((account) => ({ id: Number(account.id), ownerType: account.owner_type, ownerUserId: account.owner_user_id ? Number(account.owner_user_id) : null, familyId: account.family_id ? Number(account.family_id) : null, name: account.name, accountType: account.account_type, openingBalance: Number(account.opening_balance), openingDate: account.opening_date, balance: Number(account.balance) })))
  }

  const transferRecipientsRoute = pathname.match(/^\/api\/families\/(\d+)\/transfer-recipients$/)
  if (method === 'GET' && transferRecipientsRoute) {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const familyId = Number(transferRecipientsRoute[1])
    if (!user.families.some((family) => family.id === familyId)) return send(response, 403, { error: 'คุณไม่มีสิทธิ์ดูสมาชิกครอบครัวนี้' })
    const [accounts] = await pool.execute(`
      SELECT a.id, a.owner_user_id, u.display_name, a.account_type
      FROM money_accounts a JOIN family_members fm ON fm.user_id = a.owner_user_id AND fm.family_id = ? AND fm.left_at IS NULL
      JOIN users u ON u.id = a.owner_user_id
      WHERE a.owner_type = 'user' AND a.archived_at IS NULL AND a.owner_user_id <> ?
      ORDER BY u.display_name, a.account_type, a.id
    `, [familyId, user.id])
    return send(response, 200, accounts.map((account) => ({ id: Number(account.id), ownerName: account.display_name, accountType: account.account_type })))
  }

  if (pathname === '/api/accounts' && method === 'POST') {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const body = await readJson(request)
    const scope = body.scope
    const familyId = Number(body.familyId)
    const name = String(body.name || '').trim()
    const accountType = body.accountType
    const openingBalance = Number(body.openingBalance || 0)
    const openingDate = String(body.openingDate || bangkokDateKey())
    if (!['personal', 'family'].includes(scope) || !name || name.length > 100 || !['cash', 'bank', 'other'].includes(accountType)) return send(response, 400, { error: 'กรอกชื่อ ขอบเขต และประเภทบัญชีให้ถูกต้อง' })
    if (!Number.isFinite(openingBalance) || Math.round(openingBalance * 100) !== openingBalance * 100 || !validDateKey(openingDate)) return send(response, 400, { error: 'ยอดตั้งต้นหรือวันที่ไม่ถูกต้อง' })
    let ownerType = 'user'; let ownerRef = user.id; let ownerUserId = user.id; let family = null
    if (scope === 'family') {
      family = user.families.find((item) => item.id === familyId)
      if (!family) return send(response, 403, { error: 'คุณไม่มีสิทธิ์สร้างบัญชีในครอบครัวนี้' })
      if (family.role !== 'owner') return send(response, 403, { error: 'เฉพาะเจ้าของครอบครัวจัดการบัญชีเงินครอบครัวได้' })
      ownerType = 'family'; ownerRef = familyId; ownerUserId = null
    }
    try {
      const [result] = await pool.execute(`
        INSERT INTO money_accounts (owner_type, owner_ref, owner_user_id, family_id, name, account_type, opening_balance, opening_date, created_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [ownerType, ownerRef, ownerUserId, scope === 'family' ? familyId : null, name, accountType, openingBalance, openingDate, user.id])
      return send(response, 201, { id: Number(result.insertId), ownerType, ownerUserId, familyId: scope === 'family' ? familyId : null, name, accountType, openingBalance, openingDate, balance: openingBalance })
    } catch (error) { if (error.code === 'ER_DUP_ENTRY') return send(response, 409, { error: 'มีบัญชีชื่อนี้อยู่แล้ว' }); throw error }
  }

  const accountRoute = pathname.match(/^\/api\/accounts\/(\d+)$/)
  if (accountRoute && ['PATCH', 'DELETE'].includes(method)) {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const account = await accountById(pool, Number(accountRoute[1]))
    if (!account) return send(response, 404, { error: 'ไม่พบบัญชีเงิน' })
    const allowed = account.owner_type === 'user' && Number(account.owner_user_id) === user.id
      || account.owner_type === 'family' && user.families.some((family) => family.id === Number(account.family_id) && family.role === 'owner')
    if (!allowed) return send(response, 403, { error: 'คุณไม่มีสิทธิ์จัดการบัญชีเงินนี้' })
    if (method === 'DELETE') {
      await pool.execute('UPDATE money_accounts SET archived_at = UTC_TIMESTAMP() WHERE id = ?', [account.id])
      return send(response, 200, { ok: true })
    }
    const body = await readJson(request)
    const name = body.name === undefined ? account.name : String(body.name).trim()
    const accountType = body.accountType === undefined ? account.account_type : body.accountType
    const openingBalance = body.openingBalance === undefined ? Number(account.opening_balance) : Number(body.openingBalance)
    const openingDate = body.openingDate === undefined ? account.opening_date : String(body.openingDate)
    if (!name || name.length > 100 || !['cash', 'bank', 'other'].includes(accountType) || !Number.isFinite(openingBalance) || Math.round(openingBalance * 100) !== openingBalance * 100 || !validDateKey(openingDate)) return send(response, 400, { error: 'ข้อมูลบัญชีเงินไม่ถูกต้อง' })
    try {
      await pool.execute('UPDATE money_accounts SET name = ?, account_type = ?, opening_balance = ?, opening_date = ? WHERE id = ?', [name, accountType, openingBalance, openingDate, account.id])
      return send(response, 200, { id: Number(account.id), name, accountType, openingBalance, openingDate })
    } catch (error) { if (error.code === 'ER_DUP_ENTRY') return send(response, 409, { error: 'มีบัญชีชื่อนี้อยู่แล้ว' }); throw error }
  }

  if (pathname === '/api/categories' && method === 'GET') {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    await ensureDefaultCategories(user)
    const kind = url.searchParams.get('kind')
    if (kind && !['income', 'expense'].includes(kind)) return send(response, 400, { error: 'ประเภทหมวดหมู่ไม่ถูกต้อง' })
    const scope = url.searchParams.get('scope') === 'family' ? 'family' : 'personal'
    const requestedFamily = Number(url.searchParams.get('familyId'))
    const familyId = requestedFamily || user.families[0]?.id || 0
    if (scope === 'family' && !user.families.some((family) => family.id === familyId)) return send(response, 403, { error: 'คุณไม่มีสิทธิ์ดูหมวดหมู่ครอบครัวนี้' })
    const [categories] = await pool.execute(`
      SELECT id, owner_type, owner_ref, kind, name, icon, is_default FROM transaction_categories
      WHERE owner_type = ? AND owner_ref = ? AND archived_at IS NULL ${kind ? 'AND kind = ?' : ''}
      ORDER BY kind, is_default DESC, name
    `, [scope === 'family' ? 'family' : 'user', scope === 'family' ? familyId : user.id, ...(kind ? [kind] : [])])
    return send(response, 200, categories.map((category) => ({ id: Number(category.id), ownerType: category.owner_type, ownerRef: Number(category.owner_ref), kind: category.kind, name: category.name, icon: category.icon, isDefault: Boolean(category.is_default) })))
  }

  if (pathname === '/api/categories' && method === 'POST') {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const body = await readJson(request)
    const scope = body.scope
    const familyId = Number(body.familyId)
    const kind = body.kind
    const name = String(body.name || '').trim()
    const icon = String(body.icon || '🧾').slice(0, 12)
    if (!['personal', 'family'].includes(scope) || !['income', 'expense'].includes(kind) || !name || name.length > 80) return send(response, 400, { error: 'ข้อมูลหมวดหมู่ไม่ถูกต้อง' })
    let ownerType = 'user'; let ownerRef = user.id; let ownerUserId = user.id
    if (scope === 'family') {
      const family = user.families.find((item) => item.id === familyId)
      if (!family || family.role !== 'owner') return send(response, 403, { error: 'เฉพาะเจ้าของครอบครัวจัดการหมวดหมู่ครอบครัวได้' })
      ownerType = 'family'; ownerRef = familyId; ownerUserId = null
    }
    try {
      const [result] = await pool.execute(`INSERT INTO transaction_categories (owner_type, owner_ref, owner_user_id, family_id, kind, name, icon, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [ownerType, ownerRef, ownerUserId, scope === 'family' ? familyId : null, kind, name, icon, user.id])
      return send(response, 201, { id: Number(result.insertId), kind, name, icon, isDefault: false })
    } catch (error) { if (error.code === 'ER_DUP_ENTRY') return send(response, 409, { error: 'มีหมวดหมู่นี้อยู่แล้ว' }); throw error }
  }

  if (pathname === '/api/budgets' && method === 'GET') {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const scope = url.searchParams.get('scope') === 'family' ? 'family' : 'personal'
    const familyId = Number(url.searchParams.get('familyId')) || user.families[0]?.id || 0
    if (scope === 'family' && !user.families.some((family) => family.id === familyId)) return send(response, 403, { error: 'คุณไม่มีสิทธิ์ดูงบครอบครัวนี้' })
    const ownerRef = scope === 'family' ? familyId : user.id
    const budgetSpentPeriod = `((b.period_type = 'monthly' AND DATE(t.occurred_at) >= CASE
      WHEN DAY(CURDATE()) >= b.cycle_start_day THEN DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL b.cycle_start_day - 1 DAY)
      ELSE DATE_ADD(DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01'), INTERVAL b.cycle_start_day - 1 DAY) END
      AND DATE(t.occurred_at) < CASE WHEN DAY(CURDATE()) >= b.cycle_start_day
      THEN DATE_ADD(DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL b.cycle_start_day - 1 DAY), INTERVAL 1 MONTH)
      ELSE DATE_ADD(DATE_ADD(DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01'), INTERVAL b.cycle_start_day - 1 DAY), INTERVAL 1 MONTH) END)
      OR (b.period_type = 'custom' AND DATE(t.occurred_at) BETWEEN b.period_start AND b.period_end))`
    const budgetSpentScope = budgetSpentScopeSql
    const [rows] = await pool.execute(`
      SELECT b.id, b.owner_type, b.owner_ref, b.category_id,
        b.amount + COALESCE((SELECT SUM(CASE WHEN bm.to_budget_id = b.id THEN bm.amount WHEN bm.from_budget_id = b.id THEN -bm.amount ELSE 0 END) FROM budget_movements bm WHERE bm.to_budget_id = b.id OR bm.from_budget_id = b.id), 0) AS amount,
        b.period_type, b.cycle_start_day,
        b.period_start, b.period_end, b.alert_percent, c.name AS category_name, c.icon,
        COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.category_id = b.category_id AND t.kind = 'expense' AND t.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM transaction_allocations a WHERE a.transaction_id = t.id)
          AND ${budgetSpentPeriod} AND ${budgetSpentScope}), 0)
        + COALESCE((SELECT SUM(a.amount) FROM transaction_allocations a JOIN transactions t ON t.id = a.transaction_id
          WHERE a.category_id = b.category_id AND t.kind = 'expense' AND t.deleted_at IS NULL
          AND ${budgetSpentPeriod} AND ${budgetSpentScope}), 0) AS spent
      FROM budgets b JOIN transaction_categories c ON c.id = b.category_id
      WHERE b.owner_type = ? AND b.owner_ref = ? AND b.archived_at IS NULL
      ORDER BY c.name
    `, [scope === 'family' ? 'family' : 'user', ownerRef])
    return send(response, 200, rows.map((row) => ({ id: Number(row.id), ownerType: row.owner_type, ownerRef: Number(row.owner_ref), categoryId: Number(row.category_id), category: row.category_name, icon: row.icon, amount: Number(row.amount), spent: Number(row.spent), periodType: row.period_type, cycleStartDay: Number(row.cycle_start_day), periodStart: row.period_start, periodEnd: row.period_end, alertPercent: Number(row.alert_percent) })))
  }

  if (pathname === '/api/budgets' && method === 'POST') {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const body = await readJson(request)
    const scope = body.scope
    const familyId = Number(body.familyId)
    const categoryId = Number(body.categoryId)
    const amount = Number(body.amount)
    const periodType = body.periodType === 'custom' ? 'custom' : 'monthly'
    const cycleStartDay = Number(body.cycleStartDay || 1)
    const periodStart = body.periodStart ? String(body.periodStart) : null
    const periodEnd = body.periodEnd ? String(body.periodEnd) : null
    const alertPercent = Number(body.alertPercent || 80)
    if (!['personal', 'family'].includes(scope) || !Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100 || !Number.isInteger(alertPercent) || alertPercent < 1 || alertPercent > 100) return send(response, 400, { error: 'ข้อมูลวงเงินหรือการแจ้งเตือนไม่ถูกต้อง' })
    let ownerType = 'user'; let ownerRef = user.id; let ownerUserId = user.id
    if (scope === 'family') {
      const family = user.families.find((item) => item.id === familyId)
      if (!family || family.role !== 'owner') return send(response, 403, { error: 'เฉพาะเจ้าของครอบครัวจัดการงบครอบครัวได้' })
      ownerType = 'family'; ownerRef = familyId; ownerUserId = null
    }
    if (periodType === 'monthly' && (!Number.isInteger(cycleStartDay) || cycleStartDay < 1 || cycleStartDay > 28)) return send(response, 400, { error: 'วันเริ่มรอบต้องอยู่ระหว่างวันที่ 1 ถึง 28' })
    if (periodType === 'custom' && (!validDateKey(periodStart) || !validDateKey(periodEnd) || periodEnd < periodStart)) return send(response, 400, { error: 'กรุณากำหนดวันเริ่มและวันสิ้นสุดให้ถูกต้อง' })
    const [categories] = await pool.execute('SELECT id FROM transaction_categories WHERE id = ? AND owner_type = ? AND owner_ref = ? AND kind = \'expense\' AND archived_at IS NULL', [categoryId, ownerType, ownerRef])
    if (!categories.length) return send(response, 400, { error: 'เลือกหมวดรายจ่ายในขอบเขตเดียวกัน' })
    const [result] = await pool.execute(`INSERT INTO budgets (owner_type, owner_ref, owner_user_id, family_id, category_id, amount, period_type, cycle_start_day, period_start, period_end, alert_percent, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [ownerType, ownerRef, ownerUserId, scope === 'family' ? familyId : null, categoryId, amount, periodType, cycleStartDay, periodStart, periodEnd, alertPercent, user.id])
    return send(response, 201, { id: Number(result.insertId) })
  }

  if (pathname === '/api/budgets/movements' && method === 'POST') {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const body = await readJson(request)
    const fromId = Number(body.fromBudgetId); const toId = Number(body.toBudgetId); const amount = Number(body.amount)
    if (!fromId || !toId || fromId === toId || !Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100) return send(response, 400, { error: 'ระบุงบต้นทาง ปลายทาง และจำนวนเงินให้ถูกต้อง' })
    const connection = await pool.getConnection()
    try {
    await connection.beginTransaction()
    const [budgets] = await connection.execute('SELECT * FROM budgets WHERE id IN (?, ?) AND archived_at IS NULL ORDER BY id FOR UPDATE', [fromId, toId])
    const from = budgets.find((budget) => Number(budget.id) === fromId); const to = budgets.find((budget) => Number(budget.id) === toId)
    if (!from || !to || from.owner_type !== to.owner_type || Number(from.owner_ref) !== Number(to.owner_ref)) { await connection.rollback(); return send(response, 400, { error: 'ย้ายได้ระหว่างงบในขอบเขตเดียวกันเท่านั้น' }) }
    const allowed = from.owner_type === 'user' && Number(from.owner_user_id) === user.id || from.owner_type === 'family' && user.families.some((family) => family.id === Number(from.family_id) && family.role === 'owner')
    if (!allowed) { await connection.rollback(); return send(response, 403, { error: 'คุณไม่มีสิทธิ์ย้ายงบนี้' }) }
    const [[balance]] = await connection.execute(`
      SELECT b.amount + COALESCE((SELECT SUM(CASE WHEN bm.to_budget_id = b.id THEN bm.amount WHEN bm.from_budget_id = b.id THEN -bm.amount ELSE 0 END) FROM budget_movements bm WHERE bm.to_budget_id = b.id OR bm.from_budget_id = b.id), 0)
        - COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.category_id = b.category_id AND t.kind = 'expense' AND t.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM transaction_allocations a WHERE a.transaction_id = t.id)
          AND ((b.period_type = 'monthly' AND DATE(t.occurred_at) >= CASE WHEN DAY(CURDATE()) >= b.cycle_start_day THEN DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL b.cycle_start_day - 1 DAY) ELSE DATE_ADD(DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01'), INTERVAL b.cycle_start_day - 1 DAY) END
            AND DATE(t.occurred_at) < CASE WHEN DAY(CURDATE()) >= b.cycle_start_day THEN DATE_ADD(DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL b.cycle_start_day - 1 DAY), INTERVAL 1 MONTH) ELSE DATE_ADD(DATE_ADD(DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01'), INTERVAL b.cycle_start_day - 1 DAY), INTERVAL 1 MONTH) END)
            OR (b.period_type = 'custom' AND DATE(t.occurred_at) BETWEEN b.period_start AND b.period_end))
          AND ${budgetSpentScopeSql}), 0)
        - COALESCE((SELECT SUM(a.amount) FROM transaction_allocations a JOIN transactions t ON t.id = a.transaction_id WHERE a.category_id = b.category_id AND t.kind = 'expense' AND t.deleted_at IS NULL
          AND ((b.period_type = 'monthly' AND DATE(t.occurred_at) >= CASE WHEN DAY(CURDATE()) >= b.cycle_start_day THEN DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL b.cycle_start_day - 1 DAY) ELSE DATE_ADD(DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01'), INTERVAL b.cycle_start_day - 1 DAY) END
            AND DATE(t.occurred_at) < CASE WHEN DAY(CURDATE()) >= b.cycle_start_day THEN DATE_ADD(DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL b.cycle_start_day - 1 DAY), INTERVAL 1 MONTH) ELSE DATE_ADD(DATE_ADD(DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01'), INTERVAL b.cycle_start_day - 1 DAY), INTERVAL 1 MONTH) END)
            OR (b.period_type = 'custom' AND DATE(t.occurred_at) BETWEEN b.period_start AND b.period_end))
          AND ${budgetSpentScopeSql}), 0) AS available
      FROM budgets b WHERE b.id = ?
    `, [fromId])
    if (Number(balance.available) < amount) { await connection.rollback(); return send(response, 409, { error: 'วงเงินคงเหลือหลังหักรายจ่ายไม่พอสำหรับย้าย' }) }
    await connection.execute('INSERT INTO budget_movements (owner_type, owner_ref, from_budget_id, to_budget_id, amount, moved_by_user_id, note) VALUES (?, ?, ?, ?, ?, ?, ?)', [from.owner_type, from.owner_ref, fromId, toId, amount, user.id, String(body.note || '').slice(0, 255) || null])
    await connection.commit()
    return send(response, 201, { ok: true })
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
  }

  if (pathname === '/api/budgets/movements' && method === 'GET') {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const scope = url.searchParams.get('scope') === 'family' ? 'family' : 'personal'
    const familyId = Number(url.searchParams.get('familyId')) || user.families[0]?.id || 0
    if (scope === 'family' && !user.families.some((family) => family.id === familyId)) return send(response, 403, { error: 'คุณไม่มีสิทธิ์ดูประวัติย้ายงบนี้' })
    const [rows] = await pool.execute(`
      SELECT bm.id, bm.amount, bm.note, bm.created_at, c1.name AS from_category, c2.name AS to_category, u.display_name AS moved_by
      FROM budget_movements bm JOIN budgets b ON b.id = bm.from_budget_id
      JOIN budgets b2 ON b2.id = bm.to_budget_id
      JOIN transaction_categories c1 ON c1.id = b.category_id
      JOIN transaction_categories c2 ON c2.id = b2.category_id
      JOIN users u ON u.id = bm.moved_by_user_id
      WHERE bm.owner_type = ? AND bm.owner_ref = ?
      ORDER BY bm.created_at DESC, bm.id DESC LIMIT 100
    `, [scope === 'family' ? 'family' : 'user', scope === 'family' ? familyId : user.id])
    return send(response, 200, rows.map((row) => ({ id: Number(row.id), fromCategory: row.from_category, toCategory: row.to_category, amount: Number(row.amount), note: row.note, movedBy: row.moved_by, createdAt: row.created_at })))
  }

  const budgetRoute = pathname.match(/^\/api\/budgets\/(\d+)$/)
  if (budgetRoute && ['PATCH', 'DELETE'].includes(method)) {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const [rows] = await pool.execute('SELECT * FROM budgets WHERE id = ? AND archived_at IS NULL', [Number(budgetRoute[1])])
    const budget = rows[0]
    if (!budget) return send(response, 404, { error: 'ไม่พบงบประมาณ' })
    const allowed = budget.owner_type === 'user' && Number(budget.owner_user_id) === user.id || budget.owner_type === 'family' && user.families.some((family) => family.id === Number(budget.family_id) && family.role === 'owner')
    if (!allowed) return send(response, 403, { error: 'คุณไม่มีสิทธิ์จัดการงบนี้' })
    if (method === 'DELETE') { await pool.execute('UPDATE budgets SET archived_at = UTC_TIMESTAMP() WHERE id = ?', [budget.id]); return send(response, 200, { ok: true }) }
    const body = await readJson(request)
    const amount = body.amount === undefined ? Number(budget.amount) : Number(body.amount)
    const alertPercent = body.alertPercent === undefined ? Number(budget.alert_percent) : Number(body.alertPercent)
    const cycleStartDay = body.cycleStartDay === undefined ? Number(budget.cycle_start_day) : Number(body.cycleStartDay)
    const periodType = body.periodType === undefined ? budget.period_type : body.periodType
    const periodStart = body.periodStart === undefined ? budget.period_start : body.periodStart ? String(body.periodStart) : null
    const periodEnd = body.periodEnd === undefined ? budget.period_end : body.periodEnd ? String(body.periodEnd) : null
    if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100 || !Number.isInteger(alertPercent) || alertPercent < 1 || alertPercent > 100 || !['monthly', 'custom'].includes(periodType) || periodType === 'monthly' && (!Number.isInteger(cycleStartDay) || cycleStartDay < 1 || cycleStartDay > 28) || periodType === 'custom' && (!validDateKey(periodStart) || !validDateKey(periodEnd) || periodEnd < periodStart)) return send(response, 400, { error: 'วงเงิน รอบเวลา หรือค่าเตือนไม่ถูกต้อง' })
    await pool.execute('UPDATE budgets SET amount = ?, alert_percent = ?, period_type = ?, cycle_start_day = ?, period_start = ?, period_end = ? WHERE id = ?', [amount, alertPercent, periodType, cycleStartDay, periodType === 'custom' ? periodStart : null, periodType === 'custom' ? periodEnd : null, budget.id])
    return send(response, 200, { ok: true })
  }

  const categoryRoute = pathname.match(/^\/api\/categories\/(\d+)$/)
  if (categoryRoute && ['PATCH', 'DELETE'].includes(method)) {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const [rows] = await pool.execute('SELECT * FROM transaction_categories WHERE id = ? AND archived_at IS NULL', [Number(categoryRoute[1])])
    const category = rows[0]
    if (!category) return send(response, 404, { error: 'ไม่พบหมวดหมู่' })
    const allowed = category.owner_type === 'user' && Number(category.owner_user_id) === user.id
      || category.owner_type === 'family' && user.families.some((family) => family.id === Number(category.family_id) && family.role === 'owner')
    if (!allowed) return send(response, 403, { error: 'คุณไม่มีสิทธิ์จัดการหมวดหมู่นี้' })
    if (method === 'DELETE') {
      await pool.execute('UPDATE transaction_categories SET archived_at = UTC_TIMESTAMP() WHERE id = ?', [category.id])
      return send(response, 200, { ok: true })
    }
    const body = await readJson(request)
    const name = body.name === undefined ? category.name : String(body.name).trim()
    const icon = body.icon === undefined ? category.icon : String(body.icon).slice(0, 12)
    if (!name || name.length > 80) return send(response, 400, { error: 'ชื่อหมวดหมู่ไม่ถูกต้อง' })
    try {
      await pool.execute('UPDATE transaction_categories SET name = ?, icon = ? WHERE id = ?', [name, icon, category.id])
      return send(response, 200, { id: Number(category.id), kind: category.kind, name, icon, isDefault: Boolean(category.is_default) })
    } catch (error) { if (error.code === 'ER_DUP_ENTRY') return send(response, 409, { error: 'มีหมวดหมู่นี้อยู่แล้ว' }); throw error }
  }

  if (pathname === '/api/recurring-rules' && method === 'GET') {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const scope = url.searchParams.get('scope') === 'family' ? 'family' : 'personal'
    const familyId = Number(url.searchParams.get('familyId')) || user.families[0]?.id || 0
    if (scope === 'family' && !user.families.some((family) => family.id === familyId)) return send(response, 403, { error: 'คุณไม่มีสิทธิ์ดูรายการประจำของครอบครัวนี้' })
    const [rules] = await pool.execute(`
      SELECT r.*, c.name AS category_name, u.display_name AS creator_name
      FROM recurring_rules r LEFT JOIN transaction_categories c ON c.id = r.category_id
      JOIN users u ON u.id = r.created_by_user_id
      WHERE r.owner_type = ? AND r.owner_ref = ? AND (r.owner_type = 'family' OR r.created_by_user_id = ?)
      ORDER BY r.created_at DESC
    `, [scope === 'family' ? 'family' : 'user', scope === 'family' ? familyId : user.id, user.id])
    const safeRules = await Promise.all(rules.map(async (rule) => maskPrivateAccountReferences(pool, { id: Number(rule.id), scope, familyId: rule.family_id == null ? null : Number(rule.family_id), kind: rule.kind, title: rule.title, categoryId: rule.category_id == null ? null : Number(rule.category_id), category: rule.category_name, amount: Number(rule.amount), sourceAccountId: Number(rule.source_account_id), destinationAccountId: rule.destination_account_id == null ? null : Number(rule.destination_account_id), owner: rule.owner_name, payer: rule.payer_name, frequency: rule.frequency, intervalCount: Number(rule.interval_count), dayOfMonth: rule.day_of_month == null ? null : Number(rule.day_of_month), startsOn: rule.starts_on, endsOn: rule.ends_on, paused: Boolean(rule.paused_at), createdBy: rule.creator_name, canManage: canManageRecurringRule(user, rule) }, user)))
    return send(response, 200, safeRules)
  }

  if (pathname === '/api/recurring-rules' && method === 'POST') {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const body = await readJson(request)
    const scope = body.scope; const familyId = Number(body.familyId)
    const kind = body.kind; const title = String(body.title || '').trim(); const amount = Number(body.amount)
    const frequency = body.frequency; const intervalCount = Number(body.intervalCount || 1)
    const dayOfMonth = body.dayOfMonth == null || body.dayOfMonth === '' ? null : Number(body.dayOfMonth)
    const startsOn = String(body.startsOn || bangkokDateKey())
    const endsOn = body.endsOn ? String(body.endsOn) : null
    const sourceAccountId = Number(body.sourceAccountId); const destinationAccountId = Number(body.destinationAccountId) || null
    const categoryId = Number(body.categoryId) || null; const owner = String(body.owner || '').trim(); const payer = kind === 'expense' ? String(body.payer || '').trim() : null
    if (!['personal', 'family'].includes(scope) || !['income', 'expense', 'transfer'].includes(kind) || !title || title.length > 160 || !Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100 || !['weekly', 'monthly', 'yearly'].includes(frequency) || !Number.isInteger(intervalCount) || intervalCount < 1 || intervalCount > 52 || !validDateKey(startsOn) || endsOn && (!validDateKey(endsOn) || endsOn < startsOn) || dayOfMonth !== null && (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31)) return send(response, 400, { error: 'ข้อมูลรายการประจำไม่ถูกต้อง' })
    let ownerType = 'user'; let ownerRef = user.id; let ownerUserId = user.id; let scopedFamilyId = null
    let permittedNames = [user.displayName]
    if (scope === 'family') {
      const family = user.families.find((item) => item.id === familyId)
      if (!family) return send(response, 403, { error: 'คุณไม่มีสิทธิ์สร้างรายการประจำในครอบครัวนี้' })
      const [members] = await pool.execute('SELECT u.display_name FROM family_members fm JOIN users u ON u.id = fm.user_id WHERE fm.family_id = ? AND fm.left_at IS NULL', [familyId])
      permittedNames = [...members.map((member) => member.display_name), 'ครอบครัว']
      ownerType = 'family'; ownerRef = familyId; ownerUserId = null; scopedFamilyId = familyId
    }
    if (!sourceAccountId) return send(response, 400, { error: 'เลือกบัญชีเงินก่อนสร้างรายการประจำ' })
    const source = await accountById(pool, sourceAccountId)
    if (!await accountVisibleToUser(user, source, scope, scopedFamilyId, 'source', kind)) return send(response, 403, { error: 'ไม่มีสิทธิ์ใช้บัญชีเงินนี้' })
    let destination = null
    if (kind === 'transfer') {
      if (!destinationAccountId || destinationAccountId === sourceAccountId) return send(response, 400, { error: 'เลือกบัญชีปลายทางให้ต่างจากบัญชีต้นทาง' })
      destination = await accountById(pool, destinationAccountId)
      if (!await accountVisibleToUser(user, destination, scope, scopedFamilyId, 'destination', kind)) return send(response, 403, { error: 'ไม่มีสิทธิ์ใช้บัญชีปลายทางนี้' })
    }
    if (kind !== 'transfer') {
      const [categories] = await pool.execute('SELECT id FROM transaction_categories WHERE id = ? AND owner_type = ? AND owner_ref = ? AND kind = ? AND archived_at IS NULL', [categoryId, ownerType, ownerRef, kind])
      if (!categories.length) return send(response, 400, { error: 'เลือกหมวดในขอบเขตนี้ก่อนสร้างรายการประจำ' })
    }
    if (!permittedNames.includes(owner) || payer && !permittedNames.includes(payer)) return send(response, 400, { error: 'เจ้าของรายการหรือผู้จ่ายต้องเป็นสมาชิกปัจจุบัน' })
    const [result] = await pool.execute(`INSERT INTO recurring_rules (owner_type, owner_ref, owner_user_id, family_id, created_by_user_id, kind, title, category_id, amount, source_account_id, destination_account_id, owner_name, payer_name, frequency, interval_count, day_of_month, starts_on, ends_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [ownerType, ownerRef, ownerUserId, scopedFamilyId, user.id, kind, title, categoryId, amount, sourceAccountId, destinationAccountId, owner, payer, frequency, intervalCount, dayOfMonth, startsOn, endsOn])
    return send(response, 201, { id: Number(result.insertId) })
  }

  if (pathname === '/api/recurring-reviews' && method === 'GET') {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const scope = url.searchParams.get('scope') === 'family' ? 'family' : 'personal'
    const familyId = Number(url.searchParams.get('familyId')) || user.families[0]?.id || 0
    if (scope === 'family' && !user.families.some((family) => family.id === familyId)) return send(response, 403, { error: 'คุณไม่มีสิทธิ์ดูรายการรอตรวจนี้' })
    const ownerType = scope === 'family' ? 'family' : 'user'; const ownerRef = scope === 'family' ? familyId : user.id
    await processRecurringReviews()
    const [reviews] = await pool.execute(`
      SELECT rr.id, rr.cycle_key, rr.review_date, rr.payload, r.owner_type, r.owner_ref, r.created_by_user_id, u.display_name AS creator_name
      FROM recurring_reviews rr JOIN recurring_rules r ON r.id = rr.recurring_rule_id JOIN users u ON u.id = r.created_by_user_id
      WHERE r.owner_type = ? AND r.owner_ref = ? AND rr.status = 'pending' AND (r.owner_type = 'family' OR r.created_by_user_id = ?)
      ORDER BY rr.review_date, rr.id
    `, [ownerType, ownerRef, user.id])
    const safeReviews = await Promise.all(reviews.map(async (review) => {
      const payload = typeof review.payload === 'string' ? JSON.parse(review.payload) : { ...review.payload }
      payload.scope = scope
      payload.familyId = scope === 'family' ? familyId : null
      return { id: Number(review.id), cycleKey: review.cycle_key, reviewDate: review.review_date, transaction: await maskPrivateAccountReferences(pool, payload, user), createdBy: review.creator_name, canManage: canManageRecurringRule(user, { ...review, owner_type: review.owner_type, owner_ref: review.owner_ref }) }
    }))
    return send(response, 200, safeReviews)
  }

  const recurringRuleRoute = pathname.match(/^\/api\/recurring-rules\/(\d+)$/)
  if (recurringRuleRoute && ['PATCH', 'DELETE'].includes(method)) {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const [rows] = await pool.execute('SELECT * FROM recurring_rules WHERE id = ?', [Number(recurringRuleRoute[1])])
    const rule = rows[0]
    if (!rule || !canManageRecurringRule(user, rule)) return send(response, 404, { error: 'ไม่พบรายการประจำหรือคุณไม่มีสิทธิ์จัดการ' })
    if (method === 'DELETE') { await pool.execute('UPDATE recurring_rules SET paused_at = UTC_TIMESTAMP() WHERE id = ?', [rule.id]); return send(response, 200, { ok: true, paused: true }) }
    const body = await readJson(request)
    const title = body.title === undefined ? rule.title : String(body.title).trim()
    const amount = body.amount === undefined ? Number(rule.amount) : Number(body.amount)
    const frequency = body.frequency === undefined ? rule.frequency : body.frequency
    const intervalCount = body.intervalCount === undefined ? Number(rule.interval_count) : Number(body.intervalCount)
    const dayOfMonth = body.dayOfMonth === undefined ? rule.day_of_month : body.dayOfMonth === null ? null : Number(body.dayOfMonth)
    const endsOn = body.endsOn === undefined ? rule.ends_on : body.endsOn ? String(body.endsOn) : null
    const categoryId = body.categoryId === undefined ? rule.category_id : Number(body.categoryId) || null
    const sourceAccountId = body.sourceAccountId === undefined ? Number(rule.source_account_id) : Number(body.sourceAccountId)
    const destinationAccountId = body.destinationAccountId === undefined ? (rule.destination_account_id == null ? null : Number(rule.destination_account_id)) : Number(body.destinationAccountId) || null
    const owner = body.owner === undefined ? rule.owner_name : String(body.owner).trim()
    const payer = rule.kind === 'expense' ? (body.payer === undefined ? rule.payer_name || '' : String(body.payer).trim()) : null
    if (!title || title.length > 160 || !Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100 || !['weekly', 'monthly', 'yearly'].includes(frequency) || !Number.isInteger(intervalCount) || intervalCount < 1 || intervalCount > 52 || dayOfMonth !== null && (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) || endsOn && (!validDateKey(endsOn) || endsOn < String(rule.starts_on).slice(0, 10)) || !sourceAccountId || rule.kind === 'transfer' && (!destinationAccountId || destinationAccountId === sourceAccountId) || rule.kind !== 'transfer' && !categoryId || !owner || owner.length > 100 || payer && payer.length > 100) return send(response, 400, { error: 'ข้อมูลกติกาประจำไม่ถูกต้อง' })
    const scope = rule.owner_type === 'family' ? 'family' : 'personal'
    const familyId = scope === 'family' ? Number(rule.family_id) : null
    const [members] = scope === 'family' ? await pool.execute('SELECT u.display_name FROM family_members fm JOIN users u ON u.id = fm.user_id WHERE fm.family_id = ? AND fm.left_at IS NULL', [familyId]) : [[]]
    const permittedNames = scope === 'family' ? [...members.map((member) => member.display_name), 'ครอบครัว'] : [user.displayName]
    if (!permittedNames.includes(owner) || payer && !permittedNames.includes(payer)) return send(response, 400, { error: 'เจ้าของรายการหรือผู้จ่ายต้องเป็นสมาชิกปัจจุบัน' })
    const sourceAccount = await accountById(pool, sourceAccountId)
    if (!await accountVisibleToUser(user, sourceAccount, scope, familyId, 'source', rule.kind)) return send(response, 403, { error: 'ไม่มีสิทธิ์ใช้บัญชีเงินนี้' })
    let destinationAccount = null
    if (rule.kind === 'transfer') {
      destinationAccount = await accountById(pool, destinationAccountId)
      if (!await accountVisibleToUser(user, destinationAccount, scope, familyId, 'destination', rule.kind)) return send(response, 403, { error: 'ไม่มีสิทธิ์ใช้บัญชีปลายทางนี้' })
    }
    if (rule.kind !== 'transfer') {
      const [categories] = await pool.execute('SELECT id FROM transaction_categories WHERE id = ? AND owner_type = ? AND owner_ref = ? AND kind = ? AND archived_at IS NULL', [categoryId, rule.owner_type, rule.owner_ref, rule.kind])
      if (!categories.length) return send(response, 400, { error: 'เลือกหมวดในขอบเขตนี้ก่อนบันทึกกติกา' })
    }
    await pool.execute('UPDATE recurring_rules SET title = ?, amount = ?, category_id = ?, source_account_id = ?, destination_account_id = ?, owner_name = ?, payer_name = ?, frequency = ?, interval_count = ?, day_of_month = ?, ends_on = ?, paused_at = ? WHERE id = ?', [title, amount, rule.kind === 'transfer' ? null : categoryId, sourceAccountId, rule.kind === 'transfer' ? destinationAccountId : null, owner, payer, frequency, intervalCount, dayOfMonth, endsOn, body.paused === false ? null : body.paused === true ? new Date() : rule.paused_at, rule.id])
    return send(response, 200, { ok: true })
  }

  const recurringReviewRoute = pathname.match(/^\/api\/recurring-reviews\/(\d+)$/)
  if (recurringReviewRoute && method === 'POST') {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const body = await readJson(request)
    const action = body.action
    if (!['confirm', 'dismiss'].includes(action)) return send(response, 400, { error: 'เลือกยืนยันหรือไม่บันทึกรายการนี้' })
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const [rows] = await connection.execute(`SELECT rr.*, r.*, rr.id AS review_id, rr.status AS review_status, rr.payload AS review_payload FROM recurring_reviews rr JOIN recurring_rules r ON r.id = rr.recurring_rule_id WHERE rr.id = ? FOR UPDATE`, [Number(recurringReviewRoute[1])])
      const review = rows[0]
      if (!review || review.review_status !== 'pending' || !canManageRecurringRule(user, review)) { await connection.rollback(); return send(response, 404, { error: 'ไม่พบรายการรอตรวจหรือคุณไม่มีสิทธิ์ยืนยัน' }) }
      if (action === 'dismiss') {
        await connection.execute(`UPDATE recurring_reviews SET status = 'dismissed', reviewed_by_user_id = ?, reviewed_at = UTC_TIMESTAMP() WHERE id = ?`, [user.id, review.review_id])
        await connection.commit()
        return send(response, 200, { ok: true, dismissed: true })
      }
      const payload = typeof review.review_payload === 'string' ? JSON.parse(review.review_payload) : review.review_payload
      if (body.edits && typeof body.edits === 'object') {
        const title = body.edits.title === undefined ? payload.title : String(body.edits.title).trim()
        const amount = body.edits.amount === undefined ? Number(payload.amount) : Number(body.edits.amount)
        const occurredAt = body.edits.occurredAt === undefined ? payload.occurredAt : localBangkokDateTime(body.edits.occurredAt)
        if (!title || title.length > 160 || !Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100 || !validLocalDateTime(occurredAt)) { await connection.rollback(); return send(response, 400, { error: 'กรุณาตรวจชื่อ ยอดเงิน และวันเวลาของรายการให้ถูกต้อง' }) }
        payload.title = title; payload.amount = amount; payload.occurredAt = occurredAt
      }
      const scope = review.owner_type === 'family' ? 'family' : 'personal'
      const familyId = review.family_id == null ? null : Number(review.family_id)
      const membership = familyId && user.families.find((family) => family.id === familyId)
      if (scope === 'family' && !membership) { await connection.rollback(); return send(response, 403, { error: 'คุณออกจากครอบครัวนี้แล้ว' }) }
      const [members] = scope === 'family' ? await connection.execute('SELECT u.display_name FROM family_members fm JOIN users u ON u.id = fm.user_id WHERE fm.family_id = ? AND fm.left_at IS NULL', [familyId]) : [[{ display_name: user.displayName }]]
      const permittedNames = [...members.map((member) => member.display_name), ...(scope === 'family' ? ['ครอบครัว'] : [])]
      if (!permittedNames.includes(payload.owner) || payload.payer && !permittedNames.includes(payload.payer)) { await connection.rollback(); return send(response, 409, { error: 'ผู้รับผิดชอบในรายการประจำไม่ได้เป็นสมาชิกปัจจุบัน กรุณาแก้กติกา' }) }
      const accountId = payload.sourceAccountId
      const account = await accountById(connection, accountId)
      const purpose = payload.kind === 'income' ? 'source' : 'source'
      if (!await accountVisibleToUser(user, account, scope, familyId, purpose, payload.kind)) { await connection.rollback(); return send(response, 409, { error: 'บัญชีเงินของรายการประจำถูกปิดหรือไม่มีสิทธิ์แล้ว' }) }
      let destination = null
      if (payload.kind === 'transfer') {
        destination = await accountById(connection, payload.destinationAccountId)
        if (!await accountVisibleToUser(user, destination, scope, familyId, 'destination', 'transfer')) { await connection.rollback(); return send(response, 409, { error: 'บัญชีปลายทางของรายการประจำใช้ไม่ได้แล้ว' }) }
      }
      let category = null
      if (payload.kind !== 'transfer') {
        const [categories] = await connection.execute('SELECT * FROM transaction_categories WHERE id = ? AND archived_at IS NULL AND kind = ? AND owner_type = ? AND owner_ref = ?', [payload.categoryId, payload.kind, scope === 'family' ? 'family' : 'user', scope === 'family' ? familyId : user.id])
        category = categories[0]
        if (!category) { await connection.rollback(); return send(response, 409, { error: 'หมวดของรายการประจำถูกซ่อนแล้ว' }) }
      }
      const [result] = await connection.execute(`INSERT INTO transactions (title, category, kind, amount, scope, occurred_at, source_account, destination_account, owner_name, payer_name, recorder_name, icon, created_by_user_id, family_id, category_id, source_account_id, destination_account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [payload.title, category?.name || 'โอนเงิน', payload.kind, payload.amount, scope, payload.occurredAt, payload.kind === 'income' ? account.name : account.name, payload.kind === 'transfer' ? destination.name : null, payload.owner, payload.payer || null, user.displayName, payload.icon || '🧾', user.id, familyId, category?.id || null, payload.kind === 'income' ? null : account.id, payload.kind === 'income' ? account.id : payload.kind === 'transfer' ? destination.id : null])
      const transaction = await getTransactionRecord(connection, result.insertId)
      await auditTransaction(connection, result.insertId, user.id, 'created', null, transactionSnapshot(transaction))
      await connection.execute(`UPDATE recurring_reviews SET status = 'confirmed', transaction_id = ?, reviewed_by_user_id = ?, reviewed_at = UTC_TIMESTAMP() WHERE id = ?`, [result.insertId, user.id, review.review_id])
      await connection.commit()
      return send(response, 201, { ok: true, transaction: await mapTransactionForUser(connection, transaction, user) })
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
  }

  if (method === 'POST' && pathname === '/api/receipts') {
    if (rateLimit(request, response, 'receipt-upload', 5)) return
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const body = await readJson(request, 8_500_000)
    const mimeType = String(body.mimeType || '')
    const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' })[mimeType]
    const encoded = String(body.data || '').replace(/^data:[^,]+,/, '')
    if (!extension || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return send(response, 400, { error: 'รองรับไฟล์ภาพ JPEG, PNG หรือ WebP เท่านั้น' })
    const buffer = Buffer.from(encoded, 'base64')
    if (!buffer.length || buffer.length > 6 * 1024 * 1024) return send(response, 413, { error: 'ภาพต้องมีขนาดไม่เกิน 6 MB' })
    const signatures = { jpg: buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff, png: buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), webp: buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP' }
    if (!signatures[extension]) return send(response, 400, { error: 'เนื้อหาไฟล์ไม่ตรงกับชนิดภาพที่ระบุ' })
    const scope = body.scope === 'family' ? 'family' : 'personal'
    const familyId = Number(body.familyId) || null
    if (scope === 'family' && (!familyId || !user.families.some((family) => family.id === familyId))) return send(response, 403, { error: 'คุณไม่มีสิทธิ์แนบภาพในครอบครัวนี้' })
    const storageKey = `${randomBytes(24).toString('hex')}.${extension}`
    const filePath = path.join(receiptDirectory, storageKey)
    await mkdir(receiptDirectory, { recursive: true })
    await writeFile(filePath, buffer, { flag: 'wx', mode: 0o600 })
    let extracted = { merchant: null, amount: null, date: null, category: null, rawText: '' }
    let status = 'failed'
    let ocrAvailable = true
    try {
      const { stdout } = await execFileAsync('tesseract', [filePath, 'stdout', '-l', 'tha+eng', '--psm', '6'], { timeout: 30_000, maxBuffer: 1_000_000 })
      extracted = receiptSuggestions(stdout)
      status = stdout.trim() ? 'pending_review' : 'failed'
    } catch { ocrAvailable = false }
    try {
      const [result] = await pool.execute(`INSERT INTO receipt_attachments (owner_user_id, family_id, storage_key, original_name, mime_type, size_bytes, content_sha256, processing_status, extracted_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [user.id, scope === 'family' ? familyId : null, storageKey, path.basename(String(body.fileName || 'receipt').slice(0, 255)), mimeType, buffer.length, createHash('sha256').update(buffer).digest('hex'), status, JSON.stringify(extracted)])
      return send(response, 201, { id: Number(result.insertId), status, ocrAvailable, extracted })
    } catch (error) { await unlink(filePath).catch(() => {}); throw error }
  }

  const receiptRoute = pathname.match(/^\/api\/receipts\/(\d+)(?:\/(content|attach))?$/)
  if (receiptRoute && (method === 'GET' || method === 'DELETE' || method === 'POST')) {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const [rows] = await pool.execute('SELECT * FROM receipt_attachments WHERE id = ? AND deleted_at IS NULL', [Number(receiptRoute[1])])
    const receipt = rows[0]
    if (!receipt) return send(response, 404, { error: 'ไม่พบภาพสลิป' })
    const memberOfReceiptFamily = receipt.family_id != null && user.families.some((family) => family.id === Number(receipt.family_id))
    const canAccessReceipt = receipt.family_id != null
      ? memberOfReceiptFamily
      : Number(receipt.owner_user_id) === user.id
    if (!canAccessReceipt) return send(response, 404, { error: 'ไม่พบภาพสลิป' })
    if (receiptRoute[2] === 'content' && method === 'GET') {
      const image = await readFile(path.join(receiptDirectory, receipt.storage_key))
      response.writeHead(200, { 'content-type': receipt.mime_type, 'content-length': image.length, 'content-disposition': 'inline', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' })
      return response.end(image)
    }
    if (receiptRoute[2] === 'attach' && method === 'POST') {
      const body = await readJson(request)
      const [transactions] = await pool.execute('SELECT * FROM transactions WHERE id = ? AND deleted_at IS NULL', [Number(body.transactionId)])
      const transaction = transactions[0]
      if (!transaction || !canManageTransaction(user, transaction) || (receipt.family_id && Number(transaction.family_id) !== Number(receipt.family_id)) || (!receipt.family_id && transaction.scope !== 'personal')) return send(response, 404, { error: 'ไม่พบรายการที่สามารถแนบภาพนี้ได้' })
      await pool.execute('UPDATE receipt_attachments SET transaction_id = ?, processing_status = IF(processing_status = \'failed\', \'failed\', \'confirmed\') WHERE id = ?', [transaction.id, receipt.id])
      return send(response, 200, { ok: true })
    }
    if (method === 'DELETE') {
      const [transactions] = receipt.transaction_id ? await pool.execute('SELECT * FROM transactions WHERE id = ?', [receipt.transaction_id]) : [[]]
      const transaction = transactions[0]
      const familyOwner = transaction?.family_id && user.families.some((family) => family.id === Number(transaction.family_id) && family.role === 'owner')
      if (Number(receipt.owner_user_id) !== user.id && !familyOwner) return send(response, 403, { error: 'คุณไม่มีสิทธิ์ลบภาพนี้' })
      await pool.execute('UPDATE receipt_attachments SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [receipt.id])
      await unlink(path.join(receiptDirectory, receipt.storage_key)).catch(() => {})
      return send(response, 200, { ok: true })
    }
    return send(response, 404, { error: 'ไม่พบเส้นทางนี้' })
  }

  if (method === 'GET' && pathname === '/api/transactions/summary') {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const scope = url.searchParams.get('scope')
    if (!['family', 'personal'].includes(scope)) return send(response, 400, { error: 'ขอบเขตข้อมูลไม่ถูกต้อง' })
    const familyId = Number(url.searchParams.get('familyId')) || user.families[0]?.id || 0
    if (scope === 'family' && !user.families.some((family) => family.id === familyId)) return send(response, 403, { error: 'คุณไม่มีสิทธิ์ดูข้อมูลครอบครัวนี้' })
    const dateFrom = url.searchParams.get('dateFrom') || ''
    const dateTo = url.searchParams.get('dateTo') || ''
    if (!validDateKey(dateFrom) || !validDateKey(dateTo) || dateFrom > dateTo) return send(response, 400, { error: 'ช่วงวันที่ไม่ถูกต้อง' })
    let baseWhere = scope === 'family'
      ? `t.scope = 'family' AND t.family_id = ? AND EXISTS (SELECT 1 FROM family_members current_member WHERE current_member.family_id = t.family_id AND current_member.user_id = ? AND current_member.left_at IS NULL) AND t.deleted_at IS NULL AND t.occurred_at >= ? AND t.occurred_at < DATE_ADD(?, INTERVAL 1 DAY)`
      : `t.scope = 'personal' AND t.created_by_user_id = ? AND t.deleted_at IS NULL AND t.occurred_at >= ? AND t.occurred_at < DATE_ADD(?, INTERVAL 1 DAY)`
    const baseParams = scope === 'family' ? [familyId, user.id, `${dateFrom} 00:00:00`, `${dateTo} 00:00:00`] : [user.id, `${dateFrom} 00:00:00`, `${dateTo} 00:00:00`]
    const kind = url.searchParams.get('kind')
    if (kind && !['income', 'expense', 'transfer'].includes(kind)) return send(response, 400, { error: 'ประเภทรายการไม่ถูกต้อง' })
    const search = String(url.searchParams.get('search') || '').trim().slice(0, 160)
    if (kind) { baseWhere += ' AND t.kind = ?'; baseParams.push(kind) }
    if (search) { baseWhere += ' AND t.title LIKE ?'; baseParams.push(`%${search.replace(/[\\%_]/g, (match) => `\\${match}`)}%`) }
    const [totalsRows] = await pool.execute(`SELECT COALESCE(SUM(CASE WHEN t.kind = 'income' THEN t.amount ELSE 0 END), 0) AS income, COALESCE(SUM(CASE WHEN t.kind = 'expense' THEN t.amount ELSE 0 END), 0) AS expense FROM transactions t WHERE ${baseWhere}`, baseParams)
    const [categoryRows] = await pool.execute(`
      SELECT kind, bucket, SUM(amount) AS amount FROM (
        SELECT t.kind, COALESCE(c.name, t.category) AS bucket, a.amount
        FROM transactions t JOIN transaction_allocations a ON a.transaction_id = t.id
        LEFT JOIN transaction_categories c ON c.id = a.category_id
        WHERE ${baseWhere} AND t.kind <> 'transfer'
        UNION ALL
        SELECT t.kind, COALESCE(c.name, t.category) AS bucket, t.amount
        FROM transactions t LEFT JOIN transaction_categories c ON c.id = t.category_id
        WHERE ${baseWhere} AND t.kind <> 'transfer'
          AND NOT EXISTS (SELECT 1 FROM transaction_allocations a WHERE a.transaction_id = t.id)
      ) parts GROUP BY kind, bucket ORDER BY amount DESC
    `, [...baseParams, ...baseParams])
    const [ownerRows] = await pool.execute(`
      SELECT bucket, SUM(amount) AS amount FROM (
        SELECT CASE WHEN a.owner_is_family = 1 THEN 'ครอบครัว' ELSE COALESCE(allocated_user.display_name, 'ไม่ระบุ') END AS bucket, a.amount
        FROM transactions t JOIN transaction_allocations a ON a.transaction_id = t.id
        LEFT JOIN users allocated_user ON allocated_user.id = a.owner_user_id
        WHERE ${baseWhere} AND t.kind <> 'transfer'
        UNION ALL
        SELECT COALESCE(NULLIF(t.owner_name, ''), 'ไม่ระบุ') AS bucket, t.amount
        FROM transactions t
        WHERE ${baseWhere} AND t.kind <> 'transfer'
          AND NOT EXISTS (SELECT 1 FROM transaction_allocations a WHERE a.transaction_id = t.id)
      ) parts GROUP BY bucket ORDER BY amount DESC
    `, [...baseParams, ...baseParams])
    const [accountRows] = await pool.execute(`
      SELECT CASE WHEN t.kind = 'income'
        THEN CASE WHEN da.owner_type = 'user' AND da.owner_user_id <> ? THEN 'บัญชีสมาชิก' ELSE COALESCE(da.name, t.source_account) END
        ELSE CASE WHEN sa.owner_type = 'user' AND sa.owner_user_id <> ? THEN 'บัญชีสมาชิก' ELSE COALESCE(sa.name, t.source_account) END
      END AS bucket, SUM(t.amount) AS amount FROM transactions t
      LEFT JOIN money_accounts sa ON sa.id = t.source_account_id
      LEFT JOIN money_accounts da ON da.id = t.destination_account_id
      WHERE ${baseWhere} AND t.kind <> 'transfer'
      GROUP BY bucket ORDER BY amount DESC
    `, [user.id, user.id, ...baseParams])
    const byCategory = new Map()
    const expenseCategories = []
    for (const row of categoryRows) {
      const amount = Number(row.amount)
      byCategory.set(row.bucket, (byCategory.get(row.bucket) || 0) + amount)
      if (row.kind === 'expense') expenseCategories.push({ name: row.bucket, amount })
    }
    return send(response, 200, {
      income: Number(totalsRows[0]?.income || 0), expense: Number(totalsRows[0]?.expense || 0),
      categories: [...byCategory].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount),
      expenseCategories,
      owners: ownerRows.map((row) => ({ name: row.bucket, amount: Number(row.amount) })),
      accounts: accountRows.map((row) => ({ name: row.bucket, amount: Number(row.amount) })),
    })
  }

  if (method === 'GET' && pathname === '/api/transactions/page') {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const requestedScope = url.searchParams.get('scope')
    if (!['family', 'personal'].includes(requestedScope)) return send(response, 400, { error: 'ขอบเขตข้อมูลไม่ถูกต้อง' })
    const scope = requestedScope
    const familyId = Number(url.searchParams.get('familyId')) || user.families[0]?.id || 0
    if (scope === 'family' && !user.families.some((family) => family.id === familyId)) return send(response, 403, { error: 'คุณไม่มีสิทธิ์ดูข้อมูลครอบครัวนี้' })
    const includeTrash = url.searchParams.get('trash') === 'true'
    const page = Math.max(1, Math.min(1_000_000, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1))
    const pageSize = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get('pageSize') || '30', 10) || 30))
    const search = String(url.searchParams.get('search') || '').trim().slice(0, 160)
    const kind = url.searchParams.get('kind')
    if (kind && !['income', 'expense', 'transfer'].includes(kind)) return send(response, 400, { error: 'ประเภทรายการไม่ถูกต้อง' })
    const dateFrom = url.searchParams.get('dateFrom') || ''
    const dateTo = url.searchParams.get('dateTo') || ''
    if (dateFrom && !validDateKey(dateFrom) || dateTo && !validDateKey(dateTo) || dateFrom && dateTo && dateFrom > dateTo) return send(response, 400, { error: 'ช่วงวันที่ไม่ถูกต้อง' })
    const where = [scope === 'family' ? `t.scope = 'family' AND t.family_id = ? AND EXISTS (SELECT 1 FROM family_members current_member WHERE current_member.family_id = t.family_id AND current_member.user_id = ? AND current_member.left_at IS NULL)` : `t.scope = 'personal' AND t.created_by_user_id = ?`]
    const params = scope === 'family' ? [familyId, user.id] : [user.id]
    if (includeTrash) {
      where.push('t.deleted_at IS NOT NULL')
      if (scope === 'family') {
        where.push(`(t.created_by_user_id = ? OR EXISTS (SELECT 1 FROM family_members owner_membership WHERE owner_membership.family_id = t.family_id AND owner_membership.user_id = ? AND owner_membership.left_at IS NULL AND owner_membership.role = 'owner'))`)
        params.push(user.id, user.id)
      }
    } else where.push('t.deleted_at IS NULL')
    if (kind) { where.push('t.kind = ?'); params.push(kind) }
    if (search) { where.push('t.title LIKE ?'); params.push(`%${search.replace(/[\\%_]/g, (match) => `\\${match}`)}%`) }
    if (dateFrom) { where.push('t.occurred_at >= ?'); params.push(`${dateFrom} 00:00:00`) }
    if (dateTo) { where.push('t.occurred_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(`${dateTo} 00:00:00`) }
    const whereSql = where.join(' AND ')
    const [counts] = await pool.execute(`SELECT COUNT(*) AS total FROM transactions t WHERE ${whereSql}`, params)
    const total = Number(counts[0]?.total || 0)
    const [rows] = await pool.execute(`
      SELECT t.id, t.title, COALESCE(c.name, t.category) AS category, t.category_id, t.kind, t.amount, t.scope, t.occurred_at,
             CASE WHEN t.kind = 'income' THEN CASE WHEN da.owner_type = 'user' AND da.owner_user_id <> ? THEN 'บัญชีสมาชิก' ELSE COALESCE(da.name, t.source_account) END
               ELSE CASE WHEN sa.owner_type = 'user' AND sa.owner_user_id <> ? THEN 'บัญชีสมาชิก' ELSE COALESCE(sa.name, t.source_account) END END AS source_account,
             CASE WHEN da.owner_type = 'user' AND da.owner_user_id <> ? THEN 'บัญชีสมาชิก' ELSE COALESCE(da.name, t.destination_account) END AS destination_account,
             CASE WHEN t.scope = 'family' AND sa.owner_type = 'user' AND sa.owner_user_id <> ? THEN NULL ELSE t.source_account_id END AS source_account_id,
             CASE WHEN t.scope = 'family' AND da.owner_type = 'user' AND da.owner_user_id <> ? THEN NULL ELSE t.destination_account_id END AS destination_account_id,
             t.owner_name, t.payer_name,
             (SELECT r.id FROM receipt_attachments r WHERE r.transaction_id = t.id AND r.deleted_at IS NULL ORDER BY r.id DESC LIMIT 1) AS receipt_id,
             u.display_name AS recorder_name, t.icon
      FROM transactions t
      LEFT JOIN users u ON u.id = t.created_by_user_id
      LEFT JOIN money_accounts sa ON sa.id = t.source_account_id
      LEFT JOIN money_accounts da ON da.id = t.destination_account_id
      LEFT JOIN transaction_categories c ON c.id = t.category_id
      WHERE ${whereSql}
      ORDER BY t.occurred_at DESC, t.id DESC
      LIMIT ? OFFSET ?
    `, [user.id, user.id, user.id, user.id, user.id, ...params, pageSize, (page - 1) * pageSize])
    const mapped = rows.map(mapTransaction)
    if (mapped.length) {
      const ids = mapped.map((row) => row.id)
      const [allocations] = await pool.query(`SELECT a.transaction_id, a.category_id, c.name AS category, a.owner_user_id, a.owner_is_family, u.display_name AS owner_name, a.amount FROM transaction_allocations a LEFT JOIN transaction_categories c ON c.id = a.category_id LEFT JOIN users u ON u.id = a.owner_user_id WHERE a.transaction_id IN (${ids.map(() => '?').join(',')}) ORDER BY a.id`, ids)
      const byTransaction = new Map()
      for (const allocation of allocations) {
        const bucket = byTransaction.get(Number(allocation.transaction_id)) || []
        bucket.push({ categoryId: allocation.category_id == null ? null : Number(allocation.category_id), category: allocation.category || null, ownerUserId: allocation.owner_user_id == null ? null : Number(allocation.owner_user_id), ownerName: allocation.owner_is_family ? 'ครอบครัว' : allocation.owner_name, amount: Number(allocation.amount) })
        byTransaction.set(Number(allocation.transaction_id), bucket)
      }
      for (const row of mapped) row.allocations = byTransaction.get(row.id) || []
    }
    return send(response, 200, { rows: mapped, page, pageSize, total, totalPages: Math.ceil(total / pageSize) })
  }

  if (method === 'GET' && pathname === '/api/transactions') {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const includeTrash = url.searchParams.get('trash') === 'true'
    const requestedFamily = Number(url.searchParams.get('familyId'))
    const selectedFamily = requestedFamily || user.families[0]?.id || 0
    const [rows] = await pool.execute(`
      SELECT t.id, t.title, COALESCE(c.name, t.category) AS category, t.category_id, t.kind, t.amount, t.scope, t.occurred_at,
             CASE WHEN t.kind = 'income' THEN CASE WHEN da.owner_type = 'user' AND da.owner_user_id <> ? THEN 'บัญชีสมาชิก' ELSE COALESCE(da.name, t.source_account) END
               ELSE CASE WHEN sa.owner_type = 'user' AND sa.owner_user_id <> ? THEN 'บัญชีสมาชิก' ELSE COALESCE(sa.name, t.source_account) END END AS source_account,
             CASE WHEN da.owner_type = 'user' AND da.owner_user_id <> ? THEN 'บัญชีสมาชิก' ELSE COALESCE(da.name, t.destination_account) END AS destination_account,
             CASE WHEN t.scope = 'family' AND sa.owner_type = 'user' AND sa.owner_user_id <> ? THEN NULL ELSE t.source_account_id END AS source_account_id,
             CASE WHEN t.scope = 'family' AND da.owner_type = 'user' AND da.owner_user_id <> ? THEN NULL ELSE t.destination_account_id END AS destination_account_id,
             t.owner_name, t.payer_name,
             (SELECT r.id FROM receipt_attachments r WHERE r.transaction_id = t.id AND r.deleted_at IS NULL ORDER BY r.id DESC LIMIT 1) AS receipt_id,
             u.display_name AS recorder_name, t.icon
      FROM transactions t
      LEFT JOIN users u ON u.id = t.created_by_user_id
      LEFT JOIN money_accounts sa ON sa.id = t.source_account_id
      LEFT JOIN money_accounts da ON da.id = t.destination_account_id
      LEFT JOIN transaction_categories c ON c.id = t.category_id
      WHERE ((t.scope = 'personal' AND t.created_by_user_id = ?)
         OR (t.scope = 'family' AND t.family_id IN (
           SELECT family_id FROM family_members WHERE user_id = ? AND left_at IS NULL
             AND family_id = ?
         )))
      ${includeTrash ? `AND t.deleted_at IS NOT NULL AND (
        t.created_by_user_id = ? OR EXISTS (
          SELECT 1 FROM family_members owner_membership
          WHERE owner_membership.family_id = t.family_id AND owner_membership.user_id = ?
            AND owner_membership.left_at IS NULL AND owner_membership.role = 'owner'
        )
      )` : 'AND t.deleted_at IS NULL'}
      ORDER BY t.occurred_at DESC, t.id DESC
    `, includeTrash ? [user.id, user.id, user.id, user.id, user.id, user.id, user.id, selectedFamily, user.id, user.id] : [user.id, user.id, user.id, user.id, user.id, user.id, user.id, selectedFamily])
    const mapped = rows.map(mapTransaction)
    if (mapped.length) {
      const ids = mapped.map((row) => row.id)
      const [allocations] = await pool.query(`SELECT a.transaction_id, a.category_id, c.name AS category, a.owner_user_id, a.owner_is_family, u.display_name AS owner_name, a.amount FROM transaction_allocations a LEFT JOIN transaction_categories c ON c.id = a.category_id LEFT JOIN users u ON u.id = a.owner_user_id WHERE a.transaction_id IN (${ids.map(() => '?').join(',')}) ORDER BY a.id`, ids)
      const byTransaction = new Map()
      for (const allocation of allocations) {
        const bucket = byTransaction.get(Number(allocation.transaction_id)) || []
        bucket.push({ categoryId: allocation.category_id == null ? null : Number(allocation.category_id), category: allocation.category || null, ownerUserId: allocation.owner_user_id == null ? null : Number(allocation.owner_user_id), ownerName: allocation.owner_is_family ? 'ครอบครัว' : allocation.owner_name, amount: Number(allocation.amount) })
        byTransaction.set(Number(allocation.transaction_id), bucket)
      }
      for (const row of mapped) row.allocations = byTransaction.get(row.id) || []
    }
    return send(response, 200, mapped)
  }

  if (method === 'POST' && pathname === '/api/transactions') {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const body = await readJson(request)
    const kind = body.kind
    const scope = body.scope
    const amount = Number(body.amount)
    const title = String(body.title || '').trim()
    const clientRequestId = body.clientRequestId == null ? null : String(body.clientRequestId)
    const occurredAtInput = String(body.occurredAt || `${bangkokDateKey()}T12:00:00+07:00`)
    const occurredAt = localBangkokDateTime(occurredAtInput)
    const requestedCategoryId = Number(body.categoryId) || null
    let category = String(body.category || '').trim()
    const requestedSourceAccountId = Number(body.sourceAccountId) || null
    const requestedDestinationAccountId = Number(body.destinationAccountId) || null
    const sourceAccount = String(body.sourceAccount || '').trim()
    const destinationAccount = kind === 'transfer' ? String(body.destinationAccount || '').trim() : null
    const owner = String(body.owner || '').trim()
    const payer = kind === 'expense' ? String(body.payer || '').trim() : null
    const icon = String(body.icon || '🧾').slice(0, 12)
    if (!['income', 'expense', 'transfer'].includes(kind)) return send(response, 400, { error: 'ประเภทรายการไม่ถูกต้อง' })
    if (!['family', 'personal'].includes(scope)) return send(response, 400, { error: 'ขอบเขตรายการไม่ถูกต้อง' })
    if (clientRequestId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientRequestId)) return send(response, 400, { error: 'รหัสคำขอบันทึกไม่ถูกต้อง' })
    if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100) return send(response, 400, { error: 'จำนวนเงินต้องมากกว่าศูนย์และไม่เกินสองตำแหน่งทศนิยม' })
    if (!validLocalDateTime(occurredAt)) return send(response, 400, { error: 'วันที่รายการไม่ถูกต้อง' })
    if (!title || title.length > 160 || sourceAccount.length > 100) return send(response, 400, { error: 'กรอกข้อมูลรายการให้ครบและอยู่ในความยาวที่กำหนด' })
    if (owner.length > 100 || (payer && payer.length > 100)) return send(response, 400, { error: 'ชื่อผู้เกี่ยวข้องยาวเกินกำหนด' })
    if (kind === 'transfer' && (!destinationAccount || destinationAccount.length > 100 || requestedDestinationAccountId === requestedSourceAccountId)) return send(response, 400, { error: 'เลือกบัญชีต้นทางและปลายทางให้ต่างกัน' })

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
    let sourceAccountRecord = null
    let destinationAccountRecord = null
    let categoryRecord = null
    const effectiveSourceId = kind === 'income' ? null : requestedSourceAccountId
    const effectiveDestinationId = kind === 'income' ? requestedSourceAccountId : kind === 'transfer' ? requestedDestinationAccountId : null
    if (!requestedSourceAccountId) return send(response, 400, { error: 'เลือกบัญชีเงินที่มีอยู่ก่อนบันทึกรายการ' })
    sourceAccountRecord = await accountById(pool, requestedSourceAccountId)
    if (!await accountVisibleToUser(user, sourceAccountRecord, scope, familyId, 'source', kind)) return send(response, 403, { error: 'คุณไม่มีสิทธิ์ใช้บัญชีเงินนี้ในรายการดังกล่าว' })
    if (kind === 'transfer' || kind === 'income') {
      const receivingId = kind === 'income' ? requestedSourceAccountId : requestedDestinationAccountId
      destinationAccountRecord = await accountById(pool, receivingId)
      if (!await accountVisibleToUser(user, destinationAccountRecord, scope, familyId, kind === 'income' ? 'source' : 'destination', kind)) return send(response, 403, { error: 'คุณไม่มีสิทธิ์ใช้บัญชีปลายทางนี้' })
    }
    if (kind !== 'transfer') {
      if (!requestedCategoryId) return send(response, 400, { error: 'เลือกหมวดหมู่จากรายการที่มีอยู่' })
      const [categories] = await pool.execute('SELECT * FROM transaction_categories WHERE id = ? AND archived_at IS NULL', [requestedCategoryId])
      categoryRecord = categories[0]
      if (!categoryRecord || categoryRecord.kind !== kind || categoryRecord.owner_type !== (scope === 'family' ? 'family' : 'user') || Number(categoryRecord.owner_ref) !== (scope === 'family' ? Number(familyId) : user.id)) return send(response, 403, { error: 'หมวดหมู่นี้ไม่อยู่ในขอบเขตที่เลือก' })
      category = categoryRecord.name
    } else category = 'โอนเงิน'
    const resolvedSourceName = kind === 'income' ? destinationAccountRecord.name : sourceAccountRecord.name
    const resolvedDestinationName = kind === 'transfer' ? destinationAccountRecord?.name : null
    if (!category || category.length > 80 || !resolvedSourceName || resolvedSourceName.length > 100) return send(response, 400, { error: 'ข้อมูลหมวดหมู่หรือบัญชีเงินไม่ถูกต้อง' })
    if (!permittedNames.includes(owner)) return send(response, 403, { error: 'เจ้าของรายการต้องเป็นสมาชิกที่ยังอยู่ในขอบเขตนี้' })
    if (payer && !permittedNames.includes(payer)) return send(response, 403, { error: 'ผู้จ่ายต้องเป็นสมาชิกที่ยังอยู่ในขอบเขตนี้' })
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const [result] = await connection.execute(`
        INSERT INTO transactions
          (title, category, kind, amount, scope, occurred_at, source_account,
           destination_account, owner_name, payer_name, recorder_name, icon, created_by_user_id, family_id,
           category_id, source_account_id, destination_account_id, client_request_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [title, category, kind, amount, scope, occurredAt, resolvedSourceName, resolvedDestinationName, owner, payer || null, user.displayName, icon, user.id, familyId, categoryRecord?.id || null, effectiveSourceId, effectiveDestinationId, clientRequestId])
      const row = await getTransactionRecord(connection, result.insertId)
      await auditTransaction(connection, result.insertId, user.id, 'created', null, transactionSnapshot(row))
      await connection.commit()
      return send(response, 201, await mapTransactionForUser(connection, row, user))
    } catch (error) {
      await connection.rollback()
      if (error.code === 'ER_DUP_ENTRY' && clientRequestId) {
        const [existing] = await connection.execute('SELECT * FROM transactions WHERE created_by_user_id = ? AND client_request_id = ?', [user.id, clientRequestId])
        if (existing.length) return send(response, 200, await mapTransactionForUser(connection, existing[0], user))
      }
      throw error
    } finally { connection.release() }
  }

  const transactionAllocationsRoute = pathname.match(/^\/api\/transactions\/(\d+)\/allocations$/)
  if (transactionAllocationsRoute && ['GET', 'PUT'].includes(method)) {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const transactionId = Number(transactionAllocationsRoute[1])
    const connection = await pool.getConnection()
    try {
      const row = await getTransactionRecord(connection, transactionId)
      if (!row || !canManageTransaction(user, row) && !(method === 'GET' && row.scope === 'family' && user.families.some((family) => family.id === Number(row.family_id)))) return send(response, 404, { error: 'ไม่พบรายการหรือคุณไม่มีสิทธิ์ดูข้อมูลนี้' })
      if (method === 'GET') {
        const [allocations] = await connection.execute(`
          SELECT a.id, a.category_id, c.name AS category, c.icon, a.owner_user_id, u.display_name AS owner_name,
            a.owner_is_family, a.amount
          FROM transaction_allocations a LEFT JOIN transaction_categories c ON c.id = a.category_id
          LEFT JOIN users u ON u.id = a.owner_user_id WHERE a.transaction_id = ? ORDER BY a.id
        `, [transactionId])
        return send(response, 200, allocations.map((item) => ({ id: Number(item.id), categoryId: item.category_id == null ? null : Number(item.category_id), category: item.category, icon: item.icon, ownerUserId: item.owner_user_id == null ? null : Number(item.owner_user_id), ownerName: item.owner_is_family ? 'ครอบครัว' : item.owner_name, amount: Number(item.amount) })))
      }
      if (!canManageTransaction(user, row)) return send(response, 403, { error: 'คุณไม่มีสิทธิ์แบ่งรายการนี้' })
      if (row.deleted_at || row.kind === 'transfer') return send(response, 409, { error: 'รายการในถังขยะหรือรายการโอนไม่สามารถแบ่งสัดส่วนได้' })
      const body = await readJson(request)
      if (!Array.isArray(body.allocations) || body.allocations.length < 1 || body.allocations.length > 20) return send(response, 400, { error: 'รายการแบ่งต้องมี 1 ถึง 20 ส่วน' })
      const allocations = []
      let totalCents = 0
      for (const item of body.allocations) {
        const categoryId = Number(item.categoryId)
        const cents = Math.round(Number(item.amount) * 100)
        if (!Number.isInteger(categoryId) || categoryId < 1 || !Number.isFinite(Number(item.amount)) || cents <= 0 || Math.abs(Number(item.amount) * 100 - cents) > 0.000001) return send(response, 400, { error: 'กรอกหมวด จำนวนเงิน และผู้รับผิดชอบแต่ละส่วนให้ถูกต้อง' })
        const [categories] = await connection.execute('SELECT id FROM transaction_categories WHERE id = ? AND owner_type = ? AND owner_ref = ? AND kind = ? AND archived_at IS NULL', [categoryId, row.scope === 'family' ? 'family' : 'user', row.scope === 'family' ? row.family_id : user.id, row.kind])
        if (!categories.length) return send(response, 400, { error: 'หมวดของส่วนแบ่งต้องตรงกับขอบเขตและประเภทรายการ' })
        let ownerUserId = user.id
        let ownerIsFamily = false
        if (row.scope === 'family' && item.ownerIsFamily === true) { ownerUserId = null; ownerIsFamily = true }
        else if (row.scope === 'family') {
          ownerUserId = Number(item.ownerUserId)
          const [members] = await connection.execute('SELECT 1 FROM family_members WHERE family_id = ? AND user_id = ? AND left_at IS NULL', [row.family_id, ownerUserId])
          if (!members.length) return send(response, 400, { error: 'ผู้รับผิดชอบแต่ละส่วนต้องเป็นสมาชิกครอบครัวปัจจุบัน' })
        }
        allocations.push({ categoryId, ownerUserId, ownerIsFamily, amount: (cents / 100).toFixed(2) })
        totalCents += cents
      }
      if (totalCents !== Math.round(Number(row.amount) * 100)) return send(response, 400, { error: 'ยอดส่วนแบ่งรวมต้องเท่ากับยอดรายการพอดี' })
      await connection.beginTransaction()
      const lockedRow = await getTransactionRecord(connection, transactionId, true)
      if (!lockedRow || !canManageTransaction(user, lockedRow) || lockedRow.deleted_at || lockedRow.kind === 'transfer' || Math.round(Number(lockedRow.amount) * 100) !== totalCents) { await connection.rollback(); return send(response, 409, { error: 'รายการเปลี่ยนแปลงระหว่างแก้ไข กรุณาโหลดใหม่' }) }
      const [existing] = await connection.execute('SELECT category_id, owner_user_id, owner_is_family, amount FROM transaction_allocations WHERE transaction_id = ? ORDER BY id', [transactionId])
      const before = { ...transactionSnapshot(lockedRow), allocations: existing.map((item) => ({ categoryId: item.category_id, ownerUserId: item.owner_user_id, ownerIsFamily: Boolean(item.owner_is_family), amount: String(item.amount) })) }
      await connection.execute('DELETE FROM transaction_allocations WHERE transaction_id = ?', [transactionId])
      for (const item of allocations) await connection.execute('INSERT INTO transaction_allocations (transaction_id, category_id, owner_user_id, owner_is_family, amount) VALUES (?, ?, ?, ?, ?)', [transactionId, item.categoryId, item.ownerUserId, item.ownerIsFamily, item.amount])
      const after = { ...transactionSnapshot(lockedRow), allocations: allocations.map((item) => ({ categoryId: item.categoryId, ownerUserId: item.ownerUserId, ownerIsFamily: item.ownerIsFamily, amount: item.amount })) }
      await auditTransaction(connection, transactionId, user.id, 'allocations_updated', before, after)
      await connection.commit()
      return send(response, 200, { ok: true, allocations })
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
  }

  const transactionHistoryRoute = pathname.match(/^\/api\/transactions\/(\d+)\/history$/)
  if (method === 'GET' && transactionHistoryRoute) {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const connection = await pool.getConnection()
    try {
      const row = await getTransactionRecord(connection, Number(transactionHistoryRoute[1]))
      if (!row || !canManageTransaction(user, row) && !(row.scope === 'family' && user.families.some((family) => family.id === Number(row.family_id)))) return send(response, 404, { error: 'ไม่พบรายการ' })
      const [history] = await connection.execute(`
        SELECT a.id, a.action, a.before_snapshot, a.after_snapshot, a.created_at, u.display_name AS actor_name
        FROM transaction_audit_logs a JOIN users u ON u.id = a.actor_user_id
        WHERE a.transaction_id = ? ORDER BY a.created_at DESC, a.id DESC
      `, [row.id])
      const mappedHistory = await Promise.all(history.map(async (entry) => ({ id: Number(entry.id), action: entry.action, before: await mapAuditSnapshotForUser(connection, entry.before_snapshot, user), after: await mapAuditSnapshotForUser(connection, entry.after_snapshot, user), actor: entry.actor_name, createdAt: entry.created_at })))
      return send(response, 200, mappedHistory)
    } finally { connection.release() }
  }

  const transactionRoute = pathname.match(/^\/api\/transactions\/(\d+)(?:\/(restore))?$/)
  if (transactionRoute && (method === 'PATCH' || method === 'DELETE' || method === 'POST' && transactionRoute[2] === 'restore')) {
    const user = await currentUser(request)
    if (!user) return send(response, 401, { error: 'กรุณาเข้าสู่ระบบ' })
    const transactionId = Number(transactionRoute[1])
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const row = await getTransactionRecord(connection, transactionId, true)
      if (!row || !canManageTransaction(user, row)) {
        await connection.rollback()
        return send(response, 404, { error: 'ไม่พบรายการหรือคุณไม่มีสิทธิ์จัดการรายการนี้' })
      }
      if (method === 'DELETE') {
        if (row.deleted_at) { await connection.rollback(); return send(response, 409, { error: 'รายการอยู่ในถังขยะแล้ว' }) }
        const before = transactionSnapshot(row)
        await connection.execute('UPDATE transactions SET deleted_at = UTC_TIMESTAMP(), updated_by_user_id = ? WHERE id = ?', [user.id, transactionId])
        const after = transactionSnapshot(await getTransactionRecord(connection, transactionId))
        await auditTransaction(connection, transactionId, user.id, 'trashed', before, after)
        await connection.commit()
        return send(response, 200, { ok: true })
      }
      if (transactionRoute[2] === 'restore') {
        if (!row.deleted_at) { await connection.rollback(); return send(response, 409, { error: 'รายการนี้ไม่ได้อยู่ในถังขยะ' }) }
        const before = transactionSnapshot(row)
        await connection.execute('UPDATE transactions SET deleted_at = NULL, updated_by_user_id = ? WHERE id = ?', [user.id, transactionId])
        const after = transactionSnapshot(await getTransactionRecord(connection, transactionId))
        await auditTransaction(connection, transactionId, user.id, 'restored', before, after)
        await connection.commit()
        return send(response, 200, { ok: true, transaction: await mapTransactionForUser(connection, await getTransactionRecord(connection, transactionId), user) })
      }
      if (row.deleted_at) { await connection.rollback(); return send(response, 409, { error: 'กู้คืนรายการก่อนแก้ไข' }) }
      const body = await readJson(request)
      const values = {
        title: body.title === undefined ? row.title : String(body.title).trim(),
        category: body.category === undefined ? row.category : String(body.category).trim(),
        kind: body.kind === undefined ? row.kind : body.kind,
        amount: body.amount === undefined ? Number(row.amount) : Number(body.amount),
        sourceAccount: body.sourceAccount === undefined ? row.source_account : String(body.sourceAccount).trim(),
        destinationAccount: body.destinationAccount === undefined ? row.destination_account : String(body.destinationAccount).trim(),
        owner: body.owner === undefined ? row.owner_name : String(body.owner).trim(),
        payer: body.payer === undefined ? row.payer_name : String(body.payer).trim(),
        icon: body.icon === undefined ? row.icon : String(body.icon).slice(0, 12),
        occurredAt: body.occurredAt === undefined ? String(row.occurred_at) : localBangkokDateTime(body.occurredAt),
        categoryId: body.categoryId === undefined ? (row.category_id == null ? null : Number(row.category_id)) : (Number(body.categoryId) || null),
        sourceAccountId: body.sourceAccountId === undefined ? (row.source_account_id == null ? null : Number(row.source_account_id)) : (Number(body.sourceAccountId) || null),
        destinationAccountId: body.destinationAccountId === undefined ? (row.destination_account_id == null ? null : Number(row.destination_account_id)) : (Number(body.destinationAccountId) || null),
      }
      if (!['income', 'expense', 'transfer'].includes(values.kind)) { await connection.rollback(); return send(response, 400, { error: 'ประเภทรายการไม่ถูกต้อง' }) }
      if (!Number.isFinite(values.amount) || values.amount <= 0 || Math.round(values.amount * 100) !== values.amount * 100) { await connection.rollback(); return send(response, 400, { error: 'จำนวนเงินต้องมากกว่าศูนย์และไม่เกินสองตำแหน่งทศนิยม' }) }
      const [[allocationSummary]] = await connection.execute('SELECT COUNT(*) AS allocation_count, COALESCE(SUM(amount), 0) AS allocated_amount FROM transaction_allocations WHERE transaction_id = ?', [transactionId])
      if (Number(allocationSummary.allocation_count) > 0 && (values.kind !== row.kind || Math.round(Number(values.amount) * 100) !== Math.round(Number(allocationSummary.allocated_amount) * 100))) { await connection.rollback(); return send(response, 409, { error: 'รายการนี้มีส่วนแบ่งแล้ว กรุณาปรับส่วนแบ่งให้ตรงกับยอดใหม่ก่อนเปลี่ยนยอดหรือประเภท' }) }
      if (!values.title || values.title.length > 160 || !values.category || values.category.length > 80 || !values.sourceAccount || values.sourceAccount.length > 100) { await connection.rollback(); return send(response, 400, { error: 'กรอกข้อมูลรายการให้ครบและอยู่ในความยาวที่กำหนด' }) }
      if (values.owner.length > 100 || values.payer?.length > 100) { await connection.rollback(); return send(response, 400, { error: 'ชื่อผู้เกี่ยวข้องยาวเกินกำหนด' }) }
      if (values.kind === 'transfer' && (!values.destinationAccount || values.destinationAccount.length > 100 || values.destinationAccountId === values.sourceAccountId)) { await connection.rollback(); return send(response, 400, { error: 'เลือกบัญชีต้นทางและปลายทางให้ต่างกัน' }) }
      if (!validLocalDateTime(values.occurredAt)) { await connection.rollback(); return send(response, 400, { error: 'วันที่รายการไม่ถูกต้อง' }) }
      const permittedNames = row.scope === 'personal' ? [user.displayName] : [
        ...(await connection.execute(`SELECT u.display_name FROM family_members fm JOIN users u ON u.id = fm.user_id WHERE fm.family_id = ? AND fm.left_at IS NULL`, [row.family_id]))[0].map((member) => member.display_name), row.owner_name, row.payer_name, 'ครอบครัว',
      ]
      if (!permittedNames.includes(values.owner) || values.payer && !permittedNames.includes(values.payer)) { await connection.rollback(); return send(response, 403, { error: 'เจ้าของรายการและผู้จ่ายต้องอยู่ในขอบเขตนี้' }) }
      let categoryName = values.category
      if (values.kind !== 'transfer' && values.categoryId) {
        const [categories] = await connection.execute('SELECT * FROM transaction_categories WHERE id = ? AND archived_at IS NULL', [values.categoryId])
        const category = categories[0]
        if (!category || category.kind !== values.kind || category.owner_type !== (row.scope === 'family' ? 'family' : 'user') || Number(category.owner_ref) !== (row.scope === 'family' ? Number(row.family_id) : user.id)) { await connection.rollback(); return send(response, 403, { error: 'หมวดหมู่นี้ไม่อยู่ในขอบเขตที่เลือก' }) }
        categoryName = category.name
      } else if (values.kind !== 'transfer' && values.categoryId === null && row.category_id !== null) { await connection.rollback(); return send(response, 400, { error: 'เลือกหมวดหมู่จากรายการที่มีอยู่' }) }
      let sourceRecord = null; let destinationRecord = null
      const accountSourceId = values.kind === 'income' ? values.destinationAccountId : values.sourceAccountId
      const accountDestinationId = values.kind === 'transfer' ? values.destinationAccountId : null
      if (accountSourceId) {
        sourceRecord = await accountById(connection, accountSourceId)
        if (!await accountVisibleToUser(user, sourceRecord, row.scope, row.family_id, 'source', values.kind)) { await connection.rollback(); return send(response, 403, { error: 'คุณไม่มีสิทธิ์ใช้บัญชีเงินนี้ในรายการดังกล่าว' }) }
      }
      if (accountDestinationId) {
        destinationRecord = await accountById(connection, accountDestinationId)
        if (!await accountVisibleToUser(user, destinationRecord, row.scope, row.family_id, 'destination', values.kind)) { await connection.rollback(); return send(response, 403, { error: 'คุณไม่มีสิทธิ์ใช้บัญชีปลายทางนี้' }) }
      }
      if (values.kind !== 'transfer' && values.kind !== 'income' && values.sourceAccountId && !sourceRecord) { await connection.rollback(); return send(response, 400, { error: 'ไม่พบบัญชีเงินต้นทาง' }) }
      if (values.kind === 'income' && values.destinationAccountId && !sourceRecord) { await connection.rollback(); return send(response, 400, { error: 'ไม่พบบัญชีเงินรับเข้า' }) }
      if (values.kind === 'transfer' && (!sourceRecord || !destinationRecord)) { await connection.rollback(); return send(response, 400, { error: 'เลือกบัญชีต้นทางและปลายทางที่ใช้งานได้' }) }
      if (sourceRecord) values.sourceAccount = sourceRecord.name
      if (destinationRecord) values.destinationAccount = destinationRecord.name
      const before = transactionSnapshot(row)
      await connection.execute(`
        UPDATE transactions SET title = ?, category = ?, category_id = ?, kind = ?, amount = ?, occurred_at = ?,
          source_account = ?, destination_account = ?, source_account_id = ?, destination_account_id = ?, owner_name = ?, payer_name = ?, icon = ?, updated_by_user_id = ?
        WHERE id = ?
      `, [values.title, values.kind === 'transfer' ? 'โอนเงิน' : categoryName, values.kind === 'transfer' ? null : values.categoryId, values.kind, values.amount, values.occurredAt, values.sourceAccount, values.kind === 'transfer' ? values.destinationAccount : null, values.kind === 'income' ? null : accountSourceId, values.kind === 'income' ? accountSourceId : accountDestinationId, values.owner, values.kind === 'expense' ? values.payer || null : null, values.icon, user.id, transactionId])
      const updated = await getTransactionRecord(connection, transactionId)
      await auditTransaction(connection, transactionId, user.id, 'updated', before, transactionSnapshot(updated))
      await connection.commit()
      return send(response, 200, await mapTransactionForUser(connection, updated, user))
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
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

processRecurringReviews().catch((error) => console.error('Initial recurring review generation failed', error))
const recurringWorker = setInterval(() => processRecurringReviews().catch((error) => console.error('Recurring review generation failed', error)), 60_000)
recurringWorker.unref()

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(recurringWorker)
  const closed = new Promise((resolve) => {
    server.close(() => resolve())
    server.closeIdleConnections()
  })
  await closed
  await pool.end()
  process.exit(0)
}
let shuttingDown = false
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
