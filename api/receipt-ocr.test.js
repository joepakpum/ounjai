import test from 'node:test'
import assert from 'node:assert/strict'
import { parseReceiptOcr, scoreReceiptOcr } from './receipt-ocr.js'

test('extracts clearly labeled transfer-slip fields without treating the bank as a merchant', () => {
  const result = parseReceiptOcr(`ธนาคารทดสอบ\nโอนเงินสำเร็จ\nผู้โอน นายทดสอบ\nผู้รับ นางตัวอย่าง\nวันที่ 25 ก.ย. 2569 เวลา 13:20\nจำนวนเงิน 1,250.00 บาท\nค่าธรรมเนียม 0.00 บาท`)
  assert.equal(result.documentType, 'transfer_slip')
  assert.equal(result.merchant, null)
  assert.equal(result.recipient, 'นางตัวอย่าง')
  assert.equal(result.amount, 1250)
  assert.equal(result.date, '2026-09-25')
  assert.equal(result.category, null)
})

test('does not guess a transfer amount from an unlabeled fee or miscellaneous number', () => {
  const result = parseReceiptOcr('โอนเงินสำเร็จ\nผู้รับ นางตัวอย่าง\nค่าธรรมเนียม 25.00 บาท\nเลขอ้างอิง 123456')
  assert.equal(result.documentType, 'transfer_slip')
  assert.equal(result.amount, null)
  assert.equal(result.recipient, 'นางตัวอย่าง')
})

test('recognizes Thai digits and Buddhist-year numeric dates', () => {
  const result = parseReceiptOcr('รายการโอน\nผู้รับ: นายสมมติ\nวันที่ ๒๕/๐๙/๒๕๖๙\nยอดโอน ๑,๒๕๐.๐๐ บาท')
  assert.equal(result.documentType, 'transfer_slip')
  assert.equal(result.amount, 1250)
  assert.equal(result.date, '2026-09-25')
})

test('uses labeled total fields on receipts and keeps the raw OCR separately', () => {
  const result = parseReceiptOcr('7-ELEVEN\nอาหารและเครื่องดื่ม\nวันที่ 25/09/2569\nยอดสุทธิ 165.00 บาท')
  assert.equal(result.documentType, 'receipt')
  assert.equal(result.merchant, '7-ELEVEN')
  assert.equal(result.amount, 165)
  assert.equal(result.date, '2026-09-25')
  assert.match(result.rawText, /ยอดสุทธิ/)
})

test('leaves uninterpretable OCR unclassified instead of using it as a merchant suggestion', () => {
  const result = parseReceiptOcr('### @@ 000000 %%')
  assert.equal(result.documentType, 'unknown')
  assert.equal(result.merchant, null)
  assert.equal(result.amount, null)
  assert.equal(result.date, null)
})

test('prefers OCR candidates with explicit structured transfer fields', () => {
  const structured = parseReceiptOcr('โอนเงินสำเร็จ\nผู้รับ นายทดสอบ\nจำนวนเงิน 50.00 บาท')
  const raw = parseReceiptOcr('เอกสารประกอบ\nข้อความ OCR จำนวนมาก')
  assert.ok(scoreReceiptOcr(structured) > scoreReceiptOcr(raw))
})
