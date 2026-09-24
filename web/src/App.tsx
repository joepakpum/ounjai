import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent, ReactNode } from 'react'
import {
  ArrowDownLeft, ArrowDownRight, ArrowLeftRight, ArrowUpRight, Banknote,
  Bell, CalendarDays, Check, ChevronDown, ChevronRight, CircleHelp, CreditCard,
  Download, FileImage, Landmark, LayoutDashboard, ListFilter, LogOut, Plus,
  Search, Settings2, SlidersHorizontal, Sparkles, Tag, TrendingUp, Upload,
  Users, Wallet, X,
} from 'lucide-react'
import './App.css'

type Kind = 'expense' | 'income' | 'transfer'
type Scope = 'family' | 'personal'
type AuthUser = { id: number; email: string; displayName: string; systemRole: 'user' | 'superadmin'; families: { id: number; name: string; role: 'owner' | 'member' }[] }
type Transaction = {
  id: number; title: string; category: string; kind: Kind; amount: number
  date: string; account: string; owner: string; payer?: string; recorder: string; icon: string; scope: Scope
}

const categories = {
  expense: ['อาหาร', 'เดินทาง', 'ของใช้ในบ้าน', 'บ้าน', 'การศึกษา', 'สุขภาพ', 'ช้อปปิ้ง', 'อื่น ๆ'],
  income: ['เงินเดือน', 'โบนัส', 'รายได้เสริม', 'ดอกเบี้ย', 'เงินคืน', 'อื่น ๆ'],
}

const formatMoney = (value: number) => new Intl.NumberFormat('th-TH', { maximumFractionDigits: 0 }).format(value)

function App() {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [authMessage, setAuthMessage] = useState('')
  const [resetToken, setResetToken] = useState('')
  const [apiStatus, setApiStatus] = useState<'connecting' | 'connected' | 'offline'>('connecting')
  const [scope, setScope] = useState<Scope>('family')
  const [page, setPage] = useState('ภาพรวม')
  const [range, setRange] = useState('เดือนนี้')
  const [search, setSearch] = useState('')
  const [kindFilter, setKindFilter] = useState('ทั้งหมด')
  const [modal, setModal] = useState(false)
  const [toast, setToast] = useState('')
  const [filePreview, setFilePreview] = useState('')
  const [formKind, setFormKind] = useState<Kind>('expense')
  const [formScope, setFormScope] = useState<Scope>('family')
  const [formAmount, setFormAmount] = useState('')
  const [formTitle, setFormTitle] = useState('')
  const [formCategory, setFormCategory] = useState('อาหาร')
  const [formAccount, setFormAccount] = useState('เงินสด')
  const [formDestination, setFormDestination] = useState('KBank •• 4821')
  const [formOwner, setFormOwner] = useState('คุณ')
  const [formPayer, setFormPayer] = useState('คุณ')
  const [monthIndex, setMonthIndex] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let active = true
    const params = new URLSearchParams(window.location.search)
    const verifyToken = params.get('verify')
    const passwordToken = params.get('reset')
    if (passwordToken) setResetToken(passwordToken)
    const cleanUrl = () => {
      params.delete('verify'); params.delete('reset')
      const query = params.toString()
      window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`)
    }
    const restoreSession = async () => {
      if (verifyToken) {
        const response = await fetch('/api/auth/verify-email', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: verifyToken }),
        })
        const result = await response.json() as { user?: AuthUser; error?: string }
        if (active && response.ok && result.user) setAuthUser(result.user)
        if (active) setAuthMessage(response.ok ? 'ยืนยันอีเมลแล้ว บัญชีของคุณพร้อมใช้งาน' : result.error || 'ยืนยันอีเมลไม่สำเร็จ')
        cleanUrl()
      }
      if (!verifyToken || !active) {
        const response = await fetch('/api/auth/me')
        if (active && response.ok) {
          const result = await response.json() as { user: AuthUser }
          setAuthUser(result.user)
        }
      }
      if (active) setAuthChecked(true)
    }
    restoreSession().catch(() => { if (active) setAuthChecked(true) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    let active = true
    if (!authUser) { setTransactions([]); setApiStatus('offline'); return () => { active = false } }
    fetch('/api/transactions')
      .then(async (response) => {
        if (!response.ok) throw new Error('โหลดรายการไม่สำเร็จ')
        return response.json() as Promise<Transaction[]>
      })
      .then((rows) => { if (active) { setTransactions(rows); setApiStatus('connected') } })
      .catch(() => { if (active) setApiStatus('offline') })
    return () => { active = false }
  }, [authUser])

  const filtered = useMemo(() => transactions.filter((item) => {
    const scopeMatches = item.scope === scope
    const typeMatches = kindFilter === 'ทั้งหมด' || (kindFilter === 'รายจ่าย' && item.kind === 'expense') || (kindFilter === 'รายรับ' && item.kind === 'income') || (kindFilter === 'โอน' && item.kind === 'transfer')
    return scopeMatches && typeMatches && item.title.toLowerCase().includes(search.toLowerCase())
  }), [transactions, scope, kindFilter, search])

  const totals = useMemo(() => {
    const visible = transactions.filter((item) => item.scope === scope)
    const income = visible.filter((item) => item.kind === 'income').reduce((sum, item) => sum + item.amount, 0)
    const expense = visible.filter((item) => item.kind === 'expense').reduce((sum, item) => sum + item.amount, 0)
    return { income, expense, net: income - expense }
  }, [transactions, scope])

  function openComposer(kind: Kind = 'expense') {
    setFormKind(kind); setFormScope(scope); setFormCategory(kind === 'income' ? 'เงินเดือน' : 'อาหาร')
    setFormAmount(''); setFormTitle(''); setFilePreview(''); setFormOwner(authUser?.displayName || ''); setFormPayer(authUser?.displayName || ''); setModal(true)
  }

  function notify(message: string) {
    setToast(message); window.setTimeout(() => setToast(''), 2800)
  }

  function handleImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    const preview = URL.createObjectURL(file)
    setFilePreview(preview)
    setFormTitle('ร้านกาแฟ · อ่านข้อมูลตัวอย่าง')
    setFormAmount('185')
    setFormCategory('อาหาร')
    notify('เพิ่มภาพแล้ว · ตัวอย่างนี้ยังไม่ได้เชื่อมระบบอ่านสลิปจริง')
  }

  async function saveTransaction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const amount = Number(formAmount.replaceAll(',', ''))
    if (!amount || amount <= 0) return
    const title = formTitle.trim() || (formKind === 'income' ? 'รายรับใหม่' : formKind === 'transfer' ? 'รายการโอน' : 'รายจ่ายใหม่')
    const body = {
      title, category: formKind === 'transfer' ? 'โอนเงิน' : formCategory,
      kind: formKind, amount, scope: formScope, sourceAccount: formAccount,
      destinationAccount: formDestination, owner: formOwner,
      payer: formKind === 'expense' ? formPayer : undefined, recorder: authUser?.displayName,
      familyId: formScope === 'family' ? authUser?.families[0]?.id : undefined,
      icon: formKind === 'income' ? '💰' : formKind === 'transfer' ? '↗' : '🧾',
    }
    try {
      const response = await fetch('/api/transactions', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      const saved = await response.json() as Transaction | { error?: string }
      if (!response.ok || !('id' in saved)) throw new Error('error' in saved ? saved.error : 'บันทึกรายการไม่สำเร็จ')
      setTransactions((items) => [saved, ...items])
      setApiStatus('connected'); setModal(false); notify('บันทึกลง MySQL แล้ว')
    } catch (error) {
      setApiStatus('offline')
      notify(error instanceof Error ? error.message : 'เชื่อมต่อฐานข้อมูลไม่สำเร็จ')
    }
  }

  const navItems = [
    { label: 'ภาพรวม', icon: LayoutDashboard }, { label: 'รายการทั้งหมด', icon: ListFilter },
    { label: 'งบประมาณ', icon: SlidersHorizontal }, { label: 'บัญชีเงิน', icon: Wallet },
    { label: 'ครอบครัว', icon: Users },
  ]
  const monthText = monthIndex === 0 ? 'กันยายน 2569' : monthIndex < 0 ? 'สิงหาคม 2569' : 'ตุลาคม 2569'

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    setAuthUser(null)
    setTransactions([])
  }

  if (!authChecked) return <AuthShell><div className="auth-loading">กำลังตรวจสอบบัญชี…</div></AuthShell>
  if (!authUser) return <AuthScreen resetToken={resetToken} initialMessage={authMessage} onAuthenticated={setAuthUser} />

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><Wallet size={19} strokeWidth={2.4} /></div><div><strong>อุ่นใจ</strong><span>จัดการเงินให้ง่ายขึ้น</span></div></div>
        <button className="workspace-switch"><div className="workspace-avatar">บ</div><div className="workspace-copy"><strong>{scope === 'family' ? 'บ้านของเรา' : 'พื้นที่ส่วนตัว'}</strong><span>{scope === 'family' ? 'สมาชิก 4 คน' : 'บัญชีส่วนตัว'}</span></div><ChevronDown size={15} /></button>
        <div className="nav-label">เมนูหลัก</div>
        <nav className="nav-list">
          {navItems.map(({ label, icon: Icon }) => <button key={label} onClick={() => setPage(label)} className={`nav-item ${page === label ? 'active' : ''}`}><Icon size={18} strokeWidth={1.8} /><span>{label}</span>{label === 'งบประมาณ' && <span className="nav-count">2</span>}</button>)}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-tip"><div className="tip-icon"><Sparkles size={16} /></div><strong>เริ่มจดได้เลย</strong><p>เพิ่มรายการใหม่เพื่อให้เห็นภาพรวมการเงินของบ้าน</p><button onClick={() => openComposer('expense')}>เพิ่มรายการ <ArrowUpRight size={14} /></button></div>
          <button className="nav-item"><Settings2 size={18} /><span>ตั้งค่า</span></button>
          <div className="profile"><div className="avatar user-avatar">{authUser.displayName.slice(0, 1)}</div><div className="profile-copy"><strong>{authUser.displayName}</strong><span>{authUser.systemRole === 'superadmin' ? 'Super Admin' : authUser.families[0]?.role === 'owner' ? 'เจ้าของครอบครัว' : 'สมาชิกครอบครัว'}</span></div><button className="signout-button" onClick={signOut} aria-label="ออกจากระบบ" title="ออกจากระบบ"><LogOut size={15}/></button></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>พื้นที่ครอบครัว</span><ChevronRight size={14} /><strong>{page}</strong></div>
          <div className="topbar-actions"><span className={`prototype-pill ${apiStatus}`}><span />{apiStatus === 'connected' ? 'MySQL เชื่อมต่อ' : apiStatus === 'connecting' ? 'กำลังเชื่อม MySQL' : 'MySQL ไม่พร้อม'}</span><button className="icon-button notification-button" aria-label="การแจ้งเตือน" onClick={() => notify('ไม่มีการแจ้งเตือนใหม่')}><Bell size={18} /><i /></button><div className="avatar small-avatar">{authUser.displayName.slice(0, 1)}</div></div>
        </header>

        <div className="content-wrap">
          <div className="prototype-warning"><strong>ยังไม่พร้อมเปิดใช้งานผ่านโดเมน</strong><span>บัญชีและรายการมีการแยกสิทธิ์เบื้องต้นแล้ว แต่งบ บัญชีเงิน คำเชิญสมาชิก และสิทธิ์ครอบครัวยังอยู่ระหว่างพัฒนา</span></div>
          <div className="page-heading">
            <div><div className="eyebrow"><span className="eyebrow-dot" /> ภาพรวมการเงิน</div><h1>{page === 'ภาพรวม' ? `สวัสดี, ${authUser.displayName}` : page}</h1><p>{page === 'ภาพรวม' ? 'มาดูภาพรวมการเงินของบ้านในเดือนนี้กัน' : 'ดูข้อมูลและจัดการรายการของคุณได้ที่นี่'}</p></div>
            <div className="heading-actions"><button className="secondary-button" onClick={() => notify('เตรียมดาวน์โหลดรายงานตัวอย่าง')}><Download size={16} /> <span>ส่งออกรายงาน</span></button><button className="primary-button" onClick={() => openComposer('expense')}><Plus size={17} /> เพิ่มรายการ</button></div>
          </div>

          <div className="toolbar">
            <div className="scope-switch" role="tablist" aria-label="ขอบเขตข้อมูล"><button className={scope === 'family' ? 'selected' : ''} onClick={() => setScope('family')}><Users size={15} /> ครอบครัว</button><button className={scope === 'personal' ? 'selected' : ''} onClick={() => setScope('personal')}><Wallet size={15} /> ส่วนตัว</button></div>
            <div className="toolbar-right"><button className="date-picker" onClick={() => setMonthIndex((value) => value === 1 ? -1 : value + 1)}><CalendarDays size={16} />{monthText}<ChevronDown size={14} /></button><div className="period-tabs">{['เดือนนี้', 'กำหนดเอง'].map((item) => <button key={item} onClick={() => setRange(item)} className={range === item ? 'period-active' : ''}>{item}</button>)}</div></div>
          </div>

          {page === 'ภาพรวม' && <>
            <section className="summary-grid">
              <SummaryCard label="รายรับทั้งหมด" amount={totals.income} detail="เทียบกับเดือนที่แล้ว" trend="+12.8%" tone="green" icon={<ArrowDownLeft size={18} />} spark="M2 27 C16 23 15 12 27 17 S39 10 48 13 S60 3 73 8" />
              <SummaryCard label="รายจ่ายทั้งหมด" amount={totals.expense} detail="เทียบกับเดือนที่แล้ว" trend="-4.2%" tone="orange" icon={<ArrowUpRight size={18} />} spark="M2 23 C14 26 17 12 29 18 S43 5 53 12 S64 8 73 3" />
              <SummaryCard label="เงินสุทธิ" amount={totals.net} detail="รายรับหักรายจ่าย" trend="+18.6%" tone="blue" icon={<Wallet size={18} />} spark="M2 25 C12 22 16 19 26 20 S39 9 49 13 S63 5 73 4" />
              <SummaryCard label="งบที่ใช้ไป" amount={20800} detail="จากงบทั้งหมด ฿32,500" trend="64%" tone="purple" icon={<SlidersHorizontal size={18} />} spark="M2 24 C15 23 20 20 29 18 S38 14 49 14 S61 11 73 6" />
            </section>

            <section className="dashboard-grid">
              <div className="panel cashflow-panel">
                <div className="panel-header"><div><div className="panel-title">กระแสเงินสด</div><div className="panel-subtitle">ภาพรวมรายรับและรายจ่าย</div></div><button className="select-chip" onClick={() => setRange(range === 'เดือนนี้' ? '3 เดือน' : 'เดือนนี้')}>{range === 'เดือนนี้' ? '6 เดือนล่าสุด' : '3 เดือนล่าสุด'}<ChevronDown size={14} /></button></div>
                <div className="chart-legend"><span><i className="legend-dot income-dot" /> รายรับ</span><span><i className="legend-dot expense-dot" /> รายจ่าย</span><span className="chart-total">เงินสุทธิ <b>฿35,920</b></span></div>
                <div className="chart-wrap"><div className="y-labels"><span>60k</span><span>40k</span><span>20k</span><span>0</span></div><svg className="line-chart" viewBox="0 0 620 190" preserveAspectRatio="none" role="img" aria-label="กราฟรายรับรายจ่ายหกเดือน"><defs><linearGradient id="incomeFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#2fa47a" stopOpacity=".14"/><stop offset="1" stopColor="#2fa47a" stopOpacity="0"/></linearGradient></defs><path className="grid-line" d="M0 20H620 M0 68H620 M0 116H620 M0 164H620"/><path d="M0 98 C42 86 62 106 103 75 S164 68 207 77 S269 48 310 59 S371 71 413 40 S477 54 517 31 S580 46 620 19 V180 H0Z" fill="url(#incomeFill)"/><path className="income-line" d="M0 98 C42 86 62 106 103 75 S164 68 207 77 S269 48 310 59 S371 71 413 40 S477 54 517 31 S580 46 620 19"/><path className="expense-line" d="M0 136 C40 119 65 132 103 117 S165 119 207 105 S267 122 310 94 S374 111 413 86 S473 99 517 80 S579 91 620 68"/><circle className="chart-point" cx="517" cy="31" r="4"/><circle className="chart-point expense-point" cx="517" cy="80" r="4"/></svg><div className="x-labels"><span>เม.ย.</span><span>พ.ค.</span><span>มิ.ย.</span><span>ก.ค.</span><span>ส.ค.</span><span>ก.ย.</span></div></div>
              </div>

              <div className="panel budget-panel"><div className="panel-header"><div><div className="panel-title">งบประมาณตามหมวด</div><div className="panel-subtitle">ใช้ไป ฿20,800 จาก ฿32,500</div></div><button className="more-button" onClick={() => setPage('งบประมาณ')}>ดูทั้งหมด <ChevronRight size={14} /></button></div><div className="budget-list"><BudgetRow icon="🏠" name="บ้านและที่พัก" used={8500} limit={10000} color="teal"/><BudgetRow icon="🍜" name="อาหารและเครื่องดื่ม" used={6240} limit={8000} color="orange"/><BudgetRow icon="🚗" name="เดินทาง" used={2860} limit={5000} color="blue"/><BudgetRow icon="📚" name="การศึกษา" used={3200} limit={6000} color="purple"/></div><button className="budget-footer" onClick={() => setPage('งบประมาณ')}>จัดการงบประมาณ <ArrowUpRight size={14} /></button></div>
            </section>

            <section className="lower-grid">
              <div className="panel transactions-panel"><div className="panel-header transaction-heading"><div><div className="panel-title">รายการล่าสุด</div><div className="panel-subtitle">กิจกรรมการเงินของคุณและครอบครัว</div></div><button className="more-button" onClick={() => setPage('รายการทั้งหมด')}>ดูรายการทั้งหมด <ChevronRight size={14} /></button></div><TransactionTable rows={filtered.slice(0, 5)} /></div>
              <div className="panel accounts-panel"><div className="panel-header"><div><div className="panel-title">บัญชีเงิน</div><div className="panel-subtitle">ยอดคงเหลือรวม ฿48,260</div></div><button className="icon-button tiny" onClick={() => setPage('บัญชีเงิน')} aria-label="ดูบัญชีเงิน"><ArrowUpRight size={16}/></button></div><AccountRow icon={<Banknote size={17}/>} title="เงินสด" owner="ครอบครัว" amount="4,820" tone="mint"/><AccountRow icon={<Landmark size={17}/>} title="KBank •• 4821" owner="พิมพ์ชนก" amount="28,440" tone="violet"/><AccountRow icon={<CreditCard size={17}/>} title="SCB •• 1092" owner="ครอบครัว" amount="15,000" tone="blue"/><div className="account-note"><span className="note-check"><Check size={13}/></span> อัปเดตล่าสุดวันนี้ เวลา 10:42</div></div>
            </section>
          </>}

          {page !== 'ภาพรวม' && <PageContent page={page} rows={filtered} search={search} authUser={authUser} onSearch={setSearch} kindFilter={kindFilter} onKindFilter={setKindFilter} onAdd={() => openComposer(page === 'รายการทั้งหมด' ? 'expense' : 'income')} onToast={notify} />}
        </div>
      </main>

      <button className="mobile-add" onClick={() => openComposer('expense')}><Plus size={22}/></button>

      {modal && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(false) }}><div className="composer-modal" role="dialog" aria-modal="true" aria-labelledby="composer-title"><div className="modal-heading"><div><div className="modal-kicker">เพิ่มรายการใหม่</div><h2 id="composer-title">บันทึกการเงิน</h2></div><button className="icon-button" onClick={() => setModal(false)} aria-label="ปิด"><X size={19}/></button></div><div className="kind-tabs">{([{key:'expense',label:'รายจ่าย',icon:<ArrowUpRight size={15}/>},{key:'income',label:'รายรับ',icon:<ArrowDownRight size={15}/>},{key:'transfer',label:'โอนเงิน',icon:<ArrowLeftRight size={15}/>} ] as const).map((item) => <button key={item.key} className={formKind === item.key ? `${item.key} active` : ''} onClick={() => { setFormKind(item.key); setFormCategory(item.key === 'income' ? 'เงินเดือน' : 'อาหาร') }}>{item.icon}{item.label}</button>)}</div><form onSubmit={saveTransaction}>
        <div className="amount-field"><label htmlFor="amount">จำนวนเงิน</label><div><span>฿</span><input id="amount" inputMode="decimal" value={formAmount} onChange={(event) => setFormAmount(event.target.value)} placeholder="0.00" required /></div></div>
        <div className="form-row"><label>ขอบเขต</label><div className="scope-options"><button type="button" className={formScope === 'family' ? 'chosen' : ''} onClick={() => { setFormScope('family'); setFormOwner(authUser.displayName); setFormPayer(authUser.displayName) }}><Users size={15}/> ครอบครัว</button><button type="button" className={formScope === 'personal' ? 'chosen' : ''} onClick={() => { setFormScope('personal'); setFormOwner(authUser.displayName); setFormPayer(authUser.displayName) }}><Wallet size={15}/> ส่วนตัว</button></div></div>
        <div className={`form-grid ${formKind === 'transfer' ? 'single' : ''}`}><label className="input-label">{formKind === 'income' ? 'ที่มาของรายรับ' : formKind === 'transfer' ? 'รายละเอียดการโอน' : 'ชื่อรายการ'}<input value={formTitle} onChange={(event) => setFormTitle(event.target.value)} placeholder={formKind === 'income' ? 'เช่น เงินเดือน' : formKind === 'transfer' ? 'เช่น โอนให้แม่' : 'เช่น ซื้อของเข้าบ้าน'} /></label>{formKind !== 'transfer' && <label className="input-label">หมวดหมู่<select value={formCategory} onChange={(event) => setFormCategory(event.target.value)}>{categories[formKind].map((item) => <option key={item}>{item}</option>)}</select></label>}</div>
        {formKind === 'transfer' ? <div className="form-grid"><label className="input-label">บัญชีต้นทาง<select value={formAccount} onChange={(event) => setFormAccount(event.target.value)}><option>เงินสด</option><option>KBank •• 4821</option><option>SCB •• 1092</option></select></label><label className="input-label">บัญชีปลายทาง<select value={formDestination} onChange={(event) => setFormDestination(event.target.value)}><option>เงินสด</option><option>KBank •• 4821</option><option>SCB •• 1092</option></select></label></div> : <><div className="form-grid"><label className="input-label">บัญชีเงิน<select value={formAccount} onChange={(event) => setFormAccount(event.target.value)}><option>เงินสด</option><option>KBank •• 4821</option><option>SCB •• 1092</option></select></label>{formKind === 'expense' && <label className="input-label">ผู้จ่าย<select value={formPayer} onChange={(event) => setFormPayer(event.target.value)}><option>{authUser.displayName}</option>{formScope === 'family' && <option>ครอบครัว</option>}</select></label>}</div><div className="form-grid"><label className="input-label">เจ้าของรายการ<select value={formOwner} onChange={(event) => setFormOwner(event.target.value)}><option>{authUser.displayName}</option>{formScope === 'family' && <option>ครอบครัว</option>}</select></label></div></>}
        {formKind === 'expense' && <div className="receipt-box">{filePreview ? <div className="receipt-preview"><img src={filePreview} alt="ภาพสลิปที่เลือก"/><div><strong><Sparkles size={14}/> ข้อมูลที่อ่านได้ (ตัวอย่าง)</strong><span>ร้านกาแฟ · ฿185 · วันนี้</span><button type="button" onClick={() => fileInput.current?.click()}>เลือกภาพอื่น</button></div></div> : <button type="button" className="receipt-select" onClick={() => fileInput.current?.click()}><span className="receipt-icon"><FileImage size={19}/></span><span><strong>แนบสลิปหรือใบเสร็จ</strong><small>เลือกภาพจากคลังหรือถ่ายภาพ</small></span><Upload size={16}/></button>}<input ref={fileInput} type="file" accept="image/*" capture="environment" hidden onChange={handleImage}/></div>}
        <div className="modal-footer"><span><CircleHelp size={14}/> ผู้บันทึก: คุณ</span><button type="button" className="secondary-button" onClick={() => setModal(false)}>ยกเลิก</button><button type="submit" className="primary-button"><Check size={16}/> บันทึกรายการ</button></div>
      </form></div></div>}
      {toast && <div className="toast"><Check size={16}/>{toast}</div>}
    </div>
  )
}

function SummaryCard({ label, amount, detail, trend, tone, icon, spark }: { label: string; amount: number; detail: string; trend: string; tone: string; icon: ReactNode; spark: string }) {
  return <article className="summary-card"><div className="summary-top"><span>{label}</span><div className={`summary-icon ${tone}`}>{icon}</div></div><div className="summary-amount"><span className="currency">฿</span>{formatMoney(amount)}</div><div className="summary-bottom"><span className="summary-detail">{detail}</span><span className={`trend ${tone}`}><TrendingUp size={13}/>{trend}</span></div><svg className={`mini-spark ${tone}`} viewBox="0 0 76 32" preserveAspectRatio="none"><path d={spark}/></svg></article>
}

function AuthShell({ children }: { children: ReactNode }) {
  return <div className="auth-shell"><div className="auth-brand"><div className="brand-mark"><Wallet size={19} strokeWidth={2.4}/></div><div><strong>อุ่นใจ</strong><span>จัดการเงินให้ง่ายขึ้น</span></div></div>{children}</div>
}

function AuthScreen({ resetToken, initialMessage, onAuthenticated }: { resetToken: string; initialMessage: string; onAuthenticated: (user: AuthUser) => void }) {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot' | 'reset'>(resetToken ? 'reset' : 'login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState(initialMessage)
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage('')
    const path = mode === 'register' ? 'register' : mode === 'forgot' ? 'forgot-password' : mode === 'reset' ? 'reset-password' : 'login'
    const body = mode === 'register' ? { displayName: name, email, password }
      : mode === 'reset' ? { token: resetToken, password }
        : { email, ...(mode === 'login' ? { password } : {}) }
    try {
      const response = await fetch(`/api/auth/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
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
      {message && <div className="auth-message" role="status">{message}</div>}
      <button className="primary-button auth-submit" type="submit" disabled={busy}>{busy ? 'กำลังดำเนินการ…' : title}</button>
    </form>
    <div className="auth-links">{mode === 'login' && <><button onClick={() => { setMode('forgot'); setMessage('') }}>ลืมรหัสผ่าน?</button><button onClick={() => { setMode('register'); setMessage('') }}>สร้างบัญชีใหม่</button></>}{mode === 'register' && <button onClick={() => { setMode('login'); setMessage('') }}>มีบัญชีแล้ว? เข้าสู่ระบบ</button>}{mode === 'forgot' && <button onClick={() => { setMode('login'); setMessage('') }}>กลับไปเข้าสู่ระบบ</button>}{mode === 'reset' && <button onClick={() => { setMode('login'); setMessage('') }}>กลับไปเข้าสู่ระบบ</button>}</div>
  </section></AuthShell>
}

function BudgetRow({ icon, name, used, limit, color }: { icon: string; name: string; used: number; limit: number; color: string }) {
  const percent = Math.min(Math.round(used / limit * 100), 100)
  return <div className="budget-row"><div className="budget-row-top"><span className="budget-name"><span className="budget-emoji">{icon}</span>{name}</span><span className="budget-amount"><b>฿{formatMoney(used)}</b><span> / ฿{formatMoney(limit)}</span></span></div><div className="progress-track"><span className={`progress-fill ${color}`} style={{ width: `${percent}%` }}/></div><div className="budget-percent">ใช้ไป {percent}%</div></div>
}

function TransactionTable({ rows }: { rows: Transaction[] }) {
  return <div className="transaction-table"><div className="table-head"><span>รายการ</span><span>วันที่</span><span>บัญชีเงิน</span><span>เจ้าของรายการ</span><span className="align-right">จำนวนเงิน</span></div>{rows.length ? rows.map((item) => <div className="transaction-row" key={item.id}><div className="transaction-name"><span className={`transaction-icon ${item.kind}`}>{item.icon}</span><span><strong>{item.title}</strong><small>{item.category}</small></span></div><span className="transaction-date">{item.date}</span><span className="transaction-account">{item.account}</span><span className="owner-chip"><i className={item.owner === 'ครอบครัว' ? 'family-dot' : ''}/><span>{item.owner}<small>{item.kind === 'expense' ? `จ่ายโดย ${item.payer ?? item.recorder}` : `บันทึกโดย ${item.recorder}`}</small></span></span><strong className={`transaction-amount ${item.kind}`}>{item.kind === 'income' ? '+' : item.kind === 'transfer' ? '↗ ' : '−'}฿{formatMoney(item.amount)}</strong></div>) : <div className="empty-state"><Search size={20}/>ไม่พบรายการที่ตรงกับตัวกรอง</div>}</div>
}

function AccountRow({ icon, title, owner, amount, tone }: { icon: ReactNode; title: string; owner: string; amount: string; tone: string }) {
  return <div className="account-row"><div className={`account-icon ${tone}`}>{icon}</div><div className="account-copy"><strong>{title}</strong><span>{owner}</span></div><div className="account-amount"><strong>฿{amount}</strong><span>ยอดคงเหลือ</span></div></div>
}

function PageContent({ page, rows, search, authUser, onSearch, kindFilter, onKindFilter, onAdd, onToast }: { page: string; rows: Transaction[]; search: string; authUser: AuthUser; onSearch: (value: string) => void; kindFilter: string; onKindFilter: (value: string) => void; onAdd: () => void; onToast: (message: string) => void }) {
  if (page === 'รายการทั้งหมด') return <div className="panel full-page-panel"><div className="list-toolbar"><div className="search-field"><Search size={16}/><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="ค้นหารายการ"/></div><select className="filter-select" value={kindFilter} onChange={(event) => onKindFilter(event.target.value)} aria-label="กรองประเภทรายการ"><option>ทั้งหมด</option><option>รายรับ</option><option>รายจ่าย</option><option>โอน</option></select><button className="primary-button" onClick={onAdd}><Plus size={16}/> เพิ่มรายการ</button></div><TransactionTable rows={rows}/></div>
  if (page === 'งบประมาณ') return <div className="page-cards"><div className="panel page-budget-card"><div className="panel-header"><div><div className="panel-title">งบครอบครัว · กันยายน 2569</div><div className="panel-subtitle">ใช้ไป ฿20,800 จากงบทั้งหมด ฿32,500</div></div><button className="primary-button" onClick={() => onToast('เปิดแบบฟอร์มตั้งงบประมาณตัวอย่าง')}><Plus size={16}/> เพิ่มงบ</button></div>{[['🏠','บ้านและที่พัก',8500,10000,'teal'],['🍜','อาหารและเครื่องดื่ม',6240,8000,'orange'],['🚗','เดินทาง',2860,5000,'blue'],['📚','การศึกษา',3200,6000,'purple']].map(([icon,name,used,limit,color])=><BudgetRow key={String(name)} icon={String(icon)} name={String(name)} used={Number(used)} limit={Number(limit)} color={String(color)}/>)}</div><div className="panel page-note"><Sparkles size={20}/><strong>งบที่ใช้ไป 64%</strong><p>ต้นแบบนี้แสดงข้อมูลงบตัวอย่าง เมื่อเชื่อมระบบจริงแล้วจะคำนวณจากรายการที่ยืนยัน</p></div></div>
  if (page === 'บัญชีเงิน') return <div className="panel full-page-panel"><div className="panel-header"><div><div className="panel-title">บัญชีเงินของครอบครัว</div><div className="panel-subtitle">ยอดรวมตัวอย่าง ฿48,260 · มียอดตั้งต้นและรายการล่าสุด</div></div><button className="primary-button" onClick={() => onToast('เพิ่มบัญชีเงินได้ในระยะเชื่อมฐานข้อมูล')}><Plus size={16}/> เพิ่มบัญชี</button></div><div className="account-page-grid"><AccountRow icon={<Banknote size={18}/>} title="เงินสดครอบครัว" owner="ครอบครัว · เงินสด" amount="4,820" tone="mint"/><AccountRow icon={<Landmark size={18}/>} title="KBank •• 4821" owner="พิมพ์ชนก · ธนาคาร" amount="28,440" tone="violet"/><AccountRow icon={<CreditCard size={18}/>} title="SCB •• 1092" owner="ครอบครัว · ธนาคาร" amount="15,000" tone="blue"/></div></div>
  if (page === 'ครอบครัว') return <div className="page-cards"><div className="panel family-panel"><div className="panel-header"><div><div className="panel-title">สมาชิกในบ้าน</div><div className="panel-subtitle">{authUser.families[0]?.name || 'พื้นที่ครอบครัว'}</div></div><button className="primary-button" disabled onClick={() => onToast('ระบบเชิญสมาชิกยังอยู่ระหว่างพัฒนา')}><Plus size={16}/> เชิญสมาชิก</button></div>{authUser.families.map((family) => <div className="member-row" key={family.id}><div className="avatar member-avatar">{authUser.displayName.slice(0, 1)}</div><div className="member-copy"><strong>{authUser.displayName}</strong><span>{authUser.email}</span></div><span className="member-badge">{family.role === 'owner' ? 'เจ้าของ' : 'สมาชิก'}</span></div>)}{!authUser.families.length && <div className="empty-state">ยังไม่มีครอบครัวที่เข้าร่วม</div>}</div><div className="panel page-note"><Users size={20}/><strong>พื้นที่บัญชีของคุณ</strong><p>ขณะนี้แสดงเฉพาะสมาชิกที่ยืนยันตัวตนแล้ว การเชิญและจัดการสมาชิกยังไม่เปิดใช้งาน</p></div></div>
  return <div className="panel empty-section"><Tag size={24}/><h3>{page}</h3><p>ส่วนนี้จะแสดงรายการและตัวกรองตามขอบเขตข้อมูลของคุณ</p><button className="primary-button" onClick={onAdd}><Plus size={16}/> เพิ่มรายการ</button></div>
}

export default App
