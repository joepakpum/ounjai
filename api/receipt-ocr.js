const thaiDigits = new Map(Array.from('๐๑๒๓๔๕๖๗๘๙', (digit, value) => [digit, String(value)]))
const normalizeDigits = (value) => Array.from(value, (character) => thaiDigits.get(character) ?? character).join('')

const transferMarkers = /โอนเงินสำเร็จ|รายการโอน|สลิปโอน|ผู้โอน|ผู้รับโอน|บัญชีผู้รับ|ปลายทาง|transfer\s*(?:successful|slip|amount)|prompt\s*pay|พร้อมเพย์/i
const transferAmountLabel = /ยอดเงินที่โอน|ยอดโอน|จำนวนเงินที่โอน|จำนวนที่โอน|จำนวนเงิน|transfer\s*amount|amount\s*transferred/i
const feeMarker = /ค่าธรรมเนียม|ค่าบริการ|fee|charge/i
const totalMarker = /ยอดสุทธิ|ยอดชำระ|รวมทั้งสิ้น|ยอดรวม|grand\s*total|total\s*(?:amount|due)?/i

const monthNumbers = new Map([
  ['ม.ค.', 1], ['มกราคม', 1], ['jan', 1], ['january', 1],
  ['ก.พ.', 2], ['กุมภาพันธ์', 2], ['feb', 2], ['february', 2],
  ['มี.ค.', 3], ['มีนาคม', 3], ['mar', 3], ['march', 3],
  ['เม.ย.', 4], ['เมษายน', 4], ['apr', 4], ['april', 4],
  ['พ.ค.', 5], ['พฤษภาคม', 5], ['may', 5],
  ['มิ.ย.', 6], ['มิถุนายน', 6], ['jun', 6], ['june', 6],
  ['ก.ค.', 7], ['กรกฎาคม', 7], ['jul', 7], ['july', 7],
  ['ส.ค.', 8], ['สิงหาคม', 8], ['aug', 8], ['august', 8],
  ['ก.ย.', 9], ['กันยายน', 9], ['sep', 9], ['sept', 9], ['september', 9],
  ['ต.ค.', 10], ['ตุลาคม', 10], ['oct', 10], ['october', 10],
  ['พ.ย.', 11], ['พฤศจิกายน', 11], ['nov', 11], ['november', 11],
  ['ธ.ค.', 12], ['ธันวาคม', 12], ['dec', 12], ['december', 12],
])

function normalizeYear(rawYear) {
  let year = Number(rawYear)
  if (year < 100) year += 2500
  if (year > 2400) year -= 543
  if (year < 2000 || year > 2200) return null
  return year
}

function asDate(yearText, monthText, dayText) {
  const year = normalizeYear(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function parseDate(lines) {
  const labeled = lines.find((line) => /วันที่|วันทำรายการ|transaction\s*date|date\s*:/i.test(line))
  const candidates = labeled ? [labeled, ...lines.filter((line) => line !== labeled)] : lines
  for (const rawLine of candidates) {
    const line = normalizeDigits(rawLine)
    const iso = line.match(/\b(20\d{2}|25\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/)
    if (iso) {
      const date = asDate(iso[1], iso[2], iso[3])
      if (date) return date
    }
    const numeric = line.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/)
    if (numeric) {
      const date = asDate(numeric[3], numeric[2], numeric[1])
      if (date) return date
    }
    const named = line.match(/\b(\d{1,2})\s+([\p{L}.]+)\s+(\d{2,4})\b/u)
    if (named) {
      const monthName = named[2].toLowerCase()
      const month = [...monthNumbers].find(([name]) => name.toLowerCase() === monthName)?.[1]
      if (month) {
        const date = asDate(named[3], month, named[1])
        if (date) return date
      }
    }
  }
  return null
}

function amountsOnLine(line) {
  const normalized = normalizeDigits(line)
  return [...normalized.matchAll(/(?:฿|บาท)?\s*(\d{1,3}(?:,\d{3})+|\d{1,9})(?:\.(\d{2}))?\s*(?:บาท)?/g)]
    .map((match) => Number(`${match[1].replaceAll(',', '')}.${match[2] || '00'}`))
    .filter((amount) => Number.isFinite(amount) && amount > 0)
}

function parseAmount(lines, isTransfer) {
  const labeled = lines.filter((line) => (isTransfer ? transferAmountLabel.test(line) : totalMarker.test(line)) && !feeMarker.test(line))
  const candidates = labeled.flatMap(amountsOnLine)
  if (candidates.length === 1) return candidates[0]
  if (candidates.length > 1) return null
  for (let index = 0; index < lines.length; index += 1) {
    if (!(isTransfer ? transferAmountLabel : totalMarker).test(lines[index]) || feeMarker.test(lines[index])) continue
    const nextLineAmounts = amountsOnLine(lines[index + 1] || '')
    if (nextLineAmounts.length === 1) return nextLineAmounts[0]
  }
  return null
}

function parseRecipient(lines) {
const recipientLine = /ชื่อบัญชีผู้รับ|ชื่อผู้รับ|ผู้รับโอน|ผู้รับ|บัญชีปลายทาง|ปลายทาง|recipient|beneficiary|\bto\b/i
  const excluded = /ธนาคาร|bank|เลขบัญชี|account|วันที่|date|จำนวนเงิน|ยอดโอน|ค่าธรรมเนียม|fee/i
  for (let index = 0; index < lines.length; index += 1) {
    if (!recipientLine.test(lines[index])) continue
    const sameLine = lines[index].replace(/.*?(?:ชื่อบัญชีผู้รับ|ชื่อผู้รับ|ผู้รับโอน|ผู้รับ|บัญชีปลายทาง|ปลายทาง|recipient|beneficiary|\bto\b)\s*[:：-]?\s*/i, '').trim()
    const candidate = sameLine || lines.slice(index + 1).find((line) => line && !recipientLine.test(line) && !excluded.test(line))
    const cleaned = candidate?.replace(/\s{2,}/g, ' ').trim()
    if (cleaned && cleaned.length <= 100 && /[\p{L}]/u.test(cleaned) && !excluded.test(cleaned)) return cleaned
  }
  return null
}

function parseMerchant(lines) {
  const reject = /^(?:ใบเสร็จ|ใบกำกับภาษี|receipt|tax invoice|ใบเสร็จรับเงิน|ขอบคุณ|thank you|วันที่|เวลา|date|time|ยอด|รวม|เลขที่|โทร|tel|www\.)/i
  return lines.find((line) => line.length >= 3 && line.length <= 120 && !reject.test(line) && !/[\d]{5,}/.test(line) && /[\p{L}]/u.test(line))?.slice(0, 120) || null
}

export function parseReceiptOcr(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const joined = lines.join('\n')
  const transferSignals = (joined.match(/โอนเงินสำเร็จ|รายการโอน|สลิปโอน|ผู้โอน|ผู้รับโอน|ผู้รับ|ยอดโอน|prompt\s*pay|พร้อมเพย์|transfer/gi) || []).length
  const isTransfer = transferMarkers.test(joined) && transferSignals >= 1
  const merchantCandidate = parseMerchant(lines)
  const documentType = isTransfer ? 'transfer_slip' : merchantCandidate ? 'receipt' : 'unknown'
  const merchant = documentType === 'receipt' ? merchantCandidate : null
  const category = documentType === 'receipt'
    ? (/restaurant|อาหาร|cafe|กาแฟ|food|ข้าว/i.test(joined) ? 'อาหาร' : /taxi|grab|เดินทาง|รถไฟ|fuel|น้ำมัน/i.test(joined) ? 'เดินทาง' : /pharmacy|hospital|ยา|คลินิก|สุขภาพ/i.test(joined) ? 'สุขภาพ' : null)
    : null
  return {
    documentType,
    merchant,
    recipient: isTransfer ? parseRecipient(lines) : null,
    amount: parseAmount(lines, isTransfer),
    date: parseDate(lines),
    category,
    rawText: joined.slice(0, 8000),
  }
}

export function scoreReceiptOcr(suggestion) {
  return (suggestion.documentType === 'transfer_slip' ? 4 : 0)
    + (suggestion.amount == null ? 0 : 3)
    + (suggestion.date == null ? 0 : 2)
    + (suggestion.recipient || suggestion.merchant ? 1 : 0)
    + Math.min(suggestion.rawText.length, 1000) / 1000
}
