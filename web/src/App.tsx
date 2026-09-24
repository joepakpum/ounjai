import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent, ReactNode } from 'react'
import {
  ArrowDownLeft, ArrowDownRight, ArrowLeftRight, ArrowUpRight, Banknote,
  Bell, CalendarDays, Check, ChevronDown, ChevronRight, CircleHelp, CreditCard,
  Download, FileImage, Landmark, LayoutDashboard, ListFilter, LogOut, Plus,
  History, MoreHorizontal, RotateCcw, Search, Settings2, SlidersHorizontal, Sparkles, Tag, TrendingUp, Trash2, Upload,
  Users, Wallet, X,
} from 'lucide-react'
import './App.css'

type Kind = 'expense' | 'income' | 'transfer'
type Scope = 'family' | 'personal'
type AuthUser = { id: number; email: string; displayName: string; systemRole: 'user' | 'superadmin'; families: { id: number; name: string; role: 'owner' | 'member' }[] }
type FamilyInfo = AuthUser['families'][number] & { members: { id: number; displayName: string; email: string; role: 'owner' | 'member'; joinedAt: string }[]; invitations: { id: number; expiresAt: string }[] }
type Transaction = {
  id: number; title: string; category: string; kind: Kind; amount: number
  date: string; occurredAt: string; account: string; owner: string; payer?: string; recorder: string; icon: string; scope: Scope
  categoryId: number | null; sourceAccountId: number | null; destinationAccountId: number | null
  receiptId?: number | null
  allocations?: { categoryId: number | null; category: string | null; ownerUserId: number | null; ownerName: string; amount: number }[]
}
type TransactionPageInfo = { page: number; pageSize: number; total: number; totalPages: number }
type TransactionPageResult = { rows: Transaction[] } & TransactionPageInfo
type ReportSummary = { income: number; expense: number; categories: { name: string; amount: number }[]; expenseCategories: { name: string; amount: number }[]; owners: { name: string; amount: number }[]; accounts: { name: string; amount: number }[] }
type AuditHistory = { id: number; action: 'created' | 'updated' | 'trashed' | 'restored' | 'allocations_updated'; before: { title?: string; category?: string; amount?: string } | null; after: { title?: string; category?: string; amount?: string } | null; actor: string; createdAt: string }
type MoneyAccount = { id: number; ownerType: 'user' | 'family'; ownerUserId: number | null; familyId: number | null; name: string; accountType: 'cash' | 'bank' | 'other'; openingBalance: number; openingDate: string; balance: number }
type Category = { id: number; ownerType: 'user' | 'family'; ownerRef: number; kind: 'income' | 'expense'; name: string; icon: string; isDefault: boolean }
type TransferRecipientAccount = { id: number; ownerName: string; accountType: 'cash' | 'bank' | 'other' }
type Budget = { id: number; categoryId: number; category: string; icon: string; amount: number; spent: number; periodType: 'monthly' | 'custom'; cycleStartDay: number; periodStart: string | null; periodEnd: string | null; alertPercent: number }
type BudgetMovement = { id: number; fromCategory: string; toCategory: string; amount: number; note: string | null; movedBy: string; createdAt: string }
type ReceiptSuggestion = { merchant: string | null; amount: number | null; date: string | null; category: string | null; rawText: string }
type Allocation = { id?: number; categoryId: number | null; category: string | null; ownerUserId: number | null; ownerName: string; amount: number }
type AllocationDraft = { categoryId: string; owner: string; amount: string }
type RecurringRule = { id: number; scope: Scope; familyId: number | null; kind: Kind; title: string; categoryId: number | null; category: string | null; amount: number; sourceAccountId: number; destinationAccountId: number | null; owner: string; payer: string | null; frequency: 'weekly' | 'monthly' | 'yearly'; intervalCount: number; dayOfMonth: number | null; startsOn: string; endsOn: string | null; paused: boolean; createdBy: string; canManage: boolean }
type RecurringReview = { id: number; cycleKey: string; reviewDate: string; transaction: { ruleId: number; kind: Kind; title: string; categoryId: number | null; amount: number; sourceAccountId: number; destinationAccountId: number | null; owner: string; payer: string | null; icon: string; occurredAt: string }; createdBy: string; canManage: boolean }
type RecurringDraft = { id: number | null; scope: Scope; familyId: number | null; kind: Kind; title: string; amount: string; categoryId: string; sourceAccountId: string; destinationAccountId: string; frequency: 'weekly' | 'monthly' | 'yearly'; intervalCount: string; dayOfMonth: string; startsOn: string; endsOn: string; owner: string; payer: string }
type RecurringReviewDraft = { review: RecurringReview; title: string; amount: string; date: string }
type AccountEditDraft = { account: MoneyAccount; name: string; accountType: MoneyAccount['accountType']; openingBalance: string; openingDate: string }
type CategoryEditDraft = { id: number | null; kind: Category['kind']; name: string }
type BudgetEditDraft = { id: number | null; categoryId: string; amount: string; periodType: Budget['periodType']; cycleStartDay: string; periodStart: string; periodEnd: string; alertPercent: string }
type BudgetMoveDraft = { fromBudgetId: string; toBudgetId: string; amount: string }

const formatMoney = (value: number) => new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
const bangkokToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const monthStart = (date: string) => `${date.slice(0, 7)}-01`

async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const unavailable = (status: number) => new Response(JSON.stringify({ error: 'เชื่อมต่อระบบไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่' }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
  let response: Response
  try { response = await globalThis.fetch(input, init) }
  catch { return unavailable(503) }
  if (response.headers.get('content-type')?.toLowerCase().includes('application/json')) return response
  return unavailable(response.status >= 400 ? response.status : 502)
}

function App() {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [transactionPage, setTransactionPage] = useState(1)
  const [transactionPageInfo, setTransactionPageInfo] = useState<TransactionPageInfo>({ page: 1, pageSize: 30, total: 0, totalPages: 0 })
  const [reportSummary, setReportSummary] = useState<ReportSummary | null>(null)
  const [transactionsLoading, setTransactionsLoading] = useState(false)
  const [reportLoading, setReportLoading] = useState(false)
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [authMessage, setAuthMessage] = useState('')
  const [resetToken, setResetToken] = useState('')
  const [inviteToken, setInviteToken] = useState('')
  const [familyInfo, setFamilyInfo] = useState<FamilyInfo[]>([])
  const [moneyAccounts, setMoneyAccounts] = useState<MoneyAccount[]>([])
  const [categoryItems, setCategoryItems] = useState<Category[]>([])
  const [transferRecipientAccounts, setTransferRecipientAccounts] = useState<TransferRecipientAccount[]>([])
  const [budgets, setBudgets] = useState<Budget[]>([])
  const [budgetMovements, setBudgetMovements] = useState<BudgetMovement[]>([])
  const [recurringRules, setRecurringRules] = useState<RecurringRule[]>([])
  const [recurringReviews, setRecurringReviews] = useState<RecurringReview[]>([])
  const [recurringDraft, setRecurringDraft] = useState<RecurringDraft | null>(null)
  const [recurringReviewDraft, setRecurringReviewDraft] = useState<RecurringReviewDraft | null>(null)
  const [accountEditDraft, setAccountEditDraft] = useState<AccountEditDraft | null>(null)
  const [categoryEditDraft, setCategoryEditDraft] = useState<CategoryEditDraft | null>(null)
  const [budgetEditDraft, setBudgetEditDraft] = useState<BudgetEditDraft | null>(null)
  const [budgetMoveDraft, setBudgetMoveDraft] = useState<BudgetMoveDraft | null>(null)
  const [financeVersion, setFinanceVersion] = useState(0)
  const [activeFamilyId, setActiveFamilyId] = useState<number | null>(null)
  const [inviteLink, setInviteLink] = useState('')
  const [apiStatus, setApiStatus] = useState<'connecting' | 'connected' | 'offline'>('connecting')
  const [scope, setScope] = useState<Scope>('family')
  const [page, setPage] = useState('ภาพรวม')
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false)
  const [range, setRange] = useState('เดือนนี้')
  const [dateFrom, setDateFrom] = useState(monthStart(bangkokToday()))
  const [dateTo, setDateTo] = useState(bangkokToday())
  const [search, setSearch] = useState('')
  const [kindFilter, setKindFilter] = useState('ทั้งหมด')
  const [modal, setModal] = useState(false)
  const [editingTransactionId, setEditingTransactionId] = useState<number | null>(null)
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID())
  const [historyEntries, setHistoryEntries] = useState<AuditHistory[] | null>(null)
  const [confirmation, setConfirmation] = useState<{ message: string; onConfirm: () => Promise<void> } | null>(null)
  const [splitTransaction, setSplitTransaction] = useState<Transaction | null>(null)
  const [splitRows, setSplitRows] = useState<AllocationDraft[]>([])
  const [toast, setToast] = useState('')
  const [filePreview, setFilePreview] = useState('')
  const [selectedReceipt, setSelectedReceipt] = useState<File | null>(null)
  const [receiptId, setReceiptId] = useState<number | null>(null)
  const [receiptSuggestion, setReceiptSuggestion] = useState<ReceiptSuggestion | null>(null)
  const [receiptOcrAvailable, setReceiptOcrAvailable] = useState(true)
  const [formKind, setFormKind] = useState<Kind>('expense')
  const [formScope, setFormScope] = useState<Scope>('family')
  const [formAmount, setFormAmount] = useState('')
  const [formTitle, setFormTitle] = useState('')
  const [formDate, setFormDate] = useState(bangkokToday())
  const [formCategory, setFormCategory] = useState('อาหาร')
  const [formCategoryId, setFormCategoryId] = useState('')
  const [formAccount, setFormAccount] = useState('เงินสด')
  const [formAccountId, setFormAccountId] = useState('')
  const [formDestination, setFormDestination] = useState('')
  const [formDestinationId, setFormDestinationId] = useState('')
  const [accountDialog, setAccountDialog] = useState(false)
  const [accountName, setAccountName] = useState('')
  const [accountType, setAccountType] = useState<'cash' | 'bank' | 'other'>('bank')
  const [accountOpeningBalance, setAccountOpeningBalance] = useState('0')
  const [accountOpeningDate, setAccountOpeningDate] = useState(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()))
  const [formOwner, setFormOwner] = useState('')
  const [formPayer, setFormPayer] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const receiptUploadSequence = useRef(0)
  const manuallyEditedReceiptFields = useRef({ title: false, amount: false, date: false, category: false })

  useEffect(() => {
    let active = true
    const params = new URLSearchParams(window.location.search)
    const verifyToken = params.get('verify')
    const passwordToken = params.get('reset')
    const invitationToken = params.get('invite') || ''
    if (invitationToken) setInviteToken(invitationToken)
    if (passwordToken) setResetToken(passwordToken)
    const cleanUrl = () => {
      params.delete('verify'); params.delete('reset'); params.delete('invite')
      const query = params.toString()
      window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`)
    }
    const restoreSession = async () => {
      if (verifyToken) {
        const response = await apiFetch('/api/auth/verify-email', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: verifyToken, inviteToken: invitationToken }),
        })
        const result = await response.json() as { user?: AuthUser; error?: string }
        if (active && response.ok && result.user) { setAuthUser(result.user); if (invitationToken) setInviteToken('') }
        if (active) setAuthMessage(response.ok ? 'ยืนยันอีเมลแล้ว บัญชีของคุณพร้อมใช้งาน' : result.error || 'ยืนยันอีเมลไม่สำเร็จ')
        cleanUrl()
      }
      if (!verifyToken || !active) {
        const response = await apiFetch('/api/auth/me')
        if (active && response.ok) {
          let result = await response.json() as { user: AuthUser }
          if (invitationToken) {
            const joined = await apiFetch('/api/families/invitations/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: invitationToken }) })
            const joinResult = await joined.json() as { user?: AuthUser; error?: string }
            if (joined.ok && joinResult.user) result = { user: joinResult.user }
            else if (joined.status !== 409) setAuthMessage(joinResult.error || 'เข้าร่วมครอบครัวไม่สำเร็จ')
            params.delete('invite')
            const query = params.toString()
            window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`)
            if (joined.ok || joined.status === 409) setInviteToken('')
          }
          setAuthUser(result.user)
        } else if (active && response.status >= 500) setAuthMessage('ระบบยังเชื่อมต่อไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่')
      }
      if (active) setAuthChecked(true)
    }
    restoreSession().catch(() => { if (active) setAuthChecked(true) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!authUser) { setFamilyInfo([]); return }
    apiFetch('/api/families').then((response) => response.ok ? response.json() as Promise<FamilyInfo[]> : []).then(setFamilyInfo).catch(() => setFamilyInfo([]))
  }, [authUser])

  useEffect(() => {
    if (!authUser) { setMoneyAccounts([]); setCategoryItems([]); return }
    let active = true
    const scopes = [
      { scope: 'personal', familyId: null },
      ...(activeFamilyId ? [{ scope: 'family', familyId: activeFamilyId }] : []),
    ]
    Promise.all(scopes.map(async ({ scope: selectedScope, familyId }) => {
      const query = new URLSearchParams({ scope: selectedScope })
      if (familyId) query.set('familyId', String(familyId))
      const [accountsResponse, categoriesResponse] = await Promise.all([apiFetch(`/api/accounts?${query}`), apiFetch(`/api/categories?${query}`)])
      if (!accountsResponse.ok || !categoriesResponse.ok) throw new Error('โหลดบัญชีเงินหรือหมวดหมู่ไม่สำเร็จ')
      return { accounts: await accountsResponse.json() as MoneyAccount[], categories: await categoriesResponse.json() as Category[] }
    })).then((results) => { if (active) { setMoneyAccounts(results.flatMap((result) => result.accounts)); setCategoryItems(results.flatMap((result) => result.categories)) } }).catch(() => { if (active) notify('โหลดบัญชีเงินหรือหมวดหมู่ไม่สำเร็จ') })
    return () => { active = false }
  }, [authUser, activeFamilyId, financeVersion])

  useEffect(() => {
    if (!authUser) { setBudgets([]); return }
    const query = new URLSearchParams({ scope })
    if (scope === 'family' && activeFamilyId) query.set('familyId', String(activeFamilyId))
    apiFetch(`/api/budgets?${query}`).then(async (response) => {
      if (!response.ok) throw new Error('โหลดงบประมาณไม่สำเร็จ')
      return response.json() as Promise<Budget[]>
    }).then(setBudgets).catch(() => setBudgets([]))
  }, [authUser, scope, activeFamilyId, financeVersion])

  useEffect(() => {
    if (!authUser) { setBudgetMovements([]); return }
    const query = new URLSearchParams({ scope })
    if (scope === 'family' && activeFamilyId) query.set('familyId', String(activeFamilyId))
    apiFetch(`/api/budgets/movements?${query}`).then(async (response) => {
      if (!response.ok) throw new Error('โหลดประวัติย้ายงบไม่สำเร็จ')
      return response.json() as Promise<BudgetMovement[]>
    }).then(setBudgetMovements).catch(() => setBudgetMovements([]))
  }, [authUser, scope, activeFamilyId, financeVersion])

  useEffect(() => {
    if (!authUser) { setRecurringRules([]); setRecurringReviews([]); return }
    const query = new URLSearchParams({ scope })
    if (scope === 'family' && activeFamilyId) query.set('familyId', String(activeFamilyId))
    let active = true
    const refreshRecurring = () => Promise.all([apiFetch(`/api/recurring-rules?${query}`), apiFetch(`/api/recurring-reviews?${query}`)]).then(async ([rulesResponse, reviewsResponse]) => {
      if (!rulesResponse.ok || !reviewsResponse.ok) throw new Error('โหลดรายการประจำไม่สำเร็จ')
      return [await rulesResponse.json() as RecurringRule[], await reviewsResponse.json() as RecurringReview[]] as const
    }).then(([rules, reviews]) => { if (active) { setRecurringRules(rules); setRecurringReviews(reviews) } }).catch(() => { if (active) { setRecurringRules([]); setRecurringReviews([]) } })
    void refreshRecurring()
    const refreshTimer = window.setInterval(refreshRecurring, 60_000)
    return () => { active = false; window.clearInterval(refreshTimer) }
  }, [authUser, scope, activeFamilyId, financeVersion])

  useEffect(() => {
    if (!authUser || !activeFamilyId) { setTransferRecipientAccounts([]); return }
    let active = true
    apiFetch(`/api/families/${activeFamilyId}/transfer-recipients`).then(async (response) => {
      if (!response.ok) throw new Error('โหลดบัญชีผู้รับโอนไม่สำเร็จ')
      return response.json() as Promise<TransferRecipientAccount[]>
    }).then((accounts) => { if (active) setTransferRecipientAccounts(accounts) }).catch(() => { if (active) setTransferRecipientAccounts([]) })
    return () => { active = false }
  }, [authUser, activeFamilyId, financeVersion])

  const formAccounts = useMemo(() => {
    const accounts = moneyAccounts.filter((account) => formScope === 'family' ? account.ownerType === 'family' && account.familyId === activeFamilyId || account.ownerType === 'user' && account.ownerUserId === authUser?.id : account.ownerType === 'user' && account.ownerUserId === authUser?.id)
    return formScope === 'family' ? accounts.sort((left, right) => Number(right.ownerType === 'family') - Number(left.ownerType === 'family')) : accounts
  }, [moneyAccounts, formScope, activeFamilyId, authUser])
  const formCategories = useMemo(() => categoryItems.filter((category) => category.kind === formKind && category.ownerType === (formScope === 'family' ? 'family' : 'user') && category.ownerRef === (formScope === 'family' ? activeFamilyId : authUser?.id)), [categoryItems, formKind, formScope, activeFamilyId, authUser])

  useEffect(() => {
    if (!formAccounts.some((account) => String(account.id) === formAccountId)) {
      const first = formAccounts[0]
      setFormAccountId(first ? String(first.id) : '')
      setFormAccount(first?.name || '')
    }
    const destinations = formScope === 'family' ? [...formAccounts, ...transferRecipientAccounts.map((account) => ({ ...account, ownerType: 'user' as const, ownerUserId: null, familyId: null, name: `${account.ownerName} · ${account.accountType === 'cash' ? 'เงินสด' : account.accountType === 'bank' ? 'บัญชีธนาคาร' : 'บัญชีอื่น'}`, balance: 0, openingBalance: 0, openingDate: '' }))] : formAccounts
    if (formKind === 'transfer' && !destinations.some((account) => String(account.id) === formDestinationId)) {
      const other = destinations.find((account) => String(account.id) !== formAccountId)
      setFormDestinationId(other ? String(other.id) : '')
      setFormDestination(other?.name || '')
    }
    if (formKind !== 'transfer' && !formCategories.some((category) => String(category.id) === formCategoryId)) {
      const first = formCategories[0]
      setFormCategoryId(first ? String(first.id) : '')
      setFormCategory(first?.name || '')
    }
  }, [formAccounts, formCategories, transferRecipientAccounts, formScope, formKind, formAccountId, formDestinationId, formCategoryId])

  useEffect(() => {
    if (activeFamilyId && authUser?.families.some((family) => family.id === activeFamilyId)) return
    setActiveFamilyId(authUser?.families[0]?.id ?? null)
  }, [authUser, activeFamilyId])

  useEffect(() => {
    let active = true
    if (!authUser) { setTransactions([]); setTransactionsLoading(false); setApiStatus('offline'); return () => { active = false } }
    const paginated = page === 'รายการทั้งหมด' || page === 'ถังขยะ' || page === 'ภาพรวม'
    const query = new URLSearchParams()
    if (paginated) {
      query.set('scope', scope)
      if (scope === 'family' && activeFamilyId) query.set('familyId', String(activeFamilyId))
      query.set('dateFrom', dateFrom); query.set('dateTo', dateTo)
      query.set('page', String(page === 'ภาพรวม' ? 1 : transactionPage)); query.set('pageSize', page === 'ภาพรวม' ? '5' : '30')
      if (page === 'ถังขยะ') query.set('trash', 'true')
      if (search.trim()) query.set('search', search.trim())
      const kind = kindFilter === 'รายรับ' ? 'income' : kindFilter === 'รายจ่าย' ? 'expense' : kindFilter === 'โอน' ? 'transfer' : ''
      if (kind) query.set('kind', kind)
    } else { setTransactions([]); setTransactionsLoading(false); setTransactionPageInfo({ page: 1, pageSize: 30, total: 0, totalPages: 0 }); setApiStatus('connected'); return () => { active = false } }
    const queryText = query.toString()
    setTransactionsLoading(true)
    apiFetch(paginated ? `/api/transactions/page?${queryText}` : `/api/transactions${queryText ? `?${queryText}` : ''}`)
      .then(async (response) => {
        if (!response.ok) throw new Error('โหลดรายการไม่สำเร็จ')
        return response.json() as Promise<Transaction[] | TransactionPageResult>
      })
      .then((result) => { if (active) {
        if (!Array.isArray(result)) { setTransactions(result.rows); if (page !== 'ภาพรวม') setTransactionPageInfo({ page: result.page, pageSize: result.pageSize, total: result.total, totalPages: result.totalPages }) }
        setApiStatus('connected')
      } })
      .catch(() => { if (active) setApiStatus('offline') })
      .finally(() => { if (active) setTransactionsLoading(false) })
    return () => { active = false }
  }, [authUser, scope, activeFamilyId, page, transactionPage, dateFrom, dateTo, search, kindFilter, financeVersion])

  useEffect(() => { setTransactionPage(1) }, [scope, activeFamilyId, page, dateFrom, dateTo, search, kindFilter])

  useEffect(() => {
    let active = true
    if (!authUser || !['ภาพรวม', 'รายงาน'].includes(page)) { setReportSummary(null); setReportLoading(false); return () => { active = false } }
    const query = new URLSearchParams({ scope, dateFrom, dateTo })
    if (scope === 'family' && activeFamilyId) query.set('familyId', String(activeFamilyId))
    const kind = kindFilter === 'รายรับ' ? 'income' : kindFilter === 'รายจ่าย' ? 'expense' : kindFilter === 'โอน' ? 'transfer' : ''
    if (kind) query.set('kind', kind)
    if (search.trim()) query.set('search', search.trim())
    setReportSummary(null)
    setReportLoading(true)
    apiFetch(`/api/transactions/summary?${query}`)
      .then(async (response) => {
        if (!response.ok) throw new Error('โหลดสรุปรายการไม่สำเร็จ')
        return response.json() as Promise<ReportSummary>
      })
      .then((summary) => { if (active) { setReportSummary(summary); setApiStatus('connected') } })
      .catch(() => { if (active) { setReportSummary(null); setApiStatus('offline') } })
      .finally(() => { if (active) setReportLoading(false) })
    return () => { active = false }
  }, [authUser, scope, activeFamilyId, page, dateFrom, dateTo, kindFilter, search, financeVersion])

  const rangeRows = useMemo(() => transactions.filter((item) => {
    const date = item.occurredAt.slice(0, 10)
    return date >= dateFrom && date <= dateTo
  }), [transactions, dateFrom, dateTo])

  const filtered = useMemo(() => rangeRows.filter((item) => {
    const scopeMatches = item.scope === scope
    const typeMatches = kindFilter === 'ทั้งหมด' || (kindFilter === 'รายจ่าย' && item.kind === 'expense') || (kindFilter === 'รายรับ' && item.kind === 'income') || (kindFilter === 'โอน' && item.kind === 'transfer')
    return scopeMatches && typeMatches && item.title.toLowerCase().includes(search.toLowerCase())
  }), [rangeRows, scope, kindFilter, search])

  const totals = useMemo(() => {
    const income = reportSummary?.income || 0
    const expense = reportSummary?.expense || 0
    return { income, expense, net: income - expense }
  }, [reportSummary])

  const categoryTotals = useMemo(() => {
    return (reportSummary?.expenseCategories || []).slice(0, 5).map((item) => [item.name, item.amount] as [string, number])
  }, [reportSummary])
  const budgetAlerts = budgets.filter((budget) => budget.spent >= budget.amount * budget.alertPercent / 100)

  async function exportReport() {
    const exported: Transaction[] = []
    let page = 1
    let totalPages = 1
    const kind = kindFilter === 'รายรับ' ? 'income' : kindFilter === 'รายจ่าย' ? 'expense' : kindFilter === 'โอน' ? 'transfer' : ''
    try {
      while (page <= totalPages) {
        const query = new URLSearchParams({ scope, dateFrom, dateTo, page: String(page), pageSize: '100' })
        if (scope === 'family' && activeFamilyId) query.set('familyId', String(activeFamilyId))
        if (kind) query.set('kind', kind)
        if (search.trim()) query.set('search', search.trim())
        const response = await apiFetch(`/api/transactions/page?${query}`)
        if (!response.ok) throw new Error('โหลดรายการเพื่อส่งออกไม่สำเร็จ')
        const result = await response.json() as TransactionPageResult
        exported.push(...result.rows); totalPages = result.totalPages; page += 1
      }
    } catch (error) { notify(error instanceof Error ? error.message : 'ส่งออกรายงานไม่สำเร็จ'); return }
    const escape = (value: string) => `"${value.replaceAll('"', '""')}"`
    const lines = [['วันที่', 'รายการ', 'ประเภท', 'หมวดหมู่', 'ขอบเขต', 'บัญชี', 'ผู้จ่าย', 'เจ้าของรายการ', 'จำนวนเงิน'], ...exported.map((item) => [item.occurredAt.slice(0, 10), item.title, item.kind === 'income' ? 'รายรับ' : item.kind === 'expense' ? 'รายจ่าย' : 'โอน', item.category, item.scope === 'family' ? 'ครอบครัว' : 'ส่วนตัว', item.account, item.payer || '', item.owner, String(item.amount)])]
    const csv = `\uFEFF${lines.map((line) => line.map(escape).join(',')).join('\r\n')}`
    const blobUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a'); link.href = blobUrl; link.download = `ounjai-${dateFrom}-${dateTo}.csv`; link.click(); window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000)
  }

  async function exportAccountData() {
    try {
      const response = await apiFetch('/api/account/export')
      if (!response.ok) {
        const result = await response.json() as { error?: string }
        throw new Error(result.error || 'ส่งออกข้อมูลบัญชีไม่สำเร็จ')
      }
      const blobUrl = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = blobUrl
      link.download = `ounjai-data-export-${bangkokToday()}.json`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000)
      notify('ดาวน์โหลดข้อมูลบัญชีแล้ว')
    } catch (error) { notify(error instanceof Error ? error.message : 'ส่งออกข้อมูลบัญชีไม่สำเร็จ') }
  }

  function openComposer(kind: Kind = 'expense') {
    receiptUploadSequence.current += 1
    manuallyEditedReceiptFields.current = { title: false, amount: false, date: false, category: false }
    setEditingTransactionId(null)
    setClientRequestId(crypto.randomUUID())
    setFormKind(kind); setFormScope(scope === 'family' && authUser?.families.length ? 'family' : 'personal'); setFormCategory(kind === 'income' ? 'เงินเดือน' : 'อาหาร')
    setFormAmount(''); setFormTitle(''); setFormDate(bangkokToday()); setFormAccountId(''); setFormDestinationId(''); setFilePreview(''); setSelectedReceipt(null); setReceiptId(null); setReceiptSuggestion(null); setFormOwner(authUser?.displayName || ''); setFormPayer(authUser?.displayName || ''); setModal(true)
  }

  function editTransaction(item: Transaction) {
    receiptUploadSequence.current += 1
    manuallyEditedReceiptFields.current = { title: true, amount: true, date: true, category: true }
    setEditingTransactionId(item.id)
    setFormKind(item.kind); setFormScope(item.scope); setFormCategory(item.category)
    setFormAmount(String(item.amount)); setFormTitle(item.title)
    setFormDate(item.occurredAt.slice(0, 10))
    setFormCategoryId(item.categoryId ? String(item.categoryId) : '')
    const [account, destination] = item.account.split(' → ')
    setFormAccount(account); if (destination) setFormDestination(destination)
    setFormAccountId(String(item.kind === 'income' ? item.destinationAccountId || '' : item.sourceAccountId || ''))
    setFormDestinationId(String(item.destinationAccountId || ''))
    setFormOwner(item.owner); setFormPayer(item.payer || item.recorder); setFilePreview(''); setModal(true)
  }

  function notify(message: string) {
    setToast(message); window.setTimeout(() => setToast(''), 2800)
  }

  function askConfirmation(message: string, onConfirm: () => Promise<void>) {
    setConfirmation({ message, onConfirm })
  }

  function changeFormScope(nextScope: Scope) {
    if (!authUser || formScope === nextScope) return
    receiptUploadSequence.current += 1
    if (receiptId) void apiFetch(`/api/receipts/${receiptId}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' })
    const hadReceipt = Boolean(receiptId || selectedReceipt || filePreview)
    if (filePreview) URL.revokeObjectURL(filePreview)
    setReceiptId(null); setSelectedReceipt(null); setFilePreview(''); setReceiptSuggestion(null)
    setFormScope(nextScope); setFormAccountId(''); setFormDestinationId(''); setFormOwner(authUser.displayName); setFormPayer(authUser.displayName)
    if (hadReceipt) notify('ขอบเขตเปลี่ยนแล้ว กรุณาเลือกภาพใหม่เพื่อให้สิทธิ์ภาพตรงกับรายการ')
  }

  function handleImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    if (file.size > 6 * 1024 * 1024) { notify('เลือกภาพขนาดไม่เกิน 6 MB'); event.target.value = ''; return }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { notify('รองรับภาพ JPEG, PNG หรือ WebP'); event.target.value = ''; return }
    const uploadSequence = ++receiptUploadSequence.current
    event.target.value = ''
    if (receiptId) void apiFetch(`/api/receipts/${receiptId}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' })
    setReceiptId(null)
    if (filePreview) URL.revokeObjectURL(filePreview)
    setFilePreview(URL.createObjectURL(file)); setSelectedReceipt(file); setReceiptSuggestion(null)
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const response = await apiFetch('/api/receipts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: file.name, mimeType: file.type, data: reader.result, scope: formScope, familyId: formScope === 'family' ? activeFamilyId : undefined }) })
        const result = await response.json() as { id?: number; extracted?: ReceiptSuggestion; ocrAvailable?: boolean; error?: string }
        if (!response.ok || !result.id) throw new Error(result.error || 'อัปโหลดและอ่านภาพไม่สำเร็จ')
        if (uploadSequence !== receiptUploadSequence.current) {
          await apiFetch(`/api/receipts/${result.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {})
          return
        }
        setReceiptId(result.id); setReceiptSuggestion(result.extracted || null); setReceiptOcrAvailable(Boolean(result.ocrAvailable))
        if (result.extracted?.merchant && !manuallyEditedReceiptFields.current.title) setFormTitle(result.extracted.merchant)
        if (result.extracted?.amount && !manuallyEditedReceiptFields.current.amount) setFormAmount(String(result.extracted.amount))
        if (result.extracted?.date && !manuallyEditedReceiptFields.current.date) setFormDate(result.extracted.date)
        if (result.extracted?.category && !manuallyEditedReceiptFields.current.category) {
          const category = formCategories.find((item) => item.name === result.extracted?.category)
          if (category) { setFormCategory(category.name); setFormCategoryId(String(category.id)) }
        }
        if (!result.ocrAvailable) notify('บันทึกภาพแล้ว แต่บริการ OCR ยังไม่พร้อม กรุณากรอกข้อมูลตรวจสอบเอง')
        else if (!result.extracted?.rawText) notify('สแกนภาพแล้วแต่ยังอ่านข้อมูลไม่ได้ กรุณากรอกข้อมูลเอง')
      } catch (error) {
        if (uploadSequence !== receiptUploadSequence.current) return
        notify(error instanceof Error ? error.message : 'อัปโหลดภาพไม่สำเร็จ'); setSelectedReceipt(null); setFilePreview('')
      }
    }
    reader.onerror = () => { if (uploadSequence === receiptUploadSequence.current) notify('อ่านไฟล์ภาพไม่สำเร็จ') }
    reader.readAsDataURL(file)
  }

  async function closeComposer(preserveReceipt = false) {
    receiptUploadSequence.current += 1
    const receiptToDelete = !preserveReceipt ? receiptId : null
    const previewToRevoke = filePreview
    setModal(false); setSelectedReceipt(null); setReceiptId(null); setReceiptSuggestion(null); setFilePreview('')
    if (previewToRevoke) URL.revokeObjectURL(previewToRevoke)
    if (receiptToDelete) await apiFetch(`/api/receipts/${receiptToDelete}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {})
  }

  async function saveTransaction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const amount = Number(formAmount.replaceAll(',', ''))
    if (!amount || amount <= 0) return
    const title = formTitle.trim() || (formKind === 'income' ? 'รายรับใหม่' : formKind === 'transfer' ? 'รายการโอน' : 'รายจ่ายใหม่')
    const sourceAccountRecord = formAccounts.find((account) => String(account.id) === formAccountId)
    const destinationAccountRecord = formAccounts.find((account) => String(account.id) === formDestinationId)
    const body = {
      title, category: formKind === 'transfer' ? 'โอนเงิน' : formCategory,
      clientRequestId,
      categoryId: formKind === 'transfer' ? undefined : Number(formCategoryId),
      kind: formKind, amount, scope: formScope, sourceAccount: sourceAccountRecord?.name || formAccount,
      occurredAt: `${formDate}T12:00:00+07:00`,
      sourceAccountId: Number(formAccountId) || undefined,
      destinationAccount: destinationAccountRecord?.name || formDestination,
      destinationAccountId: formKind === 'income' ? Number(formAccountId) || undefined : formKind === 'transfer' ? Number(formDestinationId) || undefined : undefined,
      owner: formOwner,
      payer: formKind === 'expense' ? formPayer : undefined, recorder: authUser?.displayName,
      familyId: formScope === 'family' ? activeFamilyId : undefined,
      icon: formKind === 'income' ? '💰' : formKind === 'transfer' ? '↗' : '🧾',
    }
    try {
      const response = await apiFetch(editingTransactionId ? `/api/transactions/${editingTransactionId}` : '/api/transactions', {
        method: editingTransactionId ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      const saved = await response.json() as Transaction | { error?: string }
      if (!response.ok || !('id' in saved)) throw new Error('error' in saved ? saved.error : 'บันทึกรายการไม่สำเร็จ')
      let receiptAttached = false
      if (receiptId) {
        const attached = await apiFetch(`/api/receipts/${receiptId}/attach`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transactionId: saved.id }) })
        receiptAttached = attached.ok
        if (!receiptAttached) notify('บันทึกรายการแล้ว แต่แนบภาพไม่สำเร็จ')
      }
      setTransactions((items) => editingTransactionId ? items.map((item) => item.id === saved.id ? saved : item) : [saved, ...items])
      setApiStatus('connected'); setFinanceVersion((value) => value + 1); await closeComposer(receiptAttached); setEditingTransactionId(null); setClientRequestId(crypto.randomUUID()); notify(editingTransactionId ? 'แก้ไขรายการแล้ว' : 'บันทึกลง MySQL แล้ว')
    } catch (error) {
      setApiStatus('offline')
      notify(error instanceof Error ? error.message : 'เชื่อมต่อฐานข้อมูลไม่สำเร็จ')
    }
  }

  function trashTransaction(item: Transaction) {
    askConfirmation(`ย้าย “${item.title}” ไปถังขยะหรือไม่?`, async () => {
    const response = await apiFetch(`/api/transactions/${item.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' })
    const result = await response.json() as { error?: string }
    if (!response.ok) return notify(result.error || 'ย้ายรายการไปถังขยะไม่สำเร็จ')
    setTransactions((items) => items.filter((current) => current.id !== item.id)); setFinanceVersion((value) => value + 1); notify('ย้ายรายการไปถังขยะแล้ว')
    })
  }

  async function restoreTransaction(item: Transaction) {
    const response = await apiFetch(`/api/transactions/${item.id}/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const result = await response.json() as { transaction?: Transaction; error?: string }
    if (!response.ok) return notify(result.error || 'กู้คืนรายการไม่สำเร็จ')
    setTransactions((items) => items.filter((current) => current.id !== item.id)); setFinanceVersion((value) => value + 1); notify('กู้คืนรายการแล้ว')
  }

  function deleteReceipt(item: Transaction) {
    if (!item.receiptId) return
    askConfirmation('ลบภาพสลิปที่แนบกับรายการนี้หรือไม่?', async () => {
    const response = await apiFetch(`/api/receipts/${item.receiptId}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' })
    const result = await response.json() as { error?: string }
    if (!response.ok) return notify(result.error || 'ลบภาพสลิปไม่สำเร็จ')
    setTransactions((items) => items.map((current) => current.id === item.id ? { ...current, receiptId: null } : current)); notify('ลบภาพสลิปแล้ว')
    })
  }

  async function saveMoneyAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const response = await apiFetch('/api/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope, familyId: scope === 'family' ? activeFamilyId : undefined, name: accountName.trim(), accountType, openingBalance: Number(accountOpeningBalance), openingDate: accountOpeningDate }) })
    const result = await response.json() as { error?: string }
    if (!response.ok) return notify(result.error || 'สร้างบัญชีเงินไม่สำเร็จ')
    setFinanceVersion((value) => value + 1); setAccountDialog(false); setAccountName(''); setAccountOpeningBalance('0'); notify('เพิ่มบัญชีเงินแล้ว')
  }

  function editMoneyAccount(account: MoneyAccount) {
    setAccountEditDraft({ account, name: account.name, accountType: account.accountType, openingBalance: String(account.openingBalance), openingDate: account.openingDate.slice(0, 10) })
  }

  async function saveMoneyAccountEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!accountEditDraft) return
    const { account, name, accountType, openingBalance, openingDate } = accountEditDraft
    const response = await apiFetch(`/api/accounts/${account.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.trim(), openingBalance: Number(openingBalance), openingDate, accountType }) })
    const result = await response.json() as { error?: string }
    if (!response.ok) return notify(result.error || 'แก้ไขบัญชีเงินไม่สำเร็จ')
    setAccountEditDraft(null); setFinanceVersion((value) => value + 1); notify('แก้ไขบัญชีเงินแล้ว')
  }

  function archiveMoneyAccount(account: MoneyAccount) {
    askConfirmation(`ปิดบัญชี “${account.name}” หรือไม่? ประวัติเดิมจะยังอยู่`, async () => {
    const response = await apiFetch(`/api/accounts/${account.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' })
    const result = await response.json() as { error?: string }
    if (!response.ok) return notify(result.error || 'ปิดบัญชีเงินไม่สำเร็จ')
    setFinanceVersion((value) => value + 1); notify('ปิดบัญชีเงินแล้ว')
    })
  }

  function openCategoryEditor(kind: Category['kind'], category?: Category) {
    setCategoryEditDraft({ id: category?.id || null, kind, name: category?.name || '' })
  }

  async function saveCategoryEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!categoryEditDraft) return
    const draft = categoryEditDraft
    const response = await apiFetch(draft.id ? `/api/categories/${draft.id}` : '/api/categories', { method: draft.id ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft.id ? { name: draft.name.trim() } : { scope, familyId: scope === 'family' ? activeFamilyId : undefined, kind: draft.kind, name: draft.name.trim() }) })
    const result = await response.json() as { error?: string }
    if (!response.ok) return notify(result.error || (draft.id ? 'แก้ไขหมวดหมู่ไม่สำเร็จ' : 'เพิ่มหมวดหมู่ไม่สำเร็จ'))
    setCategoryEditDraft(null); setFinanceVersion((value) => value + 1); notify(draft.id ? 'แก้ไขหมวดหมู่แล้ว' : 'เพิ่มหมวดหมู่แล้ว')
  }

  function archiveCategory(category: Category) {
    askConfirmation(`ซ่อนหมวดหมู่ “${category.name}” จากรายการใหม่หรือไม่?`, async () => {
    const response = await apiFetch(`/api/categories/${category.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' })
    const result = await response.json() as { error?: string }
    if (!response.ok) return notify(result.error || 'ซ่อนหมวดหมู่ไม่สำเร็จ')
    setFinanceVersion((value) => value + 1); notify('ซ่อนหมวดหมู่แล้ว')
    })
  }

  function createBudget() {
    const category = categoryItems.find((item) => item.kind === 'expense' && item.ownerType === (scope === 'family' ? 'family' : 'user') && item.ownerRef === (scope === 'family' ? activeFamilyId : authUser?.id))
    if (!category) return notify('เพิ่มหมวดรายจ่ายก่อนตั้งงบ')
    setBudgetEditDraft({ id: null, categoryId: String(category.id), amount: '', periodType: 'monthly', cycleStartDay: '1', periodStart: bangkokToday(), periodEnd: bangkokToday(), alertPercent: '80' })
  }

  function manageBudget(budget: Budget) {
    setBudgetEditDraft({ id: budget.id, categoryId: String(budget.categoryId), amount: String(budget.amount), periodType: budget.periodType, cycleStartDay: String(budget.cycleStartDay), periodStart: budget.periodStart?.slice(0, 10) || bangkokToday(), periodEnd: budget.periodEnd?.slice(0, 10) || bangkokToday(), alertPercent: String(budget.alertPercent) })
  }

  async function saveBudgetEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!budgetEditDraft) return
    const draft = budgetEditDraft
    const payload = { categoryId: Number(draft.categoryId), amount: Number(draft.amount), periodType: draft.periodType, cycleStartDay: Number(draft.cycleStartDay), periodStart: draft.periodType === 'custom' ? draft.periodStart : null, periodEnd: draft.periodType === 'custom' ? draft.periodEnd : null, alertPercent: Number(draft.alertPercent) }
    const response = await apiFetch(draft.id ? `/api/budgets/${draft.id}` : '/api/budgets', { method: draft.id ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft.id ? payload : { ...payload, scope, familyId: scope === 'family' ? activeFamilyId : undefined }) })
    const result = await response.json() as { error?: string }
    if (!response.ok) return notify(result.error || (draft.id ? 'แก้ไขงบไม่สำเร็จ' : 'สร้างงบไม่สำเร็จ'))
    setBudgetEditDraft(null); setFinanceVersion((value) => value + 1); notify(draft.id ? 'แก้ไขงบประมาณแล้ว' : 'สร้างงบประมาณแล้ว')
  }

  async function archiveBudget(budgetId: number) {
    const response = await apiFetch(`/api/budgets/${budgetId}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' })
    const result = await response.json() as { error?: string }
    if (!response.ok) return notify(result.error || 'ปิดงบไม่สำเร็จ')
    setBudgetEditDraft(null); setFinanceVersion((value) => value + 1); notify('ปิดงบแล้ว')
  }

  function moveBudget() {
    if (budgets.length < 2) return notify('ต้องมีงบอย่างน้อยสองหมวดก่อนย้ายวงเงิน')
    const source = budgets[0], target = budgets.find((budget) => budget.id !== source.id)!
    setBudgetMoveDraft({ fromBudgetId: String(source.id), toBudgetId: String(target.id), amount: '' })
  }

  async function saveBudgetMovement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!budgetMoveDraft) return
    const draft = budgetMoveDraft
    const response = await apiFetch('/api/budgets/movements', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fromBudgetId: Number(draft.fromBudgetId), toBudgetId: Number(draft.toBudgetId), amount: Number(draft.amount) }) })
    const result = await response.json() as { error?: string }
    if (!response.ok) return notify(result.error || 'ย้ายงบไม่สำเร็จ')
    setBudgetMoveDraft(null); setFinanceVersion((value) => value + 1); notify('ย้ายวงเงินระหว่างหมวดแล้ว')
  }
  async function createRecurringRule() {
    if (!authUser) return
    const recurringScope: Scope = scope === 'family' && authUser.families.length ? 'family' : 'personal'
    const recurringFamilyId = recurringScope === 'family' ? activeFamilyId : null
    const availableAccounts = moneyAccounts.filter((account) => recurringScope === 'family' ? account.ownerType === 'family' && account.familyId === recurringFamilyId || account.ownerType === 'user' && account.ownerUserId === authUser.id : account.ownerType === 'user' && account.ownerUserId === authUser.id)
    const availableCategories = categoryItems.filter((category) => category.ownerType === (recurringScope === 'family' ? 'family' : 'user') && category.ownerRef === (recurringScope === 'family' ? recurringFamilyId : authUser.id))
    const memberNames = recurringScope === 'family' ? familyInfo.find((family) => family.id === activeFamilyId)?.members.map((member) => member.displayName) || [] : []
    const initialCategory = availableCategories.find((category) => category.kind === 'expense')
    setRecurringDraft({ id: null, scope: recurringScope, familyId: recurringFamilyId, kind: 'expense', title: '', amount: '', categoryId: initialCategory ? String(initialCategory.id) : '', sourceAccountId: availableAccounts[0] ? String(availableAccounts[0].id) : '', destinationAccountId: '', frequency: 'monthly', intervalCount: '1', dayOfMonth: String(Number(bangkokToday().slice(-2))), startsOn: bangkokToday(), endsOn: '', owner: memberNames.includes(authUser.displayName) || recurringScope === 'personal' ? authUser.displayName : memberNames[0] || 'ครอบครัว', payer: memberNames.includes(authUser.displayName) || recurringScope === 'personal' ? authUser.displayName : memberNames[0] || '' })
  }

  function editRecurringRule(rule: RecurringRule) {
    if (!rule.canManage) return
    setRecurringDraft({ id: rule.id, scope: rule.scope, familyId: rule.familyId, kind: rule.kind, title: rule.title, amount: String(rule.amount), categoryId: rule.categoryId == null ? '' : String(rule.categoryId), sourceAccountId: String(rule.sourceAccountId), destinationAccountId: rule.destinationAccountId == null ? '' : String(rule.destinationAccountId), frequency: rule.frequency, intervalCount: String(rule.intervalCount), dayOfMonth: rule.dayOfMonth == null ? '' : String(rule.dayOfMonth), startsOn: rule.startsOn.slice(0, 10), endsOn: rule.endsOn?.slice(0, 10) || '', owner: rule.owner, payer: rule.payer || '' })
  }

  async function saveRecurringRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!recurringDraft) return
    const draft = recurringDraft
    const payload = { scope: draft.scope, familyId: draft.familyId || undefined, kind: draft.kind, title: draft.title.trim(), amount: Number(draft.amount), categoryId: draft.kind === 'transfer' ? undefined : Number(draft.categoryId), sourceAccountId: Number(draft.sourceAccountId), destinationAccountId: draft.kind === 'transfer' ? Number(draft.destinationAccountId) : undefined, frequency: draft.frequency, intervalCount: Number(draft.intervalCount), dayOfMonth: draft.frequency === 'monthly' ? Number(draft.dayOfMonth) : null, startsOn: draft.startsOn, endsOn: draft.endsOn || null, owner: draft.owner, payer: draft.kind === 'expense' ? draft.payer : undefined }
    const response = await apiFetch(draft.id ? `/api/recurring-rules/${draft.id}` : '/api/recurring-rules', { method: draft.id ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    const result = await response.json() as { error?: string }
    if (!response.ok) return notify(result.error || (draft.id ? 'แก้ไขรายการประจำไม่สำเร็จ' : 'สร้างรายการประจำไม่สำเร็จ'))
    setRecurringDraft(null); setFinanceVersion((value) => value + 1); notify(draft.id ? 'แก้ไขกติกาประจำแล้ว' : 'สร้างกติกาประจำแล้ว')
  }

  async function toggleRecurringRule(rule: RecurringRule) {
    if (!rule.canManage) return
    const response = await apiFetch(`/api/recurring-rules/${rule.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: rule.amount, frequency: rule.frequency, intervalCount: rule.intervalCount, dayOfMonth: rule.dayOfMonth, endsOn: rule.endsOn, paused: !rule.paused }) })
    const result = await response.json() as { error?: string }
    if (!response.ok) return notify(result.error || 'เปลี่ยนสถานะรายการประจำไม่สำเร็จ')
    setFinanceVersion((value) => value + 1); notify(rule.paused ? 'เปิดรายการประจำแล้ว' : 'หยุดรายการประจำชั่วคราวแล้ว')
  }

  async function reviewRecurring(review: RecurringReview, action: 'confirm' | 'dismiss', edits?: { title: string; amount: number; occurredAt: string }) {
    const response = await apiFetch(`/api/recurring-reviews/${review.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, edits }) })
    const result = await response.json() as { error?: string }
    if (!response.ok) { notify(result.error || 'ตรวจรายการประจำไม่สำเร็จ'); return false }
    setFinanceVersion((value) => value + 1); notify(action === 'confirm' ? 'ยืนยันรายการประจำและบันทึกยอดแล้ว' : 'ไม่บันทึกรายการรอบนี้')
    return true
  }

  function editAndReviewRecurring(review: RecurringReview) {
    if (!review.canManage) return
    setRecurringReviewDraft({ review, title: review.transaction.title, amount: String(review.transaction.amount), date: review.transaction.occurredAt.slice(0, 10) })
  }

  async function saveRecurringReviewDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!recurringReviewDraft) return
    const { review, title, amount, date } = recurringReviewDraft
    if (await reviewRecurring(review, 'confirm', { title: title.trim(), amount: Number(amount), occurredAt: `${date} 12:00:00` })) setRecurringReviewDraft(null)
  }

  async function viewHistory(item: Transaction) {
    const response = await apiFetch(`/api/transactions/${item.id}/history`)
    const result = await response.json() as AuditHistory[] | { error?: string }
    if (!response.ok || !Array.isArray(result)) return notify(!Array.isArray(result) ? result.error || 'โหลดประวัติไม่สำเร็จ' : 'โหลดประวัติไม่สำเร็จ')
    setHistoryEntries(result)
  }

  async function openSplitEditor(item: Transaction) {
    if (!authUser) return
    const currentUser = authUser
    const response = await apiFetch(`/api/transactions/${item.id}/allocations`)
    const result = await response.json() as Allocation[] | { error?: string }
    if (!response.ok || !Array.isArray(result)) return notify(!Array.isArray(result) ? result.error || 'โหลดส่วนแบ่งไม่สำเร็จ' : 'โหลดส่วนแบ่งไม่สำเร็จ')
    const categoriesForTransaction = categoryItems.filter((category) => category.kind === item.kind && category.ownerType === (item.scope === 'family' ? 'family' : 'user') && category.ownerRef === (item.scope === 'family' ? activeFamilyId : currentUser.id))
    const drafts = result.length ? result.map((allocation) => ({ categoryId: String(allocation.categoryId || ''), owner: allocation.ownerName === 'ครอบครัว' ? 'family' : String(allocation.ownerUserId || currentUser.id), amount: String(allocation.amount) })) : [{ categoryId: String(item.categoryId || categoriesForTransaction[0]?.id || ''), owner: String(currentUser.id), amount: String(item.amount) }]
    setSplitTransaction(item); setSplitRows(drafts)
  }

  async function saveAllocations() {
    if (!splitTransaction) return
    const allocations = splitRows.map((row) => ({ categoryId: Number(row.categoryId), amount: Number(row.amount), ownerIsFamily: row.owner === 'family', ownerUserId: row.owner === 'family' ? null : Number(row.owner) }))
    const sumCents = allocations.reduce((sum, item) => sum + Math.round(item.amount * 100), 0)
    if (sumCents !== Math.round(splitTransaction.amount * 100)) return notify('ยอดส่วนแบ่งรวมต้องเท่ากับยอดรายการพอดี')
    const response = await apiFetch(`/api/transactions/${splitTransaction.id}/allocations`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ allocations }) })
    const result = await response.json() as { error?: string }
    if (!response.ok) return notify(result.error || 'บันทึกส่วนแบ่งไม่สำเร็จ')
    setSplitTransaction(null); setSplitRows([]); setFinanceVersion((value) => value + 1); notify('บันทึกส่วนแบ่งรายการแล้ว')
  }

  function splitEvenly() {
    if (!splitTransaction || splitRows.length < 2) return notify('เพิ่มอย่างน้อยสองส่วนก่อนแบ่งเท่ากัน')
    const totalCents = Math.round(splitTransaction.amount * 100)
    const baseCents = Math.floor(totalCents / splitRows.length)
    const extraCents = totalCents - baseCents * splitRows.length
    setSplitRows((rows) => rows.map((row, index) => ({ ...row, amount: ((baseCents + (index < extraCents ? 1 : 0)) / 100).toFixed(2) })))
  }

  const navItems = [
    { label: 'ภาพรวม', icon: LayoutDashboard }, { label: 'รายการทั้งหมด', icon: ListFilter }, { label: 'รายงาน', icon: TrendingUp },
    { label: 'งบประมาณ', icon: SlidersHorizontal }, { label: 'รายการประจำ', icon: CalendarDays }, { label: 'บัญชีเงิน', icon: Wallet },
    { label: 'ครอบครัว', icon: Users }, { label: 'หมวดหมู่', icon: Tag }, { label: 'ถังขยะ', icon: Trash2 }, { label: 'ตั้งค่า', icon: Settings2 },
  ]
  const recurringAccounts = recurringDraft ? moneyAccounts.filter((account) => recurringDraft.scope === 'family' ? account.ownerType === 'family' && account.familyId === recurringDraft.familyId || account.ownerType === 'user' && account.ownerUserId === authUser?.id : account.ownerType === 'user' && account.ownerUserId === authUser?.id) : []
  const recurringCategoriesForDraft = recurringDraft ? categoryItems.filter((category) => category.ownerType === (recurringDraft.scope === 'family' ? 'family' : 'user') && category.ownerRef === (recurringDraft.scope === 'family' ? recurringDraft.familyId : authUser?.id) && category.kind === recurringDraft.kind) : []
  const recurringMemberNames = recurringDraft?.scope === 'family' ? familyInfo.find((family) => family.id === recurringDraft.familyId)?.members.map((member) => member.displayName) || [] : [authUser?.displayName || '']
  const recurringDestinations = recurringDraft ? [...recurringAccounts.map((account) => ({ id: account.id, label: account.name })), ...(recurringDraft.scope === 'family' ? transferRecipientAccounts.map((account) => ({ id: account.id, label: `${account.ownerName} · ${account.accountType === 'cash' ? 'เงินสด' : account.accountType === 'bank' ? 'ธนาคาร' : 'บัญชีอื่น'}` })) : [])].filter((account) => String(account.id) !== recurringDraft.sourceAccountId) : []
  const monthText = new Intl.DateTimeFormat('th-TH', { month: 'long', year: 'numeric', timeZone: 'Asia/Bangkok' }).format(new Date(`${dateFrom}T12:00:00+07:00`))
  function selectCurrentMonth() {
    const today = bangkokToday()
    setDateFrom(monthStart(today)); setDateTo(today); setRange('เดือนนี้')
  }

  function selectRecentSixMonths() {
    if (range === '6 เดือน') return selectCurrentMonth()
    const today = bangkokToday()
    const [year, month] = today.slice(0, 7).split('-').map(Number)
    const first = new Date(Date.UTC(year, month - 1 - 5, 1))
    setDateFrom(`${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, '0')}-01`)
    setDateTo(today); setRange('6 เดือน')
  }

  async function signOut() {
    await apiFetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    setAuthUser(null)
    setTransactions([])
  }

  async function refreshFamilies() {
    const response = await apiFetch('/api/families')
    if (response.ok) setFamilyInfo(await response.json() as FamilyInfo[])
    const me = await apiFetch('/api/auth/me')
    if (me.ok) setAuthUser((await me.json() as { user: AuthUser }).user)
  }

  async function createInvitation(familyId: number) {
    const response = await apiFetch(`/api/families/${familyId}/invitations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const result = await response.json() as { link?: string; error?: string }
    if (!response.ok || !result.link) return notify(result.error || 'สร้างลิงก์เชิญไม่สำเร็จ')
    setInviteLink(result.link)
    await refreshFamilies()
  }

  async function revokeInvitation(familyId: number, invitationId: number) {
    const response = await apiFetch(`/api/families/${familyId}/invitations/${invitationId}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' })
    const result = await response.json() as { error?: string }
    if (!response.ok) return notify(result.error || 'ยกเลิกคำเชิญไม่สำเร็จ')
    await refreshFamilies(); notify('ยกเลิกลิงก์เชิญแล้ว')
  }

  function leaveFamily(familyId: number) {
    askConfirmation('ออกจากครอบครัวนี้หรือไม่? ประวัติเดิมจะยังคงอยู่ในสรุปครอบครัว', async () => {
    const response = await apiFetch(`/api/families/${familyId}/leave`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const result = await response.json() as { error?: string }
    if (!response.ok) return notify(result.error || 'ออกจากครอบครัวไม่สำเร็จ')
    await refreshFamilies(); notify('ออกจากครอบครัวแล้ว')
    })
  }

  async function authenticated(user: AuthUser) {
    if (inviteToken) {
      const response = await apiFetch('/api/families/invitations/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: inviteToken }) })
      const result = await response.json() as { user?: AuthUser; error?: string }
      if (!response.ok && response.status !== 409) { setAuthMessage(result.error || 'เข้าร่วมครอบครัวไม่สำเร็จ'); setAuthUser(user); return }
      setInviteToken('')
      window.history.replaceState({}, '', window.location.pathname)
      if (result.user) user = result.user
      else { const me = await apiFetch('/api/auth/me'); if (me.ok) user = (await me.json() as { user: AuthUser }).user }
      setAuthMessage('เข้าร่วมครอบครัวแล้ว')
    }
    setAuthUser(user)
  }

  if (!authChecked) return <AuthShell><div className="auth-loading">กำลังตรวจสอบบัญชี…</div></AuthShell>
  if (!authUser) return <AuthScreen resetToken={resetToken} inviteToken={inviteToken} initialMessage={authMessage} onAuthenticated={authenticated} />

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><Wallet size={19} strokeWidth={2.4} /></div><div><strong>อุ่นใจ</strong><span>จัดการเงินให้ง่ายขึ้น</span></div></div>
        <button className="workspace-switch"><div className="workspace-avatar">{scope === 'family' ? (authUser.families.find((family) => family.id === activeFamilyId)?.name || 'บ').slice(0, 1) : authUser.displayName.slice(0, 1)}</div><div className="workspace-copy"><strong>{scope === 'family' ? authUser.families.find((family) => family.id === activeFamilyId)?.name || 'ยังไม่มีครอบครัว' : 'พื้นที่ส่วนตัว'}</strong><span>{scope === 'family' ? `${familyInfo.find((family) => family.id === activeFamilyId)?.members.length || 0} สมาชิก` : 'บัญชีส่วนตัว'}</span></div><ChevronDown size={15} /></button>
        <div className="nav-label">เมนูหลัก</div>
        <nav className="nav-list">
          {navItems.map(({ label, icon: Icon }) => <button key={`desktop-${label}`} onClick={() => { setPage(label); if (label === 'รายงาน') { setKindFilter('ทั้งหมด'); setSearch('') } }} className={`nav-item desktop-nav-item ${page === label ? 'active' : ''}`}><Icon size={18} strokeWidth={1.8} /><span>{label}</span>{label === 'งบประมาณ' && budgetAlerts.length > 0 && <span className="nav-count">{budgetAlerts.length}</span>}{label === 'รายการประจำ' && recurringReviews.length > 0 && <span className="nav-count">{recurringReviews.length}</span>}</button>)}
          {navItems.slice(0, 4).map(({ label, icon: Icon }) => <button key={`mobile-${label}`} onClick={() => { setPage(label); setMobileMoreOpen(false); if (label === 'รายงาน') { setKindFilter('ทั้งหมด'); setSearch('') } }} className={`nav-item mobile-nav-item ${page === label ? 'active' : ''}`}><Icon size={18} strokeWidth={1.8} /><span>{label === 'รายการทั้งหมด' ? 'รายการ' : label}</span></button>)}
          <button className={`nav-item mobile-nav-item mobile-more-trigger ${mobileMoreOpen || navItems.slice(4).some((item) => item.label === page) ? 'active' : ''}`} aria-expanded={mobileMoreOpen} onClick={() => setMobileMoreOpen((open) => !open)}><MoreHorizontal size={19} strokeWidth={1.8} /><span>เพิ่มเติม</span></button>
        </nav>
        {mobileMoreOpen && <><button className="mobile-more-backdrop" aria-label="ปิดเมนูเพิ่มเติม" onClick={() => setMobileMoreOpen(false)} /><div className="mobile-more-menu" role="menu">{navItems.slice(4).map(({ label, icon: Icon }) => <button role="menuitem" key={label} className={`nav-item ${page === label ? 'active' : ''}`} onClick={() => { setPage(label); setMobileMoreOpen(false) }}><Icon size={17} strokeWidth={1.8} /><span>{label}</span>{label === 'รายการประจำ' && recurringReviews.length > 0 && <span className="nav-count">{recurringReviews.length}</span>}</button>)}</div></>}
        <div className="sidebar-bottom">
          <div className="sidebar-tip"><div className="tip-icon"><Sparkles size={16} /></div><strong>เริ่มจดได้เลย</strong><p>เพิ่มรายการใหม่เพื่อให้เห็นภาพรวมการเงินของบ้าน</p><button onClick={() => openComposer('expense')}>เพิ่มรายการ <ArrowUpRight size={14} /></button></div>
          <div className="profile"><div className="avatar user-avatar">{authUser.displayName.slice(0, 1)}</div><div className="profile-copy"><strong>{authUser.displayName}</strong><span>{authUser.systemRole === 'superadmin' ? 'Super Admin' : authUser.families[0]?.role === 'owner' ? 'เจ้าของครอบครัว' : 'สมาชิกครอบครัว'}</span></div><button className="signout-button" onClick={signOut} aria-label="ออกจากระบบ" title="ออกจากระบบ"><LogOut size={15}/></button></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>พื้นที่ครอบครัว</span><ChevronRight size={14} /><strong>{page}</strong></div>
          <div className="topbar-actions"><span className={`prototype-pill ${apiStatus}`}><span />{apiStatus === 'connected' ? 'MySQL เชื่อมต่อ' : apiStatus === 'connecting' ? 'กำลังเชื่อม MySQL' : 'MySQL ไม่พร้อม'}</span><button className="icon-button notification-button" aria-label="การแจ้งเตือน" onClick={() => { if (recurringReviews.length) { setPage('รายการประจำ'); notify(`มีรายการประจำรอตรวจ ${recurringReviews.length} รายการ`) } else if (budgetAlerts.length) { setPage('งบประมาณ'); notify(`มีงบถึงเกณฑ์แจ้งเตือน ${budgetAlerts.length} หมวด`) } else notify('ยังไม่มีการแจ้งเตือน') }}><Bell size={18} />{(budgetAlerts.length > 0 || recurringReviews.length > 0) && <i />}</button><div className="avatar small-avatar">{authUser.displayName.slice(0, 1)}</div></div>
        </header>

        <div className="content-wrap">
          {apiStatus === 'offline' && <div className="prototype-warning"><strong>เชื่อมต่อฐานข้อมูลไม่ได้</strong><span>ข้อมูลล่าสุดยังโหลดไม่สำเร็จ กรุณาตรวจสอบสถานะระบบแล้วลองใหม่</span><button className="secondary-button" onClick={() => { setApiStatus('connecting'); setFinanceVersion((value) => value + 1) }}>ลองโหลดอีกครั้ง</button></div>}
          <div className="page-heading">
            <div><div className="eyebrow"><span className="eyebrow-dot" /> ภาพรวมการเงิน</div><h1>{page === 'ภาพรวม' ? `สวัสดี, ${authUser.displayName}` : page}</h1><p>{page === 'ภาพรวม' ? 'มาดูภาพรวมการเงินของบ้านในเดือนนี้กัน' : 'ดูข้อมูลและจัดการรายการของคุณได้ที่นี่'}</p></div>
            {page !== 'ตั้งค่า' && <div className="heading-actions"><button className="secondary-button" onClick={exportReport}><Download size={16} /> <span>ส่งออกรายงาน</span></button><button className="primary-button" onClick={() => openComposer('expense')}><Plus size={17} /> เพิ่มรายการ</button></div>}
          </div>

          {page !== 'ตั้งค่า' && <div className="toolbar">
            <div className="scope-switch" role="tablist" aria-label="ขอบเขตข้อมูล"><button className={scope === 'family' ? 'selected' : ''} onClick={() => setScope('family')} disabled={!authUser.families.length}><Users size={15} /> ครอบครัว</button><button className={scope === 'personal' ? 'selected' : ''} onClick={() => setScope('personal')}><Wallet size={15} /> ส่วนตัว</button>{scope === 'family' && authUser.families.length > 1 && <select aria-label="เลือกครอบครัว" value={activeFamilyId ?? ''} onChange={(event) => setActiveFamilyId(Number(event.target.value))}>{authUser.families.map((family) => <option key={family.id} value={family.id}>{family.name}</option>)}</select>}</div>
            <div className="toolbar-right"><button className="date-picker" onClick={selectCurrentMonth}><CalendarDays size={16} />{monthText}<ChevronDown size={14} /></button><div className="period-tabs"><button onClick={selectCurrentMonth} className={range === 'เดือนนี้' ? 'period-active' : ''}>เดือนนี้</button><button onClick={() => setRange('กำหนดเอง')} className={range === 'กำหนดเอง' ? 'period-active' : ''}>กำหนดเอง</button></div>{range === 'กำหนดเอง' && <div className="date-range-fields"><input aria-label="ตั้งแต่วันที่" type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)}/><span>ถึง</span><input aria-label="ถึงวันที่" type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)}/></div>}</div>
          </div>}

          {page === 'ภาพรวม' && (reportLoading ? <div className="panel full-page-panel"><div className="empty-state" role="status">กำลังคำนวณภาพรวม…</div></div> : <>
            <section className="summary-grid">
              <SummaryCard label="รายรับทั้งหมด" amount={totals.income} detail={`${dateFrom} ถึง ${dateTo}`} trend="รายรับ" tone="green" icon={<ArrowDownLeft size={18} />} />
              <SummaryCard label="รายจ่ายทั้งหมด" amount={totals.expense} detail={`${dateFrom} ถึง ${dateTo}`} trend="รายจ่าย" tone="orange" icon={<ArrowUpRight size={18} />} />
              <SummaryCard label="เงินสุทธิ" amount={totals.net} detail="รายรับหักรายจ่าย · ไม่นับโอน" trend="สุทธิ" tone="blue" icon={<Wallet size={18} />} />
              <SummaryCard label="ยอดคงเหลือบัญชี" amount={moneyAccounts.filter((account) => scope === 'personal' ? account.ownerType === 'user' && account.ownerUserId === authUser.id : account.ownerType === 'family' && account.familyId === activeFamilyId).reduce((sum, account) => sum + account.balance, 0)} detail={`${moneyAccounts.filter((account) => scope === 'personal' ? account.ownerType === 'user' && account.ownerUserId === authUser.id : account.ownerType === 'family' && account.familyId === activeFamilyId).length} บัญชี`} trend="ยอดปัจจุบัน" tone="purple" icon={<SlidersHorizontal size={18} />} />
            </section>

            <section className="dashboard-grid">
              <div className="panel cashflow-panel">
                <div className="panel-header"><div><div className="panel-title">กระแสเงินสด</div><div className="panel-subtitle">ภาพรวมรายรับและรายจ่ายในช่วงที่เลือก</div></div><button className="select-chip" onClick={selectRecentSixMonths}>{range === '6 เดือน' ? 'เดือนนี้' : '6 เดือนล่าสุด'}<ChevronDown size={14} /></button></div>
                <div className="chart-legend"><span><i className="legend-dot income-dot" /> รายรับ ฿{formatMoney(totals.income)}</span><span><i className="legend-dot expense-dot" /> รายจ่าย ฿{formatMoney(totals.expense)}</span><span className="chart-total">เงินสุทธิ <b>฿{formatMoney(totals.net)}</b></span></div>
                <div className="category-spend-list">{categoryTotals.length ? categoryTotals.map(([name, amount]) => <BudgetRow key={name} icon={categoryItems.find((item) => item.name === name && item.kind === 'expense')?.icon || '🧾'} name={name} used={amount} limit={categoryTotals[0][1]} color="teal"/>) : <div className="empty-state">ยังไม่มีรายจ่ายในช่วงวันที่เลือก</div>}</div>
              </div>

              <div className="panel budget-panel"><div className="panel-header"><div><div className="panel-title">หมวดรายจ่ายสูงสุด</div><div className="panel-subtitle">คำนวณจากรายการในช่วงที่เลือก</div></div><button className="more-button" onClick={() => setPage('รายการทั้งหมด')}>ดูรายการ <ChevronRight size={14} /></button></div>{categoryTotals.slice(0, 3).map(([name, amount]) => <BudgetRow key={name} icon={categoryItems.find((item) => item.name === name && item.kind === 'expense')?.icon || '🧾'} name={name} used={amount} limit={categoryTotals[0][1]} color="orange"/>)}{!categoryTotals.length && <div className="empty-state">ยังไม่มีรายการในช่วงนี้</div>}</div>
            </section>

            <section className="lower-grid">
              <div className="panel transactions-panel"><div className="panel-header transaction-heading"><div><div className="panel-title">รายการล่าสุด</div><div className="panel-subtitle">กิจกรรมการเงินของคุณและครอบครัว</div></div><button className="more-button" onClick={() => setPage('รายการทั้งหมด')}>ดูรายการทั้งหมด <ChevronRight size={14} /></button></div><TransactionTable rows={filtered.slice(0, 5)} /></div>
              <div className="panel accounts-panel"><div className="panel-header"><div><div className="panel-title">บัญชีเงิน</div><div className="panel-subtitle">ยอดคงเหลือรวม ฿{formatMoney(moneyAccounts.filter((account) => scope === 'personal' ? account.ownerType === 'user' && account.ownerUserId === authUser.id : account.ownerType === 'family' && account.familyId === activeFamilyId).reduce((sum, account) => sum + account.balance, 0))}</div></div><button className="icon-button tiny" onClick={() => setPage('บัญชีเงิน')} aria-label="ดูบัญชีเงิน"><ArrowUpRight size={16}/></button></div>{moneyAccounts.filter((account) => scope === 'personal' ? account.ownerType === 'user' && account.ownerUserId === authUser.id : account.ownerType === 'family' && account.familyId === activeFamilyId).slice(0, 4).map((account) => <AccountRow key={account.id} icon={account.accountType === 'cash' ? <Banknote size={17}/> : account.accountType === 'bank' ? <Landmark size={17}/> : <CreditCard size={17}/>} title={account.name} owner={account.ownerType === 'family' ? 'ครอบครัว' : 'ส่วนตัว'} amount={formatMoney(account.balance)} tone={account.accountType === 'cash' ? 'mint' : account.accountType === 'bank' ? 'violet' : 'blue'}/>)}{!moneyAccounts.length && <div className="empty-state">ยังไม่มีบัญชีเงิน</div>}</div>
            </section>
          </>)}

          {page !== 'ภาพรวม' && <PageContent page={page} rows={filtered} authUser={authUser} onExportAccount={exportAccountData} reportSummary={reportSummary} reportLoading={reportLoading} transactionsLoading={transactionsLoading} transactionPageInfo={transactionPageInfo} onTransactionPageChange={setTransactionPage} search={search} familyInfo={familyInfo} activeFamilyId={activeFamilyId} inviteLink={inviteLink} onCreateInvitation={createInvitation} onRevokeInvitation={revokeInvitation} onLeaveFamily={leaveFamily} onCloseInvite={() => setInviteLink('')} onSearch={setSearch} kindFilter={kindFilter} onKindFilter={setKindFilter} onAdd={() => openComposer(page === 'รายการทั้งหมด' ? 'expense' : 'income')} onEdit={editTransaction} onTrash={trashTransaction} onRestore={restoreTransaction} onHistory={viewHistory} onSplit={openSplitEditor} onDeleteReceipt={deleteReceipt} onToast={notify} scope={scope} moneyAccounts={moneyAccounts.filter((account) => scope === 'family' ? account.ownerType === 'family' && account.familyId === activeFamilyId : account.ownerType === 'user' && account.ownerUserId === authUser.id)} categories={categoryItems.filter((category) => category.ownerType === (scope === 'family' ? 'family' : 'user') && category.ownerRef === (scope === 'family' ? activeFamilyId : authUser.id))} budgets={budgets} budgetMovements={budgetMovements} onCreateBudget={createBudget} onMoveBudget={moveBudget} onManageBudget={manageBudget} onCreateAccount={() => setAccountDialog(true)} onEditAccount={editMoneyAccount} onArchiveAccount={archiveMoneyAccount} onOpenCategoryEditor={openCategoryEditor} onEditCategory={(category) => openCategoryEditor(category.kind, category)} onArchiveCategory={archiveCategory} canManageFamilyFinancials={familyInfo.find((family) => family.id === activeFamilyId)?.role === 'owner'} recurringRules={recurringRules} recurringReviews={recurringReviews} onCreateRecurringRule={createRecurringRule} onEditRecurringRule={editRecurringRule} onToggleRecurringRule={toggleRecurringRule} onReviewRecurring={reviewRecurring} onEditAndReviewRecurring={editAndReviewRecurring} />}
        </div>
      </main>

      <button className="mobile-add" onClick={() => openComposer('expense')}><Plus size={22}/></button>

      {modal && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) void closeComposer() }}><div className="composer-modal" role="dialog" aria-modal="true" aria-labelledby="composer-title"><div className="modal-heading"><div><div className="modal-kicker">{editingTransactionId ? 'แก้ไขรายการ' : 'เพิ่มรายการใหม่'}</div><h2 id="composer-title">{editingTransactionId ? 'ปรับข้อมูลการเงิน' : 'บันทึกการเงิน'}</h2></div><button className="icon-button" onClick={() => void closeComposer()} aria-label="ปิด"><X size={19}/></button></div><div className="kind-tabs">{([{key:'expense',label:'รายจ่าย',icon:<ArrowUpRight size={15}/>},{key:'income',label:'รายรับ',icon:<ArrowDownRight size={15}/>},{key:'transfer',label:'โอนเงิน',icon:<ArrowLeftRight size={15}/>} ] as const).map((item) => <button key={item.key} type="button" className={formKind === item.key ? `${item.key} active` : ''} onClick={() => { setFormKind(item.key); setFormCategory(item.key === 'income' ? 'เงินเดือน' : 'อาหาร') }}>{item.icon}{item.label}</button>)}</div><form onSubmit={saveTransaction}>
        <div className="amount-field"><label htmlFor="amount">จำนวนเงิน</label><div><span>฿</span><input id="amount" inputMode="decimal" value={formAmount} onChange={(event) => { manuallyEditedReceiptFields.current.amount = true; setFormAmount(event.target.value) }} placeholder="0.00" required /></div></div>
        <div className="form-grid"><label className="input-label">วันที่รายการ<input type="date" value={formDate} onChange={(event) => { manuallyEditedReceiptFields.current.date = true; setFormDate(event.target.value) }} required/></label></div>
        <div className="form-row"><label>ขอบเขต</label><div className="scope-options"><button type="button" disabled={!authUser.families.length} className={formScope === 'family' ? 'chosen' : ''} onClick={() => changeFormScope('family')}><Users size={15}/> ครอบครัว</button><button type="button" className={formScope === 'personal' ? 'chosen' : ''} onClick={() => changeFormScope('personal')}><Wallet size={15}/> ส่วนตัว</button></div></div>
        <div className={`form-grid ${formKind === 'transfer' ? 'single' : ''}`}><label className="input-label">{formKind === 'income' ? 'ที่มาของรายรับ' : formKind === 'transfer' ? 'รายละเอียดการโอน' : 'ชื่อรายการ'}<input value={formTitle} onChange={(event) => { manuallyEditedReceiptFields.current.title = true; setFormTitle(event.target.value) }} placeholder={formKind === 'income' ? 'เช่น เงินเดือน' : formKind === 'transfer' ? 'เช่น โอนให้แม่' : 'เช่น ซื้อของเข้าบ้าน'} /></label>{formKind !== 'transfer' && <label className="input-label">หมวดหมู่<select value={formCategoryId} onChange={(event) => { manuallyEditedReceiptFields.current.category = true; setFormCategoryId(event.target.value); setFormCategory(formCategories.find((category) => String(category.id) === event.target.value)?.name || '') }} required><option value="">เลือกหมวดหมู่</option>{formCategories.map((category) => <option key={category.id} value={category.id}>{category.icon} {category.name}</option>)}</select></label>}</div>
        {formKind === 'transfer' ? <div className="form-grid"><label className="input-label">บัญชีต้นทาง<select value={formAccountId} onChange={(event) => { const account = formAccounts.find((item) => String(item.id) === event.target.value); setFormAccountId(event.target.value); setFormAccount(account?.name || '') }} required><option value="">เลือกบัญชีต้นทาง</option>{formAccounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.ownerType === 'family' ? 'ครอบครัว' : 'ส่วนตัว'}</option>)}</select></label><label className="input-label">บัญชีปลายทาง<select value={formDestinationId} onChange={(event) => { const account = formAccounts.find((item) => String(item.id) === event.target.value); const recipient = transferRecipientAccounts.find((item) => String(item.id) === event.target.value); setFormDestinationId(event.target.value); setFormDestination(account?.name || (recipient ? `${recipient.ownerName} · ${recipient.accountType === 'cash' ? 'เงินสด' : recipient.accountType === 'bank' ? 'บัญชีธนาคาร' : 'บัญชีอื่น'}` : '')) }} required><option value="">เลือกบัญชีปลายทาง</option>{formAccounts.filter((account) => String(account.id) !== formAccountId).map((account) => <option key={account.id} value={account.id}>{account.name} · {account.ownerType === 'family' ? 'ครอบครัว' : 'ส่วนตัว'}</option>)}{formScope === 'family' && transferRecipientAccounts.map((account) => <option key={account.id} value={account.id}>{account.ownerName} · {account.accountType === 'cash' ? 'เงินสด' : account.accountType === 'bank' ? 'บัญชีธนาคาร' : 'บัญชีอื่น'}</option>)}</select></label></div> : <><div className="form-grid"><label className="input-label">{formKind === 'income' ? 'บัญชีรับเงิน' : 'บัญชีจ่ายเงิน'}<select value={formAccountId} onChange={(event) => { const account = formAccounts.find((item) => String(item.id) === event.target.value); setFormAccountId(event.target.value); setFormAccount(account?.name || '') }} required><option value="">เลือกบัญชีเงิน</option>{formAccounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.ownerType === 'family' ? 'ครอบครัว' : 'ส่วนตัว'}</option>)}</select></label>{formKind === 'expense' && <label className="input-label">ผู้จ่าย<select value={formPayer} onChange={(event) => setFormPayer(event.target.value)}><option>{authUser.displayName}</option>{formScope === 'family' && <><option>ครอบครัว</option>{familyInfo.find((family) => family.id === activeFamilyId)?.members.filter((member) => member.displayName !== authUser.displayName).map((member) => <option key={member.id}>{member.displayName}</option>)}</>}</select></label>}</div><div className="form-grid"><label className="input-label">เจ้าของรายการ<select value={formOwner} onChange={(event) => setFormOwner(event.target.value)}><option>{authUser.displayName}</option>{formScope === 'family' && <><option>ครอบครัว</option>{familyInfo.find((family) => family.id === activeFamilyId)?.members.filter((member) => member.displayName !== authUser.displayName).map((member) => <option key={member.id}>{member.displayName}</option>)}</>}</select></label></div></>}
        {formKind === 'expense' && <div className="receipt-box">{filePreview ? <div className="receipt-preview"><img src={filePreview} alt="ภาพสลิปที่เลือก"/><div><strong><Sparkles size={14}/> {receiptId ? (receiptOcrAvailable ? 'ผลสแกนจากภาพ · โปรดตรวจสอบ' : 'บันทึกภาพแล้ว · กรอกข้อมูลเอง') : 'กำลังอัปโหลดและสแกนภาพ…'}</strong><span>{receiptSuggestion?.merchant || selectedReceipt?.name || 'ไม่พบชื่อร้าน'}{receiptSuggestion?.amount ? ` · ฿${formatMoney(receiptSuggestion.amount)}` : ''}{receiptSuggestion?.date ? ` · ${receiptSuggestion.date}` : ''}</span>{receiptSuggestion?.category && <small>หมวดที่แนะนำ: {receiptSuggestion.category}</small>}{receiptSuggestion?.rawText && <details><summary>อ่านข้อความจากสลิป</summary><pre>{receiptSuggestion.rawText}</pre></details>}<button type="button" onClick={() => fileInput.current?.click()}>เลือกภาพอื่น</button></div></div> : <button type="button" className="receipt-select" onClick={() => fileInput.current?.click()}><span className="receipt-icon"><FileImage size={19}/></span><span><strong>แนบสลิปหรือใบเสร็จ</strong><small>เลือกภาพจากคลังหรือถ่ายภาพ · สูงสุด 6 MB</small></span><Upload size={16}/></button>}<input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" hidden onChange={handleImage}/></div>}
        <div className="modal-footer"><span><CircleHelp size={14}/> ผู้บันทึก: {authUser.displayName}</span><button type="button" className="secondary-button" onClick={() => void closeComposer()}>ยกเลิก</button><button type="submit" className="primary-button" disabled={Boolean(selectedReceipt && !receiptId)}><Check size={16}/>{editingTransactionId ? 'บันทึกการแก้ไข' : 'บันทึกรายการ'}</button></div>
        </form></div></div>}
      {splitTransaction && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSplitTransaction(null) }}><div className="composer-modal allocation-modal" role="dialog" aria-modal="true" aria-labelledby="split-title"><div className="modal-heading"><div><div className="modal-kicker">แบ่งตามหมวดและเจ้าของ</div><h2 id="split-title">{splitTransaction.title} · ฿{formatMoney(splitTransaction.amount)}</h2></div><button className="icon-button" onClick={() => setSplitTransaction(null)} aria-label="ปิด"><X size={19}/></button></div><p className="panel-subtitle">กำหนดหมวด ผู้รับผิดชอบ และยอดของแต่ละส่วน ยอดรวมต้องเท่ากับรายการหลัก</p><div className="allocation-editor">{splitRows.map((row, index) => <div className="allocation-edit-row" key={index}><label className="input-label">หมวดหมู่<select value={row.categoryId} onChange={(event) => setSplitRows((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, categoryId: event.target.value } : item))}><option value="">เลือกหมวด</option>{categoryItems.filter((category) => category.kind === splitTransaction.kind && category.ownerType === (splitTransaction.scope === 'family' ? 'family' : 'user') && category.ownerRef === (splitTransaction.scope === 'family' ? activeFamilyId : authUser.id)).map((category) => <option key={category.id} value={category.id}>{category.icon} {category.name}</option>)}</select></label>{splitTransaction.scope === 'family' ? <label className="input-label">เจ้าของส่วนนี้<select value={row.owner} onChange={(event) => setSplitRows((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, owner: event.target.value } : item))}><option value="family">ครอบครัว</option>{familyInfo.find((family) => family.id === activeFamilyId)?.members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select></label> : <label className="input-label">เจ้าของส่วนนี้<input readOnly value={authUser.displayName}/></label>}<label className="input-label">ยอด (บาท)<input type="number" min="0.01" step="0.01" value={row.amount} onChange={(event) => setSplitRows((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, amount: event.target.value } : item))} required/></label>{splitRows.length > 1 && <button type="button" className="icon-button" onClick={() => setSplitRows((items) => items.filter((_, itemIndex) => itemIndex !== index))} aria-label="ลบส่วนแบ่ง"><X size={16}/></button>}</div>)}</div><div className="allocation-tools"><button type="button" className="secondary-button" onClick={() => { const first = categoryItems.find((category) => category.kind === splitTransaction.kind && category.ownerType === (splitTransaction.scope === 'family' ? 'family' : 'user') && category.ownerRef === (splitTransaction.scope === 'family' ? activeFamilyId : authUser.id)); setSplitRows((items) => [...items, { categoryId: String(first?.id || ''), owner: splitTransaction.scope === 'family' ? String(authUser.id) : String(authUser.id), amount: '0.00' }]) }}><Plus size={15}/> เพิ่มส่วน</button><button type="button" className="secondary-button" onClick={splitEvenly}>แบ่งเท่ากัน</button><strong>รวม ฿{formatMoney(splitRows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0))}</strong></div><div className="modal-footer"><span>เก็บยอดรายการหลักไว้รายการเดียว</span><button type="button" className="secondary-button" onClick={() => setSplitTransaction(null)}>ยกเลิก</button><button type="button" className="primary-button" onClick={() => void saveAllocations()}><Check size={16}/> บันทึกส่วนแบ่ง</button></div></div></div>}
      {accountDialog && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setAccountDialog(false) }}><div className="composer-modal" role="dialog" aria-modal="true" aria-labelledby="account-dialog-title"><div className="modal-heading"><div><div className="modal-kicker">บัญชีเงินจริง</div><h2 id="account-dialog-title">เพิ่มบัญชีเงิน</h2></div><button className="icon-button" onClick={() => setAccountDialog(false)} aria-label="ปิด"><X size={19}/></button></div><form onSubmit={saveMoneyAccount}><label className="input-label">ชื่อบัญชี<input value={accountName} onChange={(event) => setAccountName(event.target.value)} maxLength={100} placeholder="เช่น เงินสด, ธนาคารกสิกร" required/></label><div className="form-grid"><label className="input-label">ประเภทบัญชี<select value={accountType} onChange={(event) => setAccountType(event.target.value as 'cash' | 'bank' | 'other')}><option value="cash">เงินสด</option><option value="bank">ธนาคาร</option><option value="other">อื่น ๆ</option></select></label><label className="input-label">ยอดตั้งต้น (บาท)<input type="number" min="0" step="0.01" value={accountOpeningBalance} onChange={(event) => setAccountOpeningBalance(event.target.value)} required/></label></div><label className="input-label">วันที่เริ่มต้นยอด<input type="date" value={accountOpeningDate} onChange={(event) => setAccountOpeningDate(event.target.value)} required/></label><div className="modal-footer"><span>{scope === 'family' ? 'บัญชีของครอบครัว' : 'บัญชีส่วนตัว'}</span><button type="button" className="secondary-button" onClick={() => setAccountDialog(false)}>ยกเลิก</button><button type="submit" className="primary-button"><Check size={16}/> สร้างบัญชี</button></div></form></div></div>}
      {historyEntries && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setHistoryEntries(null) }}><div className="composer-modal history-modal" role="dialog" aria-modal="true" aria-labelledby="history-title"><div className="modal-heading"><div><div className="modal-kicker">ตรวจสอบการเปลี่ยนแปลง</div><h2 id="history-title">ประวัติรายการ</h2></div><button className="icon-button" onClick={() => setHistoryEntries(null)} aria-label="ปิด"><X size={19}/></button></div>{historyEntries.length ? historyEntries.map((entry) => <div className="history-entry" key={entry.id}><strong>{entry.action === 'created' ? 'สร้างรายการ' : entry.action === 'updated' ? 'แก้ไขรายการ' : entry.action === 'trashed' ? 'ย้ายไปถังขยะ' : entry.action === 'allocations_updated' ? 'ปรับส่วนแบ่ง' : 'กู้คืนรายการ'}</strong><span>{entry.actor} · {new Date(entry.createdAt).toLocaleString('th-TH')}</span><small>{entry.before ? `${entry.before.title} · ฿${entry.before.amount} · ${entry.before.category}` : '—'} → {entry.after ? `${entry.after.title} · ฿${entry.after.amount} · ${entry.after.category}` : '—'}</small></div>) : <div className="empty-state">ยังไม่มีประวัติการเปลี่ยนแปลง</div>}</div></div>}
      {accountEditDraft && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setAccountEditDraft(null) }}><section className="composer-modal" role="dialog" aria-modal="true" aria-labelledby="account-edit-title"><div className="modal-heading"><div><div className="modal-kicker">จัดการบัญชีเงิน</div><h2 id="account-edit-title">แก้ไขบัญชี</h2></div><button className="icon-button" onClick={() => setAccountEditDraft(null)} aria-label="ปิด"><X size={19}/></button></div><form onSubmit={saveMoneyAccountEdit}><label className="input-label">ชื่อบัญชี<input value={accountEditDraft.name} onChange={(event) => setAccountEditDraft({ ...accountEditDraft, name: event.target.value })} maxLength={100} required/></label><div className="form-grid"><label className="input-label">ประเภทบัญชี<select value={accountEditDraft.accountType} onChange={(event) => setAccountEditDraft({ ...accountEditDraft, accountType: event.target.value as MoneyAccount['accountType'] })}><option value="cash">เงินสด</option><option value="bank">ธนาคาร</option><option value="other">อื่น ๆ</option></select></label><label className="input-label">ยอดตั้งต้น (บาท)<input type="number" step="0.01" value={accountEditDraft.openingBalance} onChange={(event) => setAccountEditDraft({ ...accountEditDraft, openingBalance: event.target.value })} required/></label></div><label className="input-label">วันที่ตั้งต้น<input type="date" value={accountEditDraft.openingDate} onChange={(event) => setAccountEditDraft({ ...accountEditDraft, openingDate: event.target.value })} required/></label><div className="modal-footer"><span>ยอดปัจจุบันคำนวณจากยอดตั้งต้นและรายการ</span><button type="button" className="secondary-button" onClick={() => setAccountEditDraft(null)}>ยกเลิก</button><button type="submit" className="primary-button"><Check size={16}/> บันทึก</button></div></form></section></div>}
      {categoryEditDraft && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCategoryEditDraft(null) }}><section className="composer-modal" role="dialog" aria-modal="true" aria-labelledby="category-edit-title"><div className="modal-heading"><div><div className="modal-kicker">หมวด{categoryEditDraft.kind === 'income' ? 'รายรับ' : 'รายจ่าย'}</div><h2 id="category-edit-title">{categoryEditDraft.id ? 'แก้ไขหมวดหมู่' : 'เพิ่มหมวดหมู่'}</h2></div><button className="icon-button" onClick={() => setCategoryEditDraft(null)} aria-label="ปิด"><X size={19}/></button></div><form onSubmit={saveCategoryEdit}><label className="input-label">ชื่อหมวดหมู่<input value={categoryEditDraft.name} onChange={(event) => setCategoryEditDraft({ ...categoryEditDraft, name: event.target.value })} maxLength={80} autoFocus required/></label><div className="modal-footer"><span>{scope === 'family' ? 'หมวดของครอบครัว' : 'หมวดส่วนตัว'}</span><button type="button" className="secondary-button" onClick={() => setCategoryEditDraft(null)}>ยกเลิก</button><button type="submit" className="primary-button"><Check size={16}/> บันทึก</button></div></form></section></div>}
      {budgetEditDraft && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setBudgetEditDraft(null) }}><section className="composer-modal" role="dialog" aria-modal="true" aria-labelledby="budget-edit-title"><div className="modal-heading"><div><div className="modal-kicker">งบ{scope === 'family' ? 'ครอบครัว' : 'ส่วนตัว'}</div><h2 id="budget-edit-title">{budgetEditDraft.id ? 'จัดการงบประมาณ' : 'เพิ่มงบประมาณ'}</h2></div><button className="icon-button" onClick={() => setBudgetEditDraft(null)} aria-label="ปิด"><X size={19}/></button></div><form onSubmit={saveBudgetEdit}><label className="input-label">หมวดรายจ่าย<select disabled={Boolean(budgetEditDraft.id)} value={budgetEditDraft.categoryId} onChange={(event) => setBudgetEditDraft({ ...budgetEditDraft, categoryId: event.target.value })} required>{categoryItems.filter((category) => category.kind === 'expense' && category.ownerType === (scope === 'family' ? 'family' : 'user') && category.ownerRef === (scope === 'family' ? activeFamilyId : authUser.id)).map((category) => <option key={category.id} value={category.id}>{category.icon} {category.name}</option>)}</select></label><div className="form-grid"><label className="input-label">วงเงิน (บาท)<input type="number" min="0.01" step="0.01" value={budgetEditDraft.amount} onChange={(event) => setBudgetEditDraft({ ...budgetEditDraft, amount: event.target.value })} required/></label><label className="input-label">เตือนเมื่อใช้ถึง (%)<input type="number" min="1" max="100" value={budgetEditDraft.alertPercent} onChange={(event) => setBudgetEditDraft({ ...budgetEditDraft, alertPercent: event.target.value })} required/></label></div><label className="input-label">รอบงบ<select value={budgetEditDraft.periodType} onChange={(event) => setBudgetEditDraft({ ...budgetEditDraft, periodType: event.target.value as Budget['periodType'] })}><option value="monthly">รายเดือน</option><option value="custom">ช่วงวันที่กำหนด</option></select></label>{budgetEditDraft.periodType === 'monthly' ? <label className="input-label">วันที่เริ่มรอบของเดือน<input type="number" min="1" max="28" value={budgetEditDraft.cycleStartDay} onChange={(event) => setBudgetEditDraft({ ...budgetEditDraft, cycleStartDay: event.target.value })} required/></label> : <div className="form-grid"><label className="input-label">วันเริ่มรอบ<input type="date" value={budgetEditDraft.periodStart} onChange={(event) => setBudgetEditDraft({ ...budgetEditDraft, periodStart: event.target.value })} required/></label><label className="input-label">วันสิ้นสุดรอบ<input type="date" min={budgetEditDraft.periodStart} value={budgetEditDraft.periodEnd} onChange={(event) => setBudgetEditDraft({ ...budgetEditDraft, periodEnd: event.target.value })} required/></label></div>}<div className="modal-footer"><span>แจ้งเตือนตามยอดใช้จริง</span>{budgetEditDraft.id && <button type="button" className="secondary-button" onClick={() => { const id = budgetEditDraft.id!; const category = budgets.find((item) => item.id === id)?.category || 'งบประมาณ'; askConfirmation(`ปิดงบ “${category}” หรือไม่?`, () => archiveBudget(id)) }}>ปิดงบ</button>}<button type="button" className="secondary-button" onClick={() => setBudgetEditDraft(null)}>ยกเลิก</button><button type="submit" className="primary-button"><Check size={16}/> บันทึก</button></div></form></section></div>}
      {budgetMoveDraft && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setBudgetMoveDraft(null) }}><section className="composer-modal" role="dialog" aria-modal="true" aria-labelledby="budget-move-title"><div className="modal-heading"><div><div className="modal-kicker">ปรับวงเงินตามแผน</div><h2 id="budget-move-title">ย้ายงบระหว่างหมวด</h2></div><button className="icon-button" onClick={() => setBudgetMoveDraft(null)} aria-label="ปิด"><X size={19}/></button></div><form onSubmit={saveBudgetMovement}><label className="input-label">งบต้นทาง<select value={budgetMoveDraft.fromBudgetId} onChange={(event) => setBudgetMoveDraft({ ...budgetMoveDraft, fromBudgetId: event.target.value, toBudgetId: budgets.find((budget) => String(budget.id) !== event.target.value)?.id.toString() || '' })}>{budgets.map((budget) => <option key={budget.id} value={budget.id}>{budget.category} · เหลือ ฿{formatMoney(Math.max(0, budget.amount - budget.spent))}</option>)}</select></label><label className="input-label">งบปลายทาง<select value={budgetMoveDraft.toBudgetId} onChange={(event) => setBudgetMoveDraft({ ...budgetMoveDraft, toBudgetId: event.target.value })}>{budgets.filter((budget) => String(budget.id) !== budgetMoveDraft.fromBudgetId).map((budget) => <option key={budget.id} value={budget.id}>{budget.category}</option>)}</select></label><label className="input-label">จำนวนเงินที่ย้าย<input type="number" min="0.01" step="0.01" max={Math.max(0, (budgets.find((budget) => String(budget.id) === budgetMoveDraft.fromBudgetId)?.amount || 0) - (budgets.find((budget) => String(budget.id) === budgetMoveDraft.fromBudgetId)?.spent || 0))} value={budgetMoveDraft.amount} onChange={(event) => setBudgetMoveDraft({ ...budgetMoveDraft, amount: event.target.value })} required/></label><div className="modal-footer"><span>ไม่เปลี่ยนยอดเงินจริง</span><button type="button" className="secondary-button" onClick={() => setBudgetMoveDraft(null)}>ยกเลิก</button><button type="submit" className="primary-button"><Check size={16}/> ย้ายงบ</button></div></form></section></div>}
      {recurringDraft && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setRecurringDraft(null) }}><section className="composer-modal recurring-editor" role="dialog" aria-modal="true" aria-labelledby="recurring-editor-title"><div className="modal-heading"><div><div className="modal-kicker">{recurringDraft.id ? 'แก้ไขกติกาประจำ' : 'ตั้งรอบรายการ'}</div><h2 id="recurring-editor-title">รายการประจำรอตรวจ</h2></div><button className="icon-button" onClick={() => setRecurringDraft(null)} aria-label="ปิด"><X size={19}/></button></div><form onSubmit={saveRecurringRule}>
        <div className="kind-tabs">{([{ key: 'expense', label: 'รายจ่าย', icon: <ArrowUpRight size={15}/> }, { key: 'income', label: 'รายรับ', icon: <ArrowDownRight size={15}/> }, { key: 'transfer', label: 'โอนเงิน', icon: <ArrowLeftRight size={15}/> }] as const).map((item) => <button key={item.key} type="button" disabled={Boolean(recurringDraft.id)} className={recurringDraft.kind === item.key ? `${item.key} active` : ''} onClick={() => { const nextCategory = categoryItems.find((category) => category.ownerType === (recurringDraft.scope === 'family' ? 'family' : 'user') && category.ownerRef === (recurringDraft.scope === 'family' ? recurringDraft.familyId : authUser.id) && category.kind === item.key); setRecurringDraft({ ...recurringDraft, kind: item.key, categoryId: String(nextCategory?.id || '') }) }}>{item.icon}{item.label}</button>)}</div>
        <div className="form-grid"><label className="input-label">ชื่อรายการ<input value={recurringDraft.title} onChange={(event) => setRecurringDraft({ ...recurringDraft, title: event.target.value })} maxLength={160} required/></label><label className="input-label">จำนวนเงิน (บาท)<input type="number" min="0.01" step="0.01" value={recurringDraft.amount} onChange={(event) => setRecurringDraft({ ...recurringDraft, amount: event.target.value })} required/></label></div>
        {recurringDraft.kind !== 'transfer' && <label className="input-label">หมวดหมู่<select value={recurringDraft.categoryId} onChange={(event) => setRecurringDraft({ ...recurringDraft, categoryId: event.target.value })} required><option value="">เลือกหมวดหมู่</option>{recurringCategoriesForDraft.filter((category) => category.kind === recurringDraft.kind).map((category) => <option key={category.id} value={category.id}>{category.icon} {category.name}</option>)}</select></label>}
        <div className="form-grid"><label className="input-label">บัญชีต้นทาง<select value={recurringDraft.sourceAccountId} onChange={(event) => setRecurringDraft({ ...recurringDraft, sourceAccountId: event.target.value })} required><option value="">เลือกบัญชี</option>{recurringAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>{recurringDraft.kind === 'transfer' && <label className="input-label">บัญชีปลายทาง<select value={recurringDraft.destinationAccountId} onChange={(event) => setRecurringDraft({ ...recurringDraft, destinationAccountId: event.target.value })} required><option value="">เลือกบัญชีปลายทาง</option>{recurringDestinations.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}</select></label>}</div>
        <div className="form-grid"><label className="input-label">ความถี่<select value={recurringDraft.frequency} onChange={(event) => setRecurringDraft({ ...recurringDraft, frequency: event.target.value as RecurringDraft['frequency'] })}><option value="weekly">รายสัปดาห์</option><option value="monthly">รายเดือน</option><option value="yearly">รายปี</option></select></label><label className="input-label">ทุกกี่รอบ<input type="number" min="1" max="52" value={recurringDraft.intervalCount} onChange={(event) => setRecurringDraft({ ...recurringDraft, intervalCount: event.target.value })} required/></label>{recurringDraft.frequency === 'monthly' && <label className="input-label">วันที่ของเดือน<input type="number" min="1" max="31" value={recurringDraft.dayOfMonth} onChange={(event) => setRecurringDraft({ ...recurringDraft, dayOfMonth: event.target.value })} required/></label>}</div>
        <div className="form-grid"><label className="input-label">เริ่มวันที่<input type="date" value={recurringDraft.startsOn} disabled={Boolean(recurringDraft.id)} onChange={(event) => setRecurringDraft({ ...recurringDraft, startsOn: event.target.value })} required/></label><label className="input-label">สิ้นสุด (เว้นว่างได้)<input type="date" min={recurringDraft.startsOn} value={recurringDraft.endsOn} onChange={(event) => setRecurringDraft({ ...recurringDraft, endsOn: event.target.value })}/></label></div>
        <div className="form-grid"><label className="input-label">เจ้าของรายการ<select value={recurringDraft.owner} onChange={(event) => setRecurringDraft({ ...recurringDraft, owner: event.target.value })}>{recurringDraft.scope === 'family' && <option value="ครอบครัว">ครอบครัว</option>}{recurringMemberNames.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>{recurringDraft.kind === 'expense' && <label className="input-label">ผู้จ่าย<select value={recurringDraft.payer} onChange={(event) => setRecurringDraft({ ...recurringDraft, payer: event.target.value })}>{recurringDraft.scope === 'family' && <option value="ครอบครัว">ครอบครัว</option>}{recurringMemberNames.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>}</div>
        <div className="modal-footer"><span>{recurringDraft.scope === 'family' ? 'ขอบเขตครอบครัว' : 'ขอบเขตส่วนตัว'}</span><button type="button" className="secondary-button" onClick={() => setRecurringDraft(null)}>ยกเลิก</button><button type="submit" className="primary-button"><Check size={16}/> บันทึกกติกา</button></div>
      </form></section></div>}
      {recurringReviewDraft && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setRecurringReviewDraft(null) }}><section className="composer-modal" role="dialog" aria-modal="true" aria-labelledby="review-recurring-title"><div className="modal-heading"><div><div className="modal-kicker">ตรวจรอบรายการประจำ</div><h2 id="review-recurring-title">แก้ไขก่อนบันทึก</h2></div><button className="icon-button" onClick={() => setRecurringReviewDraft(null)} aria-label="ปิด"><X size={19}/></button></div><form onSubmit={saveRecurringReviewDraft}><label className="input-label">ชื่อรายการ<input value={recurringReviewDraft.title} onChange={(event) => setRecurringReviewDraft({ ...recurringReviewDraft, title: event.target.value })} maxLength={160} required/></label><div className="form-grid"><label className="input-label">จำนวนเงิน (บาท)<input type="number" min="0.01" step="0.01" value={recurringReviewDraft.amount} onChange={(event) => setRecurringReviewDraft({ ...recurringReviewDraft, amount: event.target.value })} required/></label><label className="input-label">วันที่รายการ<input type="date" value={recurringReviewDraft.date} onChange={(event) => setRecurringReviewDraft({ ...recurringReviewDraft, date: event.target.value })} required/></label></div><div className="modal-footer"><span>ยอดจะเข้าบัญชีหลังยืนยัน</span><button type="button" className="secondary-button" onClick={() => setRecurringReviewDraft(null)}>ยกเลิก</button><button type="submit" className="primary-button"><Check size={16}/> ยืนยันและบันทึก</button></div></form></section></div>}
      {confirmation && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmation(null) }}><section className="composer-modal confirmation-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirmation-title" aria-describedby="confirmation-message"><div className="modal-heading"><div><div className="modal-kicker">โปรดยืนยัน</div><h2 id="confirmation-title">ยืนยันการทำรายการ</h2></div><button className="icon-button" onClick={() => setConfirmation(null)} aria-label="ปิด"><X size={19}/></button></div><p id="confirmation-message">{confirmation.message}</p><div className="modal-footer"><span>ตรวจสอบก่อนดำเนินการ</span><button type="button" className="secondary-button" onClick={() => setConfirmation(null)}>ยกเลิก</button><button type="button" className="primary-button" onClick={() => { const pending = confirmation; setConfirmation(null); void pending.onConfirm() }}>ยืนยัน</button></div></section></div>}
      {toast && <div className="toast"><Check size={16}/>{toast}</div>}
    </div>
  )
}

function SummaryCard({ label, amount, detail, trend, tone, icon }: { label: string; amount: number; detail: string; trend: string; tone: string; icon: ReactNode }) {
  return <article className="summary-card"><div className="summary-top"><span>{label}</span><div className={`summary-icon ${tone}`}>{icon}</div></div><div className="summary-amount"><span className="currency">฿</span>{formatMoney(amount)}</div><div className="summary-bottom"><span className="summary-detail">{detail}</span><span className={`trend ${tone}`}>{trend}</span></div></article>
}

function AuthShell({ children }: { children: ReactNode }) {
  return <div className="auth-shell"><div className="auth-brand"><div className="brand-mark"><Wallet size={19} strokeWidth={2.4}/></div><div><strong>อุ่นใจ</strong><span>จัดการเงินให้ง่ายขึ้น</span></div></div>{children}</div>
}

function AuthScreen({ resetToken, inviteToken, initialMessage, onAuthenticated }: { resetToken: string; inviteToken: string; initialMessage: string; onAuthenticated: (user: AuthUser) => void }) {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot' | 'reset'>(resetToken ? 'reset' : 'login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState(initialMessage)
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage('')
    const path = mode === 'register' ? 'register' : mode === 'forgot' ? 'forgot-password' : mode === 'reset' ? 'reset-password' : 'login'
    const body = mode === 'register' ? { displayName: name, email, password, inviteToken }
      : mode === 'reset' ? { token: resetToken, password }
        : { email, ...(mode === 'login' ? { password } : {}) }
    try {
      const response = await apiFetch(`/api/auth/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const result = await response.json() as { user?: AuthUser; message?: string; error?: string }
      if (!response.ok) throw new Error(result.error || 'ทำรายการไม่สำเร็จ')
      if (result.user) { onAuthenticated(result.user); return }
      setMessage(result.message || 'ดำเนินการเรียบร้อย')
      if (mode === 'register' || mode === 'reset') setMode('login')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'เชื่อมต่อระบบไม่สำเร็จ') }
    finally { setBusy(false) }
  }
  const title = mode === 'register' ? 'สร้างบัญชีของคุณ' : mode === 'forgot' ? 'กู้คืนบัญชี' : mode === 'reset' ? 'ตั้งรหัสผ่านใหม่' : 'เข้าสู่ระบบ'
  return <AuthShell><section className="auth-card"><div className="auth-eyebrow">บัญชีส่วนตัวและครอบครัว</div><h1>{title}</h1><p className="auth-intro">รายการการเงินของคุณจะแสดงเฉพาะหลังเข้าสู่ระบบ</p>
    <form className="auth-form" onSubmit={submit}>
      {mode === 'register' && <label>ชื่อที่แสดง<input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required/></label>}
      {mode !== 'reset' && <label>อีเมล<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} required/></label>}
      {(mode === 'login' || mode === 'register' || mode === 'reset') && <label>{mode === 'reset' ? 'รหัสผ่านใหม่' : 'รหัสผ่าน'}<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} minLength={15} maxLength={128} required/><small>อย่างน้อย 15 ตัวอักษร</small></label>}
      {(message || inviteToken) && <div className="auth-message" role="status">{message || 'คุณได้รับคำเชิญเข้าร่วมครอบครัวแล้ว เข้าสู่ระบบหรือสร้างบัญชีเพื่อดำเนินการต่อ'}</div>}
      <button className="primary-button auth-submit" type="submit" disabled={busy}>{busy ? 'กำลังดำเนินการ…' : title}</button>
    </form>
    <div className="auth-links">{mode === 'login' && <><button onClick={() => { setMode('forgot'); setMessage('') }}>ลืมรหัสผ่าน?</button><button onClick={() => { setMode('register'); setMessage('') }}>สร้างบัญชีใหม่</button></>}{mode === 'register' && <button onClick={() => { setMode('login'); setMessage('') }}>มีบัญชีแล้ว? เข้าสู่ระบบ</button>}{mode === 'forgot' && <button onClick={() => { setMode('login'); setMessage('') }}>กลับไปเข้าสู่ระบบ</button>}{mode === 'reset' && <button onClick={() => { setMode('login'); setMessage('') }}>กลับไปเข้าสู่ระบบ</button>}</div>
  </section></AuthShell>
}

function BudgetRow({ icon, name, used, limit, color }: { icon: string; name: string; used: number; limit: number; color: string }) {
  const percent = Math.min(Math.round(used / limit * 100), 100)
  return <div className="budget-row"><div className="budget-row-top"><span className="budget-name"><span className="budget-emoji">{icon}</span>{name}</span><span className="budget-amount"><b>฿{formatMoney(used)}</b><span> / ฿{formatMoney(limit)}</span></span></div><div className="progress-track"><span className={`progress-fill ${color}`} style={{ width: `${percent}%` }}/></div><div className="budget-percent">ใช้ไป {percent}%</div></div>
}

function ReportBreakdown({ items, icon, color }: { items: { name: string; amount: number }[]; icon: string; color: string }) {
  const maxAmount = Math.max(0, ...items.map((item) => item.amount))
  return items.length ? <div className="report-breakdown">{items.map((item) => <div className="report-breakdown-row" key={item.name}><div className="report-breakdown-heading"><span className="budget-emoji">{icon}</span><strong>{item.name}</strong><b>฿{formatMoney(item.amount)}</b></div><div className="progress-track" aria-label={`${item.name} ${formatMoney(item.amount)} บาท`}><span className={`progress-fill ${color}`} style={{ width: `${maxAmount > 0 ? item.amount / maxAmount * 100 : 0}%` }}/></div></div>)}</div> : <div className="empty-state">ไม่มีรายการในช่วงวันที่นี้</div>
}

function TransactionTable({ rows, onEdit, onTrash, onRestore, onHistory, onDeleteReceipt, onSplit }: { rows: Transaction[]; onEdit?: (item: Transaction) => void; onTrash?: (item: Transaction) => void; onRestore?: (item: Transaction) => void; onHistory?: (item: Transaction) => void; onDeleteReceipt?: (item: Transaction) => void; onSplit?: (item: Transaction) => void }) {
  return <div className="transaction-table"><div className="table-head"><span>รายการ</span><span>วันที่</span><span>บัญชีเงิน</span><span>เจ้าของรายการ</span><span className="align-right">จำนวนเงิน</span></div>{rows.length ? rows.map((item) => <div className="transaction-row" key={item.id}><div className="transaction-name"><span className={`transaction-icon ${item.kind}`}>{item.icon}</span><span><strong>{item.title}</strong><small>{item.category}</small></span>{(onEdit || onTrash || onRestore || onHistory || item.receiptId || onSplit && item.kind !== 'transfer') && <div className="transaction-actions">{item.receiptId && <><button title="ดูภาพสลิป" aria-label={`ดูสลิป ${item.title}`} onClick={() => window.open(`/api/receipts/${item.receiptId}/content`, '_blank', 'noopener')}><FileImage size={14}/></button>{onDeleteReceipt && <button title="ลบภาพสลิป" aria-label={`ลบสลิป ${item.title}`} onClick={() => onDeleteReceipt(item)}><X size={14}/></button>}</>}{onSplit && item.kind !== 'transfer' && <button title="แบ่งตามหมวดและเจ้าของ" aria-label={`แบ่งรายการ ${item.title}`} onClick={() => onSplit(item)}><Users size={14}/></button>}{onEdit && <button title="แก้ไขรายการ" aria-label={`แก้ไข ${item.title}`} onClick={() => onEdit(item)}><Settings2 size={14}/></button>}{onTrash && <button title="ย้ายไปถังขยะ" aria-label={`ลบ ${item.title}`} onClick={() => onTrash(item)}><Trash2 size={14}/></button>}{onRestore && <button title="กู้คืนรายการ" aria-label={`กู้คืน ${item.title}`} onClick={() => onRestore(item)}><RotateCcw size={14}/></button>}{onHistory && <button title="ประวัติรายการ" aria-label={`ประวัติ ${item.title}`} onClick={() => onHistory(item)}><History size={14}/></button>}</div>}</div><span className="transaction-date">{item.date}</span><span className="transaction-account">{item.account}</span><span className="owner-chip"><i className={item.owner === 'ครอบครัว' ? 'family-dot' : ''}/><span>{item.owner}<small>{item.kind === 'expense' ? `จ่ายโดย ${item.payer ?? item.recorder}` : `บันทึกโดย ${item.recorder}`}</small></span></span><strong className={`transaction-amount ${item.kind}`}>{item.kind === 'income' ? '+' : item.kind === 'transfer' ? '↗ ' : '−'}฿{formatMoney(item.amount)}</strong></div>) : <div className="empty-state"><Search size={20}/>{onRestore ? 'ถังขยะว่างเปล่า' : 'ไม่พบรายการที่ตรงกับตัวกรอง'}</div>}</div>
}

function AccountRow({ icon, title, owner, amount, tone }: { icon: ReactNode; title: string; owner: string; amount: string; tone: string }) {
  return <div className="account-row"><div className={`account-icon ${tone}`}>{icon}</div><div className="account-copy"><strong>{title}</strong><span>{owner}</span></div><div className="account-amount"><strong>฿{amount}</strong><span>ยอดคงเหลือ</span></div></div>
}

function TransactionPagination({ info, onPageChange }: { info: TransactionPageInfo; onPageChange: (page: number) => void }) {
  if (!info.totalPages) return null
  const first = (info.page - 1) * info.pageSize + 1
  const last = Math.min(info.page * info.pageSize, info.total)
  return <nav className="transaction-pagination" aria-label="แบ่งหน้ารายการ"><span>แสดง {first}–{last} จาก {info.total}</span><div><button type="button" className="secondary-button" disabled={info.page <= 1} onClick={() => onPageChange(info.page - 1)}>ก่อนหน้า</button><span>หน้า {info.page} / {info.totalPages}</span><button type="button" className="secondary-button" disabled={info.page >= info.totalPages} onClick={() => onPageChange(info.page + 1)}>ถัดไป</button></div></nav>
}

function PageContent({ page, rows, authUser, onExportAccount, reportSummary, reportLoading, transactionsLoading, transactionPageInfo, onTransactionPageChange, search, familyInfo, activeFamilyId, inviteLink, onCreateInvitation, onRevokeInvitation, onLeaveFamily, onCloseInvite, onSearch, kindFilter, onKindFilter, onAdd, onEdit, onTrash, onRestore, onHistory, onSplit, onDeleteReceipt, onToast, scope, moneyAccounts, categories, budgets, budgetMovements, onCreateBudget, onMoveBudget, onManageBudget, onCreateAccount, onEditAccount, onArchiveAccount, onOpenCategoryEditor, onEditCategory, onArchiveCategory, canManageFamilyFinancials, recurringRules, recurringReviews, onCreateRecurringRule, onEditRecurringRule, onToggleRecurringRule, onReviewRecurring, onEditAndReviewRecurring }: { page: string; rows: Transaction[]; authUser: AuthUser; onExportAccount: () => void; reportSummary: ReportSummary | null; reportLoading: boolean; transactionsLoading: boolean; transactionPageInfo: TransactionPageInfo; onTransactionPageChange: (page: number) => void; search: string; familyInfo: FamilyInfo[]; activeFamilyId: number | null; inviteLink: string; onCreateInvitation: (familyId: number) => void; onRevokeInvitation: (familyId: number, invitationId: number) => void; onLeaveFamily: (familyId: number) => void; onCloseInvite: () => void; onSearch: (value: string) => void; kindFilter: string; onKindFilter: (value: string) => void; onAdd: () => void; onEdit: (item: Transaction) => void; onTrash: (item: Transaction) => void; onRestore: (item: Transaction) => void; onHistory: (item: Transaction) => void; onSplit: (item: Transaction) => void; onDeleteReceipt: (item: Transaction) => void; onToast: (message: string) => void; scope: Scope; moneyAccounts: MoneyAccount[]; categories: Category[]; budgets: Budget[]; budgetMovements: BudgetMovement[]; onCreateBudget: () => void; onMoveBudget: () => void; onManageBudget: (budget: Budget) => void; onCreateAccount: () => void; onEditAccount: (account: MoneyAccount) => void; onArchiveAccount: (account: MoneyAccount) => void; onOpenCategoryEditor: (kind: 'income' | 'expense', category?: Category) => void; onEditCategory: (category: Category) => void; onArchiveCategory: (category: Category) => void; canManageFamilyFinancials: boolean; recurringRules: RecurringRule[]; recurringReviews: RecurringReview[]; onCreateRecurringRule: () => void; onEditRecurringRule: (rule: RecurringRule) => void; onToggleRecurringRule: (rule: RecurringRule) => void; onReviewRecurring: (review: RecurringReview, action: 'confirm' | 'dismiss', edits?: { title: string; amount: number; occurredAt: string }) => void; onEditAndReviewRecurring: (review: RecurringReview) => void }) {
  if (transactionsLoading && ['รายการทั้งหมด', 'ถังขยะ'].includes(page)) return <div className="panel full-page-panel"><div className="empty-state" role="status">กำลังโหลดรายการ…</div></div>
  if (reportLoading && page === 'รายงาน') return <div className="page-cards"><div className="panel full-page-panel"><div className="empty-state" role="status">กำลังคำนวณรายงาน…</div></div></div>
  if (page === 'ตั้งค่า') return <div className="page-cards settings-page"><section className="panel settings-panel"><div className="panel-header"><div><div className="panel-title">บัญชีผู้ใช้</div><div className="panel-subtitle">ข้อมูลบัญชีที่ใช้เข้าสู่ระบบ</div></div></div><div className="settings-profile"><div className="avatar settings-avatar">{authUser.displayName.slice(0, 1)}</div><div><strong>{authUser.displayName}</strong><span>{authUser.email}</span><small>{authUser.systemRole === 'superadmin' ? 'Super Admin' : 'สมาชิก'}</small></div></div></section><section className="panel settings-panel"><div className="panel-header"><div><div className="panel-title">ส่งออกข้อมูล</div><div className="panel-subtitle">ดาวน์โหลดข้อมูลที่บัญชีนี้มีสิทธิ์เข้าถึง</div></div></div><p className="settings-description">ไฟล์ JSON มีข้อมูลโปรไฟล์ ครอบครัวที่เข้าร่วม บัญชีเงิน หมวดหมู่ งบ รายการรวมถังขยะ ส่วนแบ่ง ประวัติ รายการประจำ และข้อมูลสลิป ลิงก์ในไฟล์ใช้เปิดภาพแนบขณะเข้าสู่ระบบ</p><button className="primary-button" onClick={onExportAccount}><Download size={16}/> ดาวน์โหลดข้อมูลบัญชี</button></section><section className="panel settings-panel"><div className="panel-header"><div><div className="panel-title">การปิดบัญชี</div><div className="panel-subtitle">ยังต้องกำหนดวิธีเก็บประวัติครอบครัวก่อนเปิดใช้</div></div></div><p className="settings-description">รายการครอบครัวต้องคงอยู่เมื่อสมาชิกออก การลบบัญชีจึงยังไม่เปิดจนกว่าจะกำหนดว่าจะจัดการชื่อผู้บันทึก รายการส่วนตัว และข้อมูลที่ต้องเก็บย้อนหลังอย่างไร</p></section></div>
  if (page === 'ถังขยะ') return <div className="panel full-page-panel"><div className="panel-header"><div><div className="panel-title">ถังขยะ</div><div className="panel-subtitle">รายการที่ลบจะไม่รวมในสรุป และกู้คืนได้ · {transactionPageInfo.total} รายการ</div></div></div><TransactionTable rows={rows} onRestore={onRestore} onDeleteReceipt={onDeleteReceipt}/><TransactionPagination info={transactionPageInfo} onPageChange={onTransactionPageChange}/></div>
  if (page === 'รายการทั้งหมด') return <div className="panel full-page-panel"><div className="list-toolbar"><div className="search-field"><Search size={16}/><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="ค้นหารายการ"/></div><select className="filter-select" value={kindFilter} onChange={(event) => onKindFilter(event.target.value)} aria-label="กรองประเภทรายการ"><option>ทั้งหมด</option><option>รายรับ</option><option>รายจ่าย</option><option>โอน</option></select><button className="primary-button" onClick={onAdd}><Plus size={16}/> เพิ่มรายการ</button></div><TransactionTable rows={rows} onEdit={onEdit} onTrash={onTrash} onHistory={onHistory} onDeleteReceipt={onDeleteReceipt} onSplit={onSplit}/><TransactionPagination info={transactionPageInfo} onPageChange={onTransactionPageChange}/></div>
  if (page === 'รายงาน') {
    const income = reportSummary?.income || 0
    const expense = reportSummary?.expense || 0
    const categoryGroups = reportSummary?.categories || []
    const owners = reportSummary?.owners || []
    const accounts = reportSummary?.accounts || []
    return <div className="page-cards"><div className="summary-grid"><SummaryCard label="รายรับ" amount={income} detail="ตามช่วงวันที่ที่เลือก" trend="รวม" tone="green" icon={<ArrowDownLeft size={18}/>}/><SummaryCard label="รายจ่าย" amount={expense} detail="ตามช่วงวันที่ที่เลือก" trend="รวม" tone="orange" icon={<ArrowUpRight size={18}/>}/><SummaryCard label="เงินสุทธิ" amount={income-expense} detail="ไม่นับรายการโอน" trend="สุทธิ" tone="blue" icon={<Wallet size={18}/>}/></div><div className="panel"><div className="panel-header"><div><div className="panel-title">แยกตามหมวดหมู่</div><div className="panel-subtitle">ยอดรวมตามหมวดในช่วงที่เลือก</div></div></div><ReportBreakdown items={categoryGroups} icon="🧾" color="teal"/></div><div className="panel"><div className="panel-header"><div><div className="panel-title">แยกตามเจ้าของรายการ</div><div className="panel-subtitle">ไม่รวมรายการโอน</div></div></div><ReportBreakdown items={owners} icon="👤" color="blue"/></div><div className="panel"><div className="panel-header"><div><div className="panel-title">แยกตามบัญชีเงิน</div><div className="panel-subtitle">ยอดรายรับและรายจ่ายของบัญชีตามช่วงวันที่</div></div></div><ReportBreakdown items={accounts} icon="🏦" color="purple"/></div></div>
  }
  if (page === 'งบประมาณ') return <div className="page-cards"><div className="panel full-page-panel"><div className="panel-header"><div><div className="panel-title">งบ{scope === 'family' ? 'ครอบครัว' : 'ส่วนตัว'}</div><div className="panel-subtitle">ยอดใช้ {formatMoney(budgets.reduce((sum, budget) => sum + budget.spent, 0))} / วงเงิน {formatMoney(budgets.reduce((sum, budget) => sum + budget.amount, 0))} บาท · รอบคำนวณปัจจุบัน</div></div><div className="heading-actions">{budgets.length > 1 && (scope === 'personal' || canManageFamilyFinancials) && <button className="secondary-button" onClick={onMoveBudget}>ย้ายงบ</button>}{(scope === 'personal' || canManageFamilyFinancials) && <button className="primary-button" onClick={onCreateBudget}><Plus size={16}/> เพิ่มงบ</button>}</div></div>{budgets.length ? budgets.map((budget) => <div className="budget-live-row" key={budget.id}><BudgetRow icon={budget.icon} name={budget.category} used={budget.spent} limit={budget.amount} color={budget.spent >= budget.amount ? 'orange' : 'teal'}/><div className="budget-live-meta"><span>แจ้งเตือนเมื่อใช้ {budget.alertPercent}% · {budget.periodType === 'monthly' ? `รอบเริ่มวันที่ ${budget.cycleStartDay}` : `${budget.periodStart} ถึง ${budget.periodEnd}`}</span>{budget.spent >= budget.amount * budget.alertPercent / 100 && <strong className="budget-alert">{budget.spent > budget.amount ? 'เกินงบแล้ว' : 'ใกล้ถึงงบ'}</strong>}{(scope === 'personal' || canManageFamilyFinancials) && <button className="secondary-button" onClick={() => onManageBudget(budget)}>จัดการ</button>}</div></div>) : <div className="empty-state">ยังไม่มีงบในขอบเขตนี้</div>}</div>{budgetMovements.length > 0 && <div className="panel full-page-panel"><div className="panel-header"><div><div className="panel-title">ประวัติย้ายงบ</div><div className="panel-subtitle">ไม่เปลี่ยนยอดเงินจริง · แสดง 100 รายการล่าสุด</div></div></div>{budgetMovements.map((movement) => <div className="recurring-review-row" key={movement.id}><div className="recurring-copy"><strong>{movement.fromCategory} → {movement.toCategory} · ฿{formatMoney(movement.amount)}</strong><span>{movement.movedBy} · {new Date(movement.createdAt).toLocaleString('th-TH')}{movement.note ? ` · ${movement.note}` : ''}</span></div></div>)}</div>}</div>
  if (page === 'รายการประจำ') return <div className="page-cards recurring-page"><div className="panel full-page-panel"><div className="panel-header"><div><div className="panel-title">รายการรอตรวจ</div><div className="panel-subtitle">ยืนยันแล้วจึงกระทบยอดบัญชีเงิน · {recurringReviews.length} รายการรอการยืนยัน</div></div><button className="primary-button" onClick={onCreateRecurringRule}><Plus size={16}/> ตั้งรายการประจำ</button></div>{recurringReviews.map((review) => <article className="recurring-review-row" key={review.id}><div className={`transaction-icon ${review.transaction.kind}`}>{review.transaction.kind === 'income' ? '↙' : review.transaction.kind === 'transfer' ? '↗' : '↖'}</div><div className="recurring-copy"><strong>{review.transaction.title}</strong><span>{review.reviewDate} · {review.transaction.kind === 'income' ? 'รายรับ' : review.transaction.kind === 'transfer' ? 'โอน' : 'รายจ่าย'} · {review.createdBy}</span></div><strong className={`transaction-amount ${review.transaction.kind}`}>฿{formatMoney(review.transaction.amount)}</strong>{review.canManage && <div className="recurring-actions"><button className="secondary-button" onClick={() => onReviewRecurring(review, 'dismiss')}>ไม่บันทึกรอบนี้</button><button className="secondary-button" onClick={() => onEditAndReviewRecurring(review)}>แก้ก่อนยืนยัน</button><button className="primary-button" onClick={() => onReviewRecurring(review, 'confirm')}><Check size={15}/> ยืนยัน</button></div>}</article>)}{!recurringReviews.length && <div className="empty-state">ไม่มีรายการประจำที่รอตรวจในขอบเขตนี้</div>}</div><div className="panel full-page-panel"><div className="panel-header"><div><div className="panel-title">กติกาประจำ</div><div className="panel-subtitle">แต่ละรอบจะสร้างรายการรอตรวจเมื่อเปิดแอป</div></div></div>{recurringRules.map((rule) => <article className="recurring-review-row" key={rule.id}><div className={`transaction-icon ${rule.kind}`}>{rule.kind === 'income' ? '↙' : rule.kind === 'transfer' ? '↗' : '↖'}</div><div className="recurring-copy"><strong>{rule.title} · ฿{formatMoney(rule.amount)}</strong><span>{rule.frequency === 'weekly' ? 'ทุกสัปดาห์' : rule.frequency === 'monthly' ? `ทุกเดือน วันที่ ${rule.dayOfMonth || 'ตามวันที่เริ่ม'}` : 'ทุกปี'} · {rule.paused ? 'หยุดชั่วคราว' : 'ทำงานอยู่'} · บันทึกโดย {rule.createdBy}</span></div>{rule.canManage && <div className="recurring-actions"><button className="secondary-button" onClick={() => onEditRecurringRule(rule)}>แก้ไข</button><button className="secondary-button" onClick={() => onToggleRecurringRule(rule)}>{rule.paused ? 'เปิดใช้งาน' : 'หยุดชั่วคราว'}</button></div>}</article>)}{!recurringRules.length && <div className="empty-state">ยังไม่มีกติกาประจำ</div>}</div></div>
  if (page === 'บัญชีเงิน') return <div className="panel full-page-panel"><div className="panel-header"><div><div className="panel-title">บัญชีเงิน{scope === 'family' ? 'ของครอบครัว' : 'ส่วนตัว'}</div><div className="panel-subtitle">ยอดคงเหลือรวม ฿{formatMoney(moneyAccounts.reduce((sum, account) => sum + account.balance, 0))} · คำนวณจากยอดตั้งต้นและรายการที่บันทึก</div></div>{(scope === 'personal' || canManageFamilyFinancials) && <button className="primary-button" onClick={onCreateAccount}><Plus size={16}/> เพิ่มบัญชี</button>}</div><div className="account-page-grid">{moneyAccounts.map((account) => <div className="money-account-card" key={account.id}><AccountRow icon={account.accountType === 'cash' ? <Banknote size={18}/> : account.accountType === 'bank' ? <Landmark size={18}/> : <CreditCard size={18}/>} title={account.name} owner={`${account.ownerType === 'family' ? 'ครอบครัว' : 'ส่วนตัว'} · ${account.accountType === 'cash' ? 'เงินสด' : account.accountType === 'bank' ? 'ธนาคาร' : 'อื่น ๆ'}`} amount={formatMoney(account.balance)} tone={account.accountType === 'cash' ? 'mint' : account.accountType === 'bank' ? 'violet' : 'blue'}/>{(scope === 'personal' || canManageFamilyFinancials) && <div className="money-account-actions"><button onClick={() => onEditAccount(account)}>แก้ไข</button><button onClick={() => onArchiveAccount(account)}>ปิดบัญชี</button></div>}</div>)}{!moneyAccounts.length && <div className="empty-state">ยังไม่มีบัญชีเงินในขอบเขตนี้</div>}</div></div>
  if (page === 'หมวดหมู่') return <div className="page-cards category-page"><div className="panel"><div className="panel-header"><div><div className="panel-title">หมวดหมู่{scope === 'family' ? 'ครอบครัว' : 'ส่วนตัว'}</div><div className="panel-subtitle">ใช้จัดประเภทของรายรับและรายจ่าย</div></div></div>{(['income', 'expense'] as const).map((kind) => <section key={kind} className="category-group"><div className="category-group-heading"><strong>{kind === 'income' ? 'รายรับ' : 'รายจ่าย'}</strong>{(scope === 'personal' || canManageFamilyFinancials) && <button className="secondary-button" onClick={() => onOpenCategoryEditor(kind)}><Plus size={14}/> เพิ่ม</button>}</div>{categories.filter((category) => category.kind === kind).map((category) => <div className="category-row" key={category.id}><span className="category-icon">{category.icon}</span><strong>{category.name}</strong>{category.isDefault && <small>ค่าเริ่มต้น</small>}{(scope === 'personal' || canManageFamilyFinancials) && <div className="category-actions"><button onClick={() => onEditCategory(category)}>แก้ไข</button><button onClick={() => onArchiveCategory(category)}>ซ่อน</button></div>}</div>)}</section>)}</div><div className="panel page-note"><Tag size={20}/><strong>หมวดหมู่เก็บใน MySQL</strong><p>การซ่อนหมวดหมู่จะไม่เปลี่ยนชื่อหมวดในรายการย้อนหลัง</p></div></div>
  if (page === 'ครอบครัว') return <div className="page-cards"><div className="panel family-panel"><div className="panel-header"><div><div className="panel-title">สมาชิกในบ้าน</div><div className="panel-subtitle">{familyInfo.find((family) => family.id === activeFamilyId)?.name || 'พื้นที่ครอบครัว'}</div></div>{familyInfo.find((family) => family.id === activeFamilyId)?.role === 'owner' && <button className="primary-button" onClick={() => activeFamilyId && onCreateInvitation(activeFamilyId)}><Plus size={16}/> เชิญสมาชิก</button>}</div>{familyInfo.filter((family) => family.id === activeFamilyId).flatMap((family) => <section key={family.id}><div className="member-list">{family.members.map((member, index) => <div className="member-row" key={member.id}><div className={`avatar member-avatar member-${index % 4}`}>{member.displayName.slice(0, 1)}</div><div className="member-copy"><strong>{member.displayName}</strong><span>{member.email}</span></div><span className="member-badge">{member.role === 'owner' ? 'เจ้าของ' : 'สมาชิก'}</span></div>)}</div>{family.role === 'owner' && family.invitations.map((invite) => <div className="member-row" key={invite.id}><div className="avatar member-avatar">✉</div><div className="member-copy"><strong>ลิงก์เชิญรอใช้งาน</strong><span>หมดอายุ {new Date(invite.expiresAt).toLocaleString('th-TH')}</span></div><button className="secondary-button" onClick={() => onRevokeInvitation(family.id, invite.id)}>ยกเลิก</button></div>)}{family.role === 'member' && <button className="secondary-button" onClick={() => onLeaveFamily(family.id)}>ออกจากครอบครัว</button>}</section>)}{!familyInfo.length && <div className="empty-state">ยังไม่มีครอบครัวที่เข้าร่วม</div>}{inviteLink && <div className="invite-result"><strong>ลิงก์เชิญพร้อมแชร์ · ใช้ได้ 7 วัน และใช้ได้ครั้งเดียว</strong><input readOnly value={inviteLink} onFocus={(event) => event.currentTarget.select()}/><button className="primary-button" onClick={() => navigator.clipboard?.writeText(inviteLink).then(() => onToast('คัดลอกลิงก์แล้ว')).catch(() => onToast('เลือกและคัดลอกลิงก์ได้จากช่องด้านบน'))}>คัดลอกลิงก์</button><button className="secondary-button" onClick={onCloseInvite}>ปิด</button></div>}</div><div className="panel page-note"><Users size={20}/><strong>สิทธิ์สมาชิก</strong><p>สมาชิกดูรายการครอบครัวได้ และแก้ไขได้เฉพาะรายการที่ตนบันทึก เจ้าของครอบครัวจัดการรายการทั้งหมดได้</p></div></div>
  return <div className="panel empty-section"><Tag size={24}/><h3>{page}</h3><p>ส่วนนี้จะแสดงรายการและตัวกรองตามขอบเขตข้อมูลของคุณ</p><button className="primary-button" onClick={onAdd}><Plus size={16}/> เพิ่มรายการ</button></div>
}

export default App
