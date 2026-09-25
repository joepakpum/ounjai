import test from 'node:test'
import assert from 'node:assert/strict'
import argon2 from 'argon2'
import mysql from 'mysql2/promise'

const database = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  database: process.env.MYSQL_DATABASE,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  charset: 'utf8mb4',
})
const api = process.env.API_BASE_URL
const origin = process.env.APP_BASE_URL
const password = process.env.TEST_PASSWORD

async function request(path, { method = 'GET', body, cookie } = {}) {
  const headers = { origin }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (cookie) headers.cookie = cookie
  const response = await fetch(`${api}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const json = await response.json()
  return { response, json, cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie }
}

async function createUser(email, displayName, passwordHash) {
  const [result] = await database.execute(
    'INSERT INTO users (email, display_name, password_hash, email_verified_at) VALUES (?, ?, ?, UTC_TIMESTAMP())',
    [email, displayName, passwordHash],
  )
  return Number(result.insertId)
}

test('family ledger, role isolation, and member account deletion', async () => {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id })
  const ownerId = await createUser('owner@integration.invalid', 'ผู้ดูแลทดสอบ', passwordHash)
  const memberId = await createUser('member@integration.invalid', 'สมาชิกทดสอบ', passwordHash)
  const outsiderId = await createUser('outsider@integration.invalid', 'คนนอกทดสอบ', passwordHash)
  const [familyResult] = await database.execute('INSERT INTO families (name, created_by_user_id) VALUES (?, ?)', ['ครอบครัวทดสอบ', ownerId])
  const familyId = Number(familyResult.insertId)
  await database.execute("INSERT INTO family_members (family_id, user_id, role) VALUES (?, ?, 'owner'), (?, ?, 'member')", [familyId, ownerId, familyId, memberId])

  async function login(email) {
    const { response, json, cookie } = await request('/api/auth/login', { method: 'POST', body: { email, password } })
    assert.equal(response.status, 200, json.error)
    assert.ok(cookie)
    return cookie
  }

  const ownerCookie = await login('owner@integration.invalid')
  const memberCookie = await login('member@integration.invalid')
  const outsiderCookie = await login('outsider@integration.invalid')
  const anonymous = await request(`/api/transactions/summary?scope=family&familyId=${familyId}`)
  assert.equal(anonymous.response.status, 401)

  const accountResponse = await request(`/api/accounts?scope=family&familyId=${familyId}`, { cookie: ownerCookie })
  assert.equal(accountResponse.response.status, 200, accountResponse.json.error)
  const sourceAccount = accountResponse.json.find((account) => account.accountType === 'cash')
  assert.ok(sourceAccount)
  const bankResponse = await request('/api/accounts', { method: 'POST', cookie: ownerCookie, body: {
    scope: 'family', familyId, name: 'บัญชีธนาคารครอบครัว', accountType: 'bank', openingBalance: 0, openingDate: '2026-09-01',
  } })
  assert.equal(bankResponse.response.status, 201, bankResponse.json.error)
  const destinationAccount = bankResponse.json
  const categoryResponse = await request(`/api/categories?scope=family&familyId=${familyId}`, { cookie: ownerCookie })
  assert.equal(categoryResponse.response.status, 200)
  const incomeCategory = categoryResponse.json.find((category) => category.kind === 'income')
  const expenseCategory = categoryResponse.json.find((category) => category.kind === 'expense')
  assert.ok(incomeCategory && expenseCategory)

  async function createTransaction(cookie, { kind, title, amount, accountId, destinationId, categoryId, owner }) {
    const { response, json } = await request('/api/transactions', {
      method: 'POST', cookie,
      body: {
        kind, scope: 'family', familyId, title, amount, owner,
        payer: kind === 'expense' ? owner : undefined,
        sourceAccount: sourceAccount.name,
        sourceAccountId: accountId,
        destinationAccount: destinationId ? destinationAccount.name : undefined,
        destinationAccountId: destinationId,
        categoryId,
        occurredAt: '2026-09-25T12:00:00+07:00',
        clientRequestId: crypto.randomUUID(),
      },
    })
    assert.equal(response.status, 201, json.error)
    return json
  }

  const income = await createTransaction(ownerCookie, { kind: 'income', title: 'รายรับทดสอบ', amount: 1000, accountId: sourceAccount.id, categoryId: incomeCategory.id, owner: 'ครอบครัว' })
  const expense = await createTransaction(ownerCookie, { kind: 'expense', title: 'รายจ่ายทดสอบ', amount: 200, accountId: sourceAccount.id, categoryId: expenseCategory.id, owner: 'ครอบครัว' })
  const transfer = await createTransaction(ownerCookie, { kind: 'transfer', title: 'โอนทดสอบ', amount: 100, accountId: sourceAccount.id, destinationId: destinationAccount.id, owner: 'ครอบครัว' })
  const memberExpense = await createTransaction(memberCookie, { kind: 'expense', title: 'สมาชิกจ่ายทดสอบ', amount: 50, accountId: sourceAccount.id, categoryId: expenseCategory.id, owner: 'สมาชิกทดสอบ' })

  assert.equal(income.kind, 'income')
  assert.equal(expense.kind, 'expense')
  assert.equal(transfer.kind, 'transfer')
  const summaryPath = `/api/transactions/summary?scope=family&familyId=${familyId}&dateFrom=2026-09-01&dateTo=2026-09-30`
  const summary = await request(summaryPath, { cookie: ownerCookie })
  assert.equal(summary.response.status, 200)
  assert.equal(summary.json.income, 1000)
  assert.equal(summary.json.expense, 250)
  assert.equal(Object.hasOwn(summary.json, 'net'), false)

  const balance = await request(`/api/accounts?scope=family&familyId=${familyId}`, { cookie: ownerCookie })
  assert.equal(balance.response.status, 200)
  assert.equal(balance.json.find((account) => account.id === sourceAccount.id).balance, 650)
  assert.equal(balance.json.find((account) => account.id === destinationAccount.id).balance, 100)

  const memberSummary = await request(summaryPath, { cookie: memberCookie })
  assert.equal(memberSummary.response.status, 200)
  const deniedEdit = await request(`/api/transactions/${expense.id}`, { method: 'PATCH', cookie: memberCookie, body: { title: 'ห้ามแก้รายการคนอื่น' } })
  assert.equal(deniedEdit.response.status, 404)
  const outsiderSummary = await request(summaryPath, { cookie: outsiderCookie })
  assert.ok([403, 404].includes(outsiderSummary.response.status))

  const personalAccounts = await request('/api/accounts?scope=personal', { cookie: memberCookie })
  const personalCategories = await request('/api/categories?scope=personal', { cookie: memberCookie })
  assert.equal(personalAccounts.response.status, 200)
  assert.equal(personalCategories.response.status, 200)
  const personalCash = personalAccounts.json.find((account) => account.accountType === 'cash')
  const personalExpenseCategory = personalCategories.json.find((category) => category.kind === 'expense')
  const personalExpense = await request('/api/transactions', {
    method: 'POST', cookie: memberCookie,
    body: {
      kind: 'expense', scope: 'personal', title: 'ข้อมูลส่วนตัวทดสอบ', amount: 25,
      owner: 'สมาชิกทดสอบ', payer: 'สมาชิกทดสอบ', sourceAccount: personalCash.name,
      sourceAccountId: personalCash.id, categoryId: personalExpenseCategory.id,
      occurredAt: '2026-09-25T12:00:00+07:00', clientRequestId: crypto.randomUUID(),
    },
  })
  assert.equal(personalExpense.response.status, 201, personalExpense.json.error)

  const deleted = await request('/api/auth/delete-account', { method: 'POST', cookie: memberCookie, body: { password, confirmation: 'ลบบัญชี' } })
  assert.equal(deleted.response.status, 200, deleted.json.error)
  const revokedSession = await request('/api/auth/me', { cookie: memberCookie })
  assert.equal(revokedSession.response.status, 401)

  const [[member]] = await database.execute('SELECT deleted_at, display_name FROM users WHERE id = ?', [memberId])
  assert.ok(member.deleted_at)
  assert.equal(member.display_name, 'สมาชิกที่ลบบัญชี')
  const [privateRows] = await database.execute('SELECT id FROM transactions WHERE id = ?', [personalExpense.json.id])
  assert.equal(privateRows.length, 0)
  const [familyRows] = await database.execute('SELECT amount, owner_name, payer_name, recorder_name FROM transactions WHERE id = ?', [memberExpense.id])
  assert.equal(familyRows.length, 1)
  assert.equal(Number(familyRows[0].amount), 50)
  assert.equal(familyRows[0].owner_name, 'สมาชิกที่ลบบัญชี')
  assert.equal(familyRows[0].payer_name, 'สมาชิกที่ลบบัญชี')
  assert.equal(familyRows[0].recorder_name, 'สมาชิกที่ลบบัญชี')
  assert.equal((await request(summaryPath, { cookie: ownerCookie })).json.expense, 250)
})

test.after(async () => database.end())
