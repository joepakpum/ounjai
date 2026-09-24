import http from 'node:http'
import mysql from 'mysql2/promise'

const port = Number(process.env.PORT || 3000)
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  database: process.env.MYSQL_DATABASE || 'saving',
  user: process.env.MYSQL_USER || 'saving_app',
  password: process.env.MYSQL_PASSWORD || 'saving-local-app',
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
  decimalNumbers: true,
  dateStrings: true,
  timezone: '+07:00',
})

function send(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(payload))
}

async function readJson(request) {
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (body.length > 32_000) throw new Error('Request body is too large')
  }
  return body ? JSON.parse(body) : {}
}

function mapTransaction(row) {
  const occurredAt = String(row.occurred_at).replace(' ', 'T') + '+07:00'
  const account = row.kind === 'transfer'
    ? `${row.source_account} → ${row.destination_account}`
    : row.source_account
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
  if (request.method === 'GET' && url.pathname === '/api/health') {
    await pool.query('SELECT 1')
    return send(response, 200, { ok: true, database: 'mysql' })
  }

  if (request.method === 'GET' && url.pathname === '/api/transactions') {
    const [rows] = await pool.query(`
      SELECT id, title, category, kind, amount, scope, occurred_at,
             source_account, destination_account, owner_name, payer_name,
             recorder_name, icon
      FROM transactions
      ORDER BY occurred_at DESC, id DESC
      LIMIT 500
    `)
    return send(response, 200, rows.map(mapTransaction))
  }

  if (request.method === 'POST' && url.pathname === '/api/transactions') {
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
    const recorder = String(body.recorder || '').trim()
    const icon = String(body.icon || '🧾').slice(0, 12)

    if (!['income', 'expense', 'transfer'].includes(kind)) return send(response, 400, { error: 'ประเภทรายการไม่ถูกต้อง' })
    if (!['family', 'personal'].includes(scope)) return send(response, 400, { error: 'ขอบเขตรายการไม่ถูกต้อง' })
    if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100) return send(response, 400, { error: 'จำนวนเงินต้องมากกว่าศูนย์และไม่เกินสองตำแหน่งทศนิยม' })
    if (!title || !category || !sourceAccount || !owner || !recorder) return send(response, 400, { error: 'กรอกข้อมูลรายการให้ครบก่อนบันทึก' })
    if (kind === 'transfer' && (!destinationAccount || destinationAccount === sourceAccount)) return send(response, 400, { error: 'เลือกบัญชีต้นทางและปลายทางให้ต่างกัน' })

    const [result] = await pool.execute(`
      INSERT INTO transactions
        (title, category, kind, amount, scope, occurred_at, source_account,
         destination_account, owner_name, payer_name, recorder_name, icon)
      VALUES (?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?)
    `, [title, category, kind, amount, scope, sourceAccount, destinationAccount, owner, payer || null, recorder, icon])
    const [rows] = await pool.execute(`
      SELECT id, title, category, kind, amount, scope, occurred_at,
             source_account, destination_account, owner_name, payer_name,
             recorder_name, icon
      FROM transactions WHERE id = ?
    `, [result.insertId])
    return send(response, 201, mapTransaction(rows[0]))
  }

  return send(response, 404, { error: 'ไม่พบเส้นทางนี้' })
}

const server = http.createServer((request, response) => {
  handle(request, response).catch((error) => {
    console.error(error)
    if (!response.headersSent) send(response, 500, { error: 'เกิดข้อผิดพลาดระหว่างบันทึกข้อมูล' })
    else response.end()
  })
})

server.listen(port, '0.0.0.0', () => console.log(`saving API listening on ${port}`))

async function shutdown() {
  server.close()
  await pool.end()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
