import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Workbook } from '@fortune-sheet/react'
import '@fortune-sheet/react/dist/index.css'
import toast from 'react-hot-toast'
import {
  Plus, Trash2, Download, Upload, FileSpreadsheet, Save,
  Lock, Unlock, X, LayoutGrid, Globe, ExternalLink, RefreshCw, Link2,
  Server, Mail as MailIcon, FileText, ChevronRight, ChevronDown, ArrowLeft, ArrowRight,
  Check, AlertTriangle, RotateCw, XCircle, CheckCircle2, Sparkles, KeyRound, Wallet,
} from 'lucide-react'
import { saveAs } from 'file-saver'
import * as XLSX from 'xlsx'

import api, {
  getSheets, createSheet, getSheet, updateSheet, deleteSheet, renameSheet,
  createServerTechAccessSheet, getTechAccessInfo,
} from '../api/client'
import { Btn, Spinner, Modal, Field, Badge } from '../components/ui/index'
import { useDeleteOtp } from '../context/DeleteOtpContext'
import { isEncrypted, encryptData, decryptData } from '../services/cryptoSheet'

const BLANK_SHEET = [{ name: 'Аркуш 1', celldata: [], row: 84, column: 60 }]
const OPEN_TABS_KEY = 'dm.sheets.openTabs.v1'

// ── Tab manager ─────────────────────────────────────────────────────────

export default function SheetsPage() {
  // Tabs are persisted in localStorage so they survive reload.
  // Tab = { id, password? }. Active tab id can be 'list' or sheet id.
  const [tabs, setTabs] = useState(() => {
    try {
      const raw = localStorage.getItem(OPEN_TABS_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) return parsed
      }
    } catch {}
    return []
  })
  const [active, setActive] = useState('list')

  // Persist (drop passwords on save — never write them to localStorage)
  useEffect(() => {
    const safe = tabs.map(t => ({ id: t.id }))
    try { localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(safe)) } catch {}
  }, [tabs])

  // Load sheet meta for tab labels
  const { data: sheets = [] } = useQuery({
    queryKey: ['sheets'],
    queryFn: () => getSheets().then(r => r.data),
  })

  const openTab = useCallback((id, password) => {
    setTabs(prev => {
      if (prev.find(t => t.id === id)) {
        // Update password if newly provided
        return prev.map(t => t.id === id ? { ...t, password: password ?? t.password } : t)
      }
      return [...prev, { id, password }]
    })
    setActive(id)
  }, [])

  const closeTab = useCallback((id) => {
    setTabs(prev => {
      const idx = prev.findIndex(t => t.id === id)
      const next = prev.filter(t => t.id !== id)
      if (active === id) {
        const fallback = next[Math.max(0, idx - 1)]?.id || 'list'
        setActive(fallback)
      }
      return next
    })
  }, [active])

  // Prune tabs whose sheets have been deleted
  useEffect(() => {
    if (!sheets.length && !tabs.length) return
    setTabs(prev => prev.filter(t => sheets.find(s => s.id === t.id)))
  }, [sheets])

  const tabMetas = tabs.map(t => ({ ...t, meta: sheets.find(s => s.id === t.id) })).filter(t => t.meta)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Tab bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4,
        padding: '8px 12px 0', background: 'var(--bg2)', borderBottom: '1px solid var(--border)',
        overflowX: 'auto', flexShrink: 0,
      }}>
        <TabPill
          icon={<LayoutGrid size={13} />} label="Всі таблиці"
          active={active === 'list'} onClick={() => setActive('list')}
        />
        {tabMetas.map(t => (
          <TabPill key={t.id}
            icon={t.meta.kind === 'google' ? <Globe size={13} /> : t.meta.is_encrypted ? <Lock size={13} /> : <FileSpreadsheet size={13} />}
            label={t.meta.name}
            active={active === t.id}
            onClick={() => setActive(t.id)}
            onClose={() => closeTab(t.id)}
            color={t.meta.kind === 'google' ? 'var(--green)' : t.meta.is_encrypted ? 'var(--accent)' : undefined}
          />
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex' }}>
        <div style={{ display: active === 'list' ? 'flex' : 'none', flex: 1, minWidth: 0 }}>
          <SheetList onOpen={openTab} sheets={sheets} />
        </div>
        {tabMetas.map(t => (
          <div key={t.id} style={{ display: active === t.id ? 'flex' : 'none', flex: 1, minWidth: 0, flexDirection: 'column' }}>
            {t.meta.kind === 'google'
              ? <GoogleSheetView meta={t.meta} onClose={() => closeTab(t.id)} />
              : <LocalSheetEditor id={t.id} password={t.password} onClose={() => closeTab(t.id)} />}
          </div>
        ))}
      </div>
    </div>
  )
}

function TabPill({ icon, label, active, onClick, onClose, color }) {
  return (
    <div onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '8px 12px', borderRadius: '10px 10px 0 0',
        background: active ? 'var(--bg)' : 'transparent',
        borderTop: '1px solid',
        borderTopColor: active ? (color || 'var(--accent)') : 'transparent',
        borderLeft: '1px solid', borderRight: '1px solid',
        borderLeftColor: active ? 'var(--border)' : 'transparent',
        borderRightColor: active ? 'var(--border)' : 'transparent',
        cursor: 'pointer', flexShrink: 0, maxWidth: 220,
        fontSize: 12, fontWeight: 600,
        color: active ? 'var(--text)' : 'var(--text2)',
        marginBottom: -1,
        transition: 'background 0.12s',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--bg3)' }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
    >
      {icon}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>{label}</span>
      {onClose && (
        <button onClick={e => { e.stopPropagation(); onClose() }}
          style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 0, display: 'inline-flex', borderRadius: 4 }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--red)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
        ><X size={13} /></button>
      )}
    </div>
  )
}

// ── List view ───────────────────────────────────────────────────────────

function SheetList({ onOpen, sheets }) {
  const qc = useQueryClient()
  const { gateDelete } = useDeleteOtp()
  const [newModal, setNewModal] = useState(false)
  const [gsheetModal, setGsheetModal] = useState(false)
  const [importModal, setImportModal] = useState(false)
  const [unlockSheet, setUnlockSheet] = useState(null)
  const [bindSheet, setBindSheet] = useState(null)
  const fileRef = useRef(null)

  const createMut = useMutation({
    mutationFn: async ({ name, password }) => {
      const plain = JSON.stringify(BLANK_SHEET)
      const data = password ? await encryptData(plain, password) : plain
      const r = await createSheet({ name, data, kind: 'local' })
      return { sheet: r.data, password }
    },
    onSuccess: ({ sheet, password }) => {
      qc.invalidateQueries(['sheets'])
      onOpen(sheet.id, password)
    },
  })

  const createGsheetMut = useMutation({
    mutationFn: async ({ name, url }) => {
      const r = await createSheet({ name, kind: 'google', external_url: url, data: '[]' })
      return r.data
    },
    onSuccess: (sheet) => {
      qc.invalidateQueries(['sheets'])
      onOpen(sheet.id)
      toast.success('Google Sheet додано')
    },
  })

  const delMut = useMutation({
    mutationFn: deleteSheet,
    onSuccess: () => { toast.success('Таблицю видалено'); qc.invalidateQueries(['sheets']) },
  })

  const [techModal, setTechModal] = useState(false)
  // Auto-create / reuse server-tech-access sheet (local or Google).
  const techMut = useMutation({
    mutationFn: (params) => createServerTechAccessSheet(params).then(r => r.data),
    onSuccess: (r) => {
      if (r.reused) toast('Таблиця тех-доступів уже існує — відкриваю', { icon: 'ℹ️' })
      else toast.success(`Таблицю тех-доступів створено (${r.kind})`)
      qc.invalidateQueries(['sheets'])
      setTechModal(false)
      if (r.sheet_id) onOpen?.(r.sheet_id)
    },
    onError: (e) => toast.error('Помилка: ' + (e.response?.data?.detail || e.message)),
  })

  async function importXlsx(file) {
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const tabs = wb.SheetNames.map((name, idx) => {
        const ws = wb.Sheets[name]
        const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
        const celldata = []
        aoa.forEach((row, r) => {
          row.forEach((v, c) => {
            if (v !== null && v !== '') celldata.push({ r, c, v: { v, m: String(v) } })
          })
        })
        return { name, celldata, row: Math.max(aoa.length + 10, 84), column: Math.max((aoa[0]?.length || 0) + 10, 60), order: idx }
      })
      const r = await createSheet({ name: file.name.replace(/\.[^.]+$/, ''), data: JSON.stringify(tabs), kind: 'local' })
      qc.invalidateQueries(['sheets'])
      onOpen(r.data.id)
      toast.success('Імпортовано')
    } catch (e) {
      toast.error('Помилка імпорту: ' + (e.message || e))
    }
  }

  function handleCardOpen(sheet) {
    if (sheet.kind === 'google') return onOpen(sheet.id)
    if (sheet.is_encrypted) setUnlockSheet(sheet)
    else onOpen(sheet.id, null)
  }

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, flex: 1, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontWeight: 800, fontSize: 22 }}>Таблиці</h1>
          <p style={{ color: 'var(--text3)', fontSize: 12, marginTop: 2 }}>
            {sheets.length} {sheets.length === 1 ? 'таблиця' : 'таблиць'} · локальні + Google
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={e => e.target.files?.[0] && importXlsx(e.target.files[0])} />
          <Btn variant="ghost" onClick={() => fileRef.current?.click()}>
            <Upload size={14} /> Імпорт XLSX
          </Btn>
          <Btn variant="ghost" onClick={() => setGsheetModal(true)}>
            <Globe size={14} /> Google Sheet
          </Btn>
          <Btn variant="ghost" onClick={() => setImportModal(true)}>
            <Download size={14} /> Імпорт у Domain Manager
          </Btn>
          <Btn variant="ghost"
            title="Створити таблицю з полями: команда, провайдер, email, пароль, IP, пароль SSH, дата закупки. Автоматично заповниться даними з усіх серверів і буде оновлюватись при змінах."
            onClick={() => setTechModal(true)}>
            <KeyRound size={14} /> Тех-доступи
          </Btn>
          <Btn onClick={() => setNewModal(true)}>
            <Plus size={14} /> Нова таблиця
          </Btn>
        </div>
      </div>

      <div style={{
        background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14,
        flex: 1, overflowY: 'auto', padding: 8,
      }}>
        {sheets.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 48, color: 'var(--text3)', fontSize: 13 }}>
            Немає таблиць. Створіть першу, імпортуйте XLSX, або додайте Google Sheet.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, padding: 8 }}>
            {sheets.map(s => (
              <SheetCard key={s.id} sheet={s}
                onOpen={() => handleCardOpen(s)}
                onBind={() => setBindSheet(s)}
                onDelete={() => gateDelete(() => delMut.mutateAsync(s.id)).catch(() => {})}
                onRename={() => {
                  const name = prompt('Нова назва:', s.name)
                  if (name && name.trim() && name !== s.name) {
                    renameSheet(s.id, name.trim())
                      .then(() => qc.invalidateQueries(['sheets']))
                      .catch(() => toast.error('Помилка перейменування'))
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>

      <NewSheetModal open={newModal} onClose={() => setNewModal(false)}
        onCreate={(name, password) => { createMut.mutate({ name, password }); setNewModal(false) }}
        loading={createMut.isPending} />
      <GoogleSheetModal open={gsheetModal} onClose={() => setGsheetModal(false)}
        onCreate={(name, url) => { createGsheetMut.mutate({ name, url }); setGsheetModal(false) }}
        loading={createGsheetMut.isPending} />
      <UnlockSheetModal sheet={unlockSheet} onClose={() => setUnlockSheet(null)}
        onUnlocked={(id, password) => { setUnlockSheet(null); onOpen(id, password) }} />
      <BindingModal sheet={bindSheet} onClose={() => setBindSheet(null)} />
      <GoogleImportModal open={importModal} onClose={() => setImportModal(false)} />
      <TechAccessModal open={techModal} onClose={() => setTechModal(false)}
        onCreate={(params) => techMut.mutate(params)}
        loading={techMut.isPending} />
    </div>
  )
}


// ─── Tech-access preset modal (local OR Google) ─────────────────────────

function TechAccessModal({ open, onClose, onCreate, loading }) {
  const [kind, setKind] = useState('local')
  const [url, setUrl] = useState('')
  const { data: info } = useQuery({
    queryKey: ['techaccess-info'],
    queryFn: () => getTechAccessInfo().then(r => r.data),
    enabled: open,
    staleTime: 60_000,
  })
  const googleReady = info?.google_configured
  const saEmail = info?.service_account_email

  if (!open) return null
  return (
    <Modal open={open} onClose={onClose} title="Створити таблицю тех-доступів">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text2)' }}>
          Колонки: <b>Команда · Провайдер · Email · Пароль провайдера · IP ·
          Пароль сервера · Дата закупки</b>. Заповниться з усіх існуючих серверів
          і буде <b>оновлюватись автоматично</b> при будь-яких змінах.
        </p>

        {/* Kind switch */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setKind('local')}
            style={{
              flex: 1, padding: 14, borderRadius: 10, cursor: 'pointer', textAlign: 'left',
              background: kind === 'local' ? 'var(--accent-dim)' : 'var(--bg2)',
              border: `1px solid ${kind === 'local' ? 'var(--accent)' : 'var(--border)'}`,
              color: 'var(--text)',
            }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>
              <FileSpreadsheet size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
              Локально (в Domain Manager)
            </div>
            <div style={{ fontSize: 11, color: 'var(--text3)' }}>
              Дані в нашій БД. Шифрування Fernet. Live-sync.
            </div>
          </button>
          <button onClick={() => setKind('google')} disabled={!googleReady}
            style={{
              flex: 1, padding: 14, borderRadius: 10, textAlign: 'left',
              cursor: googleReady ? 'pointer' : 'not-allowed',
              opacity: googleReady ? 1 : 0.45,
              background: kind === 'google' ? 'var(--accent-dim)' : 'var(--bg2)',
              border: `1px solid ${kind === 'google' ? 'var(--accent)' : 'var(--border)'}`,
              color: 'var(--text)',
            }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>
              <Globe size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
              Google Sheets
            </div>
            <div style={{ fontSize: 11, color: 'var(--text3)' }}>
              {googleReady
                ? 'Дані у вашій Google таблиці. Live-sync через Sheets API.'
                : 'Service Account не налаштовано (env GOOGLE_SERVICE_ACCOUNT_JSON).'}
            </div>
          </button>
        </div>

        {kind === 'google' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {saEmail && (
              <div style={{
                background: 'var(--bg2)', border: '1px solid var(--border)',
                borderRadius: 8, padding: 12, fontSize: 12,
              }}>
                <div style={{ marginBottom: 6 }}>
                  1. Створи нову Google таблицю.<br />
                  2. Натисни <b>Share</b> → додай як <b>Editor</b>:
                </div>
                <code style={{
                  fontFamily: 'var(--mono)', fontSize: 12, background: 'var(--bg3)',
                  padding: '4px 8px', borderRadius: 4, color: 'var(--accent)',
                  userSelect: 'all', display: 'inline-block',
                }}>{saEmail}</code>
                <div style={{ marginTop: 6 }}>
                  3. Скопіюй URL таблиці і встав нижче.
                </div>
              </div>
            )}
            <input value={url} onChange={e => setUrl(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/…"
              style={{ fontFamily: 'var(--mono)', fontSize: 12 }} />
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <Btn variant="ghost" onClick={onClose}>Скасувати</Btn>
          <Btn loading={loading}
            disabled={kind === 'google' && !url.trim()}
            onClick={() => onCreate(kind === 'google'
              ? { kind: 'google', external_url: url.trim() }
              : { kind: 'local' })}>
            Створити
          </Btn>
        </div>
      </div>
    </Modal>
  )
}


// ─── Google Sheets import wizard ────────────────────────────────────────

function GoogleImportModal({ open, onClose }) {
  const [step, setStep] = useState(1)
  const [source, setSource] = useState('google') // google | local | file
  const [url, setUrl] = useState('')
  const [info, setInfo] = useState(null)        // { sheet_id, title, tabs }
  const [tab, setTab] = useState(null)          // selected tab object (gid for google, index for local/file)
  const [preview, setPreview] = useState(null)  // { headers, rows, total_rows, guess, sheets? }
  const [target, setTarget] = useState('servers')
  const [cmap, setCmap] = useState({})          // entity_field → header
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  // Local & file sources
  const [localSheetId, setLocalSheetId] = useState(null)
  const [uploadFile, setUploadFile] = useState(null)
  // Multi-tab queue: tabs the user selected on step 2; processed one-by-one on step 3
  const [queue, setQueue] = useState([])         // [tabObj, ...] — remaining tabs to import
  const [aggregated, setAggregated] = useState([]) // [{tab_name, target, result}]
  const { data: localSheets = [] } = useQuery({
    queryKey: ['sheets'], queryFn: () => api.get('/sheets').then(r => r.data),
    enabled: open,
  })

  useEffect(() => {
    if (!open) {
      setStep(1); setSource('google'); setUrl(''); setInfo(null); setTab(null);
      setPreview(null); setCmap({}); setResult(null); setTarget('servers');
      setLocalSheetId(null); setUploadFile(null);
      setQueue([]); setAggregated([]);
    }
  }, [open])

  function guessTargetByName(name) {
    const lc = (name || '').toLowerCase()
    if (/vps|server|сервер/.test(lc)) return 'servers'
    if (/mail|пошт|почт/.test(lc))    return 'mail'
    return 'notes'
  }

  async function nextFromStep1() {
    setBusy(true)
    try {
      if (source === 'google') {
        if (!url.trim()) { setBusy(false); return }
        const r = await api.post('/sheet-import/discover', { url: url.trim() })
        setInfo(r.data); setStep(2)
      } else if (source === 'local') {
        if (!localSheetId) { setBusy(false); return }
        // Fetch preview for sheet_index=0; the preview returns "sheets" list for tab picking
        const r = await api.post('/sheet-import/local/preview', { sheet_id: localSheetId, sheet_index: 0 })
        const sheets = r.data.sheets || [{ index: 0, name: r.data.sheet_name }]
        if (sheets.length > 1) {
          setInfo({ title: r.data.sheet_name, tabs: sheets.map(s => ({ ...s, gid: String(s.index) })) })
          setStep(2)
        } else {
          setTab({ name: r.data.sheet_name, index: 0 })
          setPreview(r.data)
          const g = guessTargetByName(r.data.sheet_name)
          setTarget(g); setCmap(r.data.guess?.[g] || {})
          setStep(3)
        }
      } else if (source === 'file') {
        if (!uploadFile) { setBusy(false); return }
        const fd = new FormData(); fd.append('file', uploadFile); fd.append('sheet_index', '0')
        const r = await api.post('/sheet-import/file/preview', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
        const sheets = r.data.sheets || [{ index: 0, name: uploadFile.name }]
        if (sheets.length > 1) {
          setInfo({ title: uploadFile.name, tabs: sheets.map(s => ({ ...s, gid: String(s.index) })) })
          setStep(2)
        } else {
          setTab({ name: uploadFile.name, index: 0 })
          setPreview(r.data)
          const g = guessTargetByName(uploadFile.name)
          setTarget(g); setCmap(r.data.guess?.[g] || {})
          setStep(3)
        }
      }
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Помилка')
    } finally { setBusy(false) }
  }

  async function pickTab(t) {
    setTab(t); setBusy(true)
    try {
      let r
      if (source === 'google') {
        r = await api.post('/sheet-import/preview', { url, gid: t.gid, limit: 20 })
      } else if (source === 'local') {
        r = await api.post('/sheet-import/local/preview', { sheet_id: localSheetId, sheet_index: t.index ?? Number(t.gid) })
      } else {
        const fd = new FormData()
        fd.append('file', uploadFile)
        fd.append('sheet_index', String(t.index ?? Number(t.gid) ?? 0))
        r = await api.post('/sheet-import/file/preview', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      }
      setPreview(r.data)
      // Use backend's deep-analysis suggestion (value-based row classification)
      const g = r.data.suggested_target || guessTargetByName(t.name)
      setTarget(g)
      setCmap(g === 'auto' ? {} : (r.data.guess?.[g] || {}))
      setStep(3)
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Помилка попереднього перегляду')
    } finally { setBusy(false) }
  }

  function changeTarget(t) {
    setTarget(t)
    setCmap(t === 'auto' ? {} : (preview?.guess?.[t] || {}))
  }

  async function doRun() {
    setBusy(true)
    try {
      let r
      if (source === 'google') {
        r = await api.post('/sheet-import/run', {
          url, gid: tab.gid, target, column_map: cmap, tab_name: tab.name,
        })
      } else if (source === 'local') {
        r = await api.post('/sheet-import/local/run', {
          sheet_id: localSheetId,
          sheet_index: tab.index ?? Number(tab.gid) ?? 0,
          target, column_map: cmap, tab_name: tab.name,
        })
      } else {
        const fd = new FormData()
        fd.append('file', uploadFile)
        fd.append('target', target)
        fd.append('column_map', JSON.stringify(cmap))
        fd.append('sheet_index', String(tab.index ?? Number(tab.gid) ?? 0))
        if (tab.name) fd.append('tab_name', tab.name)
        r = await api.post('/sheet-import/file/run', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      }
      const entry = { tab_name: tab.name, target, result: r.data }
      const newAgg = [...aggregated, entry]
      setAggregated(newAgg)
      toast.success(`${tab.name}: ${r.data.created} створено, ${r.data.updated || 0} оновлено`)
      // If multi-tab queue has remaining tabs — advance to next
      const remaining = queue.filter(t => t.gid !== tab.gid)
      setQueue(remaining)
      if (remaining.length > 0) {
        await pickTab(remaining[0])  // loads preview, advances to step 3 with next tab
      } else {
        setResult({ aggregated: newAgg })
        setStep(4)
      }
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Помилка імпорту')
    } finally { setBusy(false) }
  }

  if (!open) return null
  return (
    <Modal open={open} onClose={onClose} title="Імпорт у Domain Manager" width={760}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: 360 }}>
        {/* Step indicator */}
        <div style={{ display: 'flex', gap: 6, fontSize: 11, color: 'var(--text3)' }}>
          {['Джерело', 'Лист', 'Колонки', 'Готово'].map((label, i) => (
            <span key={i} style={{
              padding: '3px 10px', borderRadius: 99,
              background: step === i + 1 ? 'var(--accent-dim)' : 'var(--bg2)',
              color: step === i + 1 ? 'var(--accent)' : 'var(--text3)',
              border: '1px solid ' + (step === i + 1 ? 'var(--accent)' : 'var(--border)'),
            }}>{i + 1}. {label}</span>
          ))}
        </div>

        {/* Step 1: source picker */}
        {step === 1 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              {[
                { v: 'google', label: 'Google Sheets', icon: <Globe size={12} /> },
                { v: 'local',  label: 'Локальна таблиця', icon: <FileSpreadsheet size={12} /> },
                { v: 'file',   label: 'Файл XLSX/CSV', icon: <Upload size={12} /> },
              ].map(o => (
                <button key={o.v} onClick={() => setSource(o.v)}
                  style={{
                    flex: 1, padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                    background: source === o.v ? 'var(--accent-dim)' : 'var(--bg2)',
                    color: source === o.v ? 'var(--accent)' : 'var(--text2)',
                    border: '1px solid ' + (source === o.v ? 'var(--accent)' : 'var(--border)'),
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 12,
                  }}>{o.icon} {o.label}</button>
              ))}
            </div>

            {source === 'google' && (
              <>
                {localSheets.filter(s => s.kind === 'google' && s.external_url).length > 0 && (
                  <Field label="Уже додані Google-таблиці">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 140, overflowY: 'auto' }}>
                      {localSheets.filter(s => s.kind === 'google' && s.external_url).map(s => (
                        <button key={s.id} onClick={() => setUrl(s.external_url)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '6px 10px', borderRadius: 6, cursor: 'pointer', textAlign: 'left',
                            background: url === s.external_url ? 'var(--accent-dim)' : 'var(--bg2)',
                            color: url === s.external_url ? 'var(--accent)' : 'var(--text2)',
                            border: '1px solid ' + (url === s.external_url ? 'var(--accent)' : 'var(--border)'),
                            fontSize: 12,
                          }}>
                          <Globe size={11} />
                          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                          <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>
                            {s.external_url.replace(/^https?:\/\//, '')}
                          </span>
                        </button>
                      ))}
                    </div>
                  </Field>
                )}
                <Field label="Або вставте нове посилання (доступ: Anyone with link → Viewer)">
                  <input value={url} onChange={e => setUrl(e.target.value)}
                    placeholder="https://docs.google.com/spreadsheets/d/.../edit" autoFocus />
                </Field>
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                  Таблиця має бути розшарена «для всіх, хто має посилання».
                </div>
              </>
            )}

            {source === 'local' && (
              <>
                <Field label="Виберіть локальну таблицю">
                  <select value={localSheetId || ''} onChange={e => setLocalSheetId(Number(e.target.value) || null)}
                    style={{
                      background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
                      padding: '8px 10px', color: 'var(--text)', fontSize: 13, width: '100%',
                    }}>
                    <option value="">— оберіть —</option>
                    {localSheets.filter(s => s.kind !== 'google' && !s.is_encrypted).map(s => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </Field>
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                  Зашифровані сейфи в списку не доступні — їх дані шифруються в браузері. Розшифруйте таблицю, перезбережіть без пароля і повторіть.
                </div>
              </>
            )}

            {source === 'file' && (
              <>
                <Field label="Файл .xlsx або .csv">
                  <input type="file" accept=".xlsx,.csv"
                    onChange={e => setUploadFile(e.target.files?.[0] || null)} />
                </Field>
                {uploadFile && (
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                    {uploadFile.name} · {(uploadFile.size / 1024).toFixed(1)} KB
                  </div>
                )}
              </>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Btn variant="ghost" onClick={onClose}>Скасувати</Btn>
              <Btn onClick={nextFromStep1} disabled={busy
                || (source === 'google' && !url.trim())
                || (source === 'local' && !localSheetId)
                || (source === 'file' && !uploadFile)}>
                {busy ? <Spinner size={12} /> : <ChevronRight size={13} />} Далі
              </Btn>
            </div>
          </div>
        )}

        {/* Step 2: pick tab(s) — checkbox multi-select */}
        {step === 2 && info && (() => {
          const allSelected = queue.length === info.tabs.length && info.tabs.length > 0
          const toggleAll = () => setQueue(allSelected ? [] : [...info.tabs])
          const toggleOne = (t) => {
            setQueue(q => q.find(x => x.gid === t.gid)
              ? q.filter(x => x.gid !== t.gid)
              : [...q, t])
          }
          async function proceed() {
            if (!queue.length) { toast.error('Виберіть хоча б один аркуш'); return }
            await pickTab(queue[0])  // load first tab's preview and go to step 3
          }
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{info.title || 'Таблиця'}</div>
                <button onClick={toggleAll}
                  style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11 }}>
                  {allSelected ? 'Зняти все' : 'Обрати все'}
                </button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                Обрано: <b>{queue.length}</b> з {info.tabs.length} · кожен аркуш отримає свій маппінг на наступному кроці
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
                {info.tabs.map(t => {
                  const checked = !!queue.find(x => x.gid === t.gid)
                  return (
                    <label key={t.gid} style={{
                      padding: '10px 12px', textAlign: 'left', display: 'flex', alignItems: 'flex-start', gap: 8,
                      background: checked ? 'var(--accent-dim)' : 'var(--bg2)',
                      border: '1px solid ' + (checked ? 'var(--accent)' : 'var(--border)'),
                      borderRadius: 8, color: 'var(--text)', cursor: 'pointer', fontSize: 12,
                    }}>
                      <input type="checkbox" checked={checked} onChange={() => toggleOne(t)}
                        style={{ width: 'auto', marginTop: 2 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
                        <div style={{ fontSize: 10, color: 'var(--text3)' }}>gid: {t.gid}</div>
                      </div>
                    </label>
                  )
                })}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <Btn variant="ghost" onClick={() => setStep(1)}><ArrowLeft size={13} /> Назад</Btn>
                <Btn onClick={proceed} disabled={busy || queue.length === 0}>
                  {busy ? <Spinner size={12} /> : <ChevronRight size={13} />} Налаштувати {queue.length || ''}
                </Btn>
              </div>
            </div>
          )
        })()}

        {/* Step 3: deep-analysis mapping */}
        {step === 3 && preview && tab && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{tab.name}</div>
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>{preview.total_rows} рядків · {preview.headers?.length || 0} колонок</div>
              {preview.headerless && (
                <span style={{
                  padding: '1px 6px', borderRadius: 99, fontSize: 10,
                  background: 'rgba(251,191,36,0.12)', color: '#fbbf24',
                  border: '1px solid rgba(251,191,36,0.3)',
                }}>заголовків не виявлено — синтезовано col1, col2, …</span>
              )}
              {queue.length > 1 && (
                <div style={{ fontSize: 11, color: 'var(--accent)', marginLeft: 'auto' }}>
                  Аркуш {aggregated.length + 1} з {aggregated.length + queue.length}
                </div>
              )}
            </div>

            {/* Suggestion banner */}
            {preview.suggested_target && (
              <div style={{
                padding: '8px 12px', background: 'rgba(125,163,255,0.06)',
                border: '1px solid rgba(125,163,255,0.25)', borderRadius: 6,
                fontSize: 11, color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <Sparkles size={12} color="var(--accent)" />
                <span>Аналіз пропонує: <b style={{ color: 'var(--accent)' }}>{
                  preview.suggested_target === 'auto' ? 'Авто-розділення'
                  : preview.suggested_target === 'servers' ? 'Сервери'
                  : preview.suggested_target === 'mail' ? 'Пошта'
                  : 'Нотатка'
                }</b></span>
                {preview.route_counts && (
                  <span style={{ marginLeft: 6, display: 'inline-flex', gap: 10 }}>
                    {preview.route_counts.servers > 0 && (
                      <span style={{ color: '#7da3ff', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        <Server size={10} /> {preview.route_counts.servers}
                      </span>
                    )}
                    {preview.route_counts.mail > 0 && (
                      <span style={{ color: '#4ade80', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        <MailIcon size={10} /> {preview.route_counts.mail}
                      </span>
                    )}
                    {preview.route_counts.skip > 0 && (
                      <span style={{ opacity: 0.6 }}>skip {preview.route_counts.skip}</span>
                    )}
                  </span>
                )}
              </div>
            )}

            <Field label="Куди імпортувати">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {[
                  { v: 'auto',    label: 'Авто-розділення', icon: <Sparkles size={12} />, ok: preview.can_auto },
                  { v: 'servers', label: 'Сервери',         icon: <Server size={12} />,   ok: preview.can_servers },
                  { v: 'mail',    label: 'Пошта',           icon: <MailIcon size={12} />, ok: preview.can_mail },
                  { v: 'notes',   label: 'Нотатка',         icon: <FileText size={12} />, ok: true },
                ].map(o => {
                  const tipMap = {
                    auto: 'Не виявлено рядків з email чи host',
                    servers: 'Не знайдено колонку host/ip',
                    mail: 'Не знайдено колонку email',
                  }
                  return (
                    <button key={o.v} onClick={() => changeTarget(o.v)} disabled={!o.ok}
                      title={!o.ok ? tipMap[o.v] : ''}
                      style={{
                        padding: '6px 12px', borderRadius: 6,
                        background: target === o.v ? 'var(--accent-dim)' : 'var(--bg2)',
                        color: target === o.v ? 'var(--accent)' : o.ok ? 'var(--text2)' : 'var(--text3)',
                        border: '1px solid ' + (target === o.v ? 'var(--accent)' : 'var(--border)'),
                        cursor: o.ok ? 'pointer' : 'not-allowed',
                        fontSize: 12, display: 'flex', alignItems: 'center', gap: 6,
                        opacity: o.ok ? 1 : 0.5,
                      }}>{o.icon} {o.label}</button>
                  )
                })}
              </div>
            </Field>

            {/* Auto-mode summary */}
            {target === 'auto' && preview.route_counts && (
              <div style={{
                padding: 10, background: 'var(--bg2)', border: '1px solid var(--border)',
                borderRadius: 6, fontSize: 11, color: 'var(--text2)',
              }}>
                <div style={{ marginBottom: 4, color: 'var(--text3)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Авто-розділення: кожен рядок аналізується окремо
                </div>
                <div style={{ display: 'flex', gap: 16, fontFamily: 'var(--mono)' }}>
                  <span style={{ color: '#7da3ff', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <Server size={11} /> <b>{preview.route_counts.servers}</b> сервер{preview.route_counts.servers === 1 ? '' : 'ів'}
                  </span>
                  <span style={{ color: '#4ade80', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <MailIcon size={11} /> <b>{preview.route_counts.mail}</b> поштов{preview.route_counts.mail === 1 ? 'а скринька' : 'их скриньок'}
                  </span>
                  {preview.route_counts.skip > 0 && (
                    <span style={{ color: 'var(--text3)' }}>
                      <b>{preview.route_counts.skip}</b> пропущено
                    </span>
                  )}
                </div>
              </div>
            )}

            {target !== 'notes' && target !== 'auto' && (
              <div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 6 }}>
                  Зв'яжіть поля сутності з колонками таблиці:
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 6, fontSize: 12 }}>
                  {(target === 'servers'
                    ? ['host', 'label', 'username', 'password', 'web_url', 'tags', 'notes']
                    : ['email', 'password', 'label', 'tags', 'notes']
                  ).map(field => {
                    const required = (target === 'servers' && field === 'host') || (target === 'mail' && field === 'email')
                    const filled = !!cmap[field]
                    return (
                      <div key={field} style={{ display: 'contents' }}>
                        <div style={{
                          padding: '6px 8px',
                          background: filled ? 'var(--bg2)' : (required ? 'rgba(248,113,113,0.08)' : 'var(--bg2)'),
                          borderRadius: 6,
                          fontFamily: 'var(--mono)',
                          color: required && !filled ? '#fca5a5' : 'var(--text2)',
                          display: 'flex', alignItems: 'center',
                        }}>
                          {field}
                          {required && <span style={{ color: '#f87171', marginLeft: 4 }}>*</span>}
                        </div>
                        <select value={cmap[field] || ''} onChange={e => setCmap(m => ({ ...m, [field]: e.target.value }))}
                          style={{
                            background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
                            padding: '6px 8px', color: 'var(--text)', fontSize: 12,
                          }}>
                          <option value="">— не імпортувати —</option>
                          {preview.headers.map(h => {
                            const t = preview.column_types?.[h]
                            const tagLabel = t && t !== 'empty' ? `  [${t}]` : ''
                            return <option key={h} value={h}>{h}{tagLabel}</option>
                          })}
                        </select>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Preview table with column-type badges under headers */}
            <div style={{ marginTop: 6 }}>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4 }}>
                Перегляд (перші {preview.rows.length} рядків):
              </div>
              <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
                <table style={{ borderCollapse: 'collapse', fontSize: 11, fontFamily: 'var(--mono)' }}>
                  <thead style={{ position: 'sticky', top: 0, background: 'var(--bg2)', zIndex: 1 }}>
                    <tr>{preview.headers.map(h => (
                      <th key={h} style={{ padding: '4px 8px', borderBottom: '1px solid var(--border)', textAlign: 'left', whiteSpace: 'nowrap', color: 'var(--text2)', verticalAlign: 'top' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                          <span>{h}</span>
                          {preview.column_types?.[h] && preview.column_types[h] !== 'empty' && (
                            <ColTypeBadge type={preview.column_types[h]} />
                          )}
                        </div>
                      </th>
                    ))}</tr>
                  </thead>
                  <tbody>{preview.rows.map((r, i) => (
                    <tr key={i}>{preview.headers.map(h => (
                      <td key={h} style={{ padding: '3px 8px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text3)' }}>
                        {r[h] || ''}
                      </td>
                    ))}</tr>
                  ))}</tbody>
                </table>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <Btn variant="ghost" onClick={() => setStep(2)}><ArrowLeft size={13} /> Назад</Btn>
              <Btn onClick={doRun} disabled={busy}>
                {busy ? <Spinner size={12} /> : <Check size={13} />}
                {queue.length > 1 ? ' Імпорт + наступний' : ' Імпортувати'}
              </Btn>
            </div>
          </div>
        )}

        {/* Step 4: aggregated result */}
        {step === 4 && result && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {result.aggregated ? (
              <>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#4ade80' }}>
                  <Check size={14} style={{ verticalAlign: -2 }} /> Імпортовано {result.aggregated.length} {result.aggregated.length === 1 ? 'аркуш' : 'аркушів'}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
                  {result.aggregated.map((a, i) => (
                    <div key={i} style={{
                      padding: '10px 12px', background: 'var(--bg2)', border: '1px solid var(--border)',
                      borderRadius: 8, fontSize: 12,
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <span style={{ fontWeight: 600 }}>{a.tab_name}</span>
                        <span style={{ fontSize: 11, color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <ArrowRight size={11} /> {a.target}
                        </span>
                      </div>
                      <div style={{ color: 'var(--text2)', display: 'flex', gap: 10, alignItems: 'center' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                          <Check size={11} color="#4ade80" /> <b>{a.result.created || 0}</b>
                        </span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                          <RotateCw size={11} color="#fbbf24" /> <b>{a.result.updated || 0}</b>
                        </span>
                        <span>skip <b>{a.result.skipped || 0}</b></span>
                      </div>
                      {a.result.errors?.length > 0 && (
                        <div style={{ marginTop: 4, fontSize: 11, color: '#fca5a5', fontFamily: 'var(--mono)' }}>
                          {a.result.errors.join('; ')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div style={{
                padding: 14, background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.3)',
                borderRadius: 8, color: 'var(--text)',
              }}>
                <div style={{ fontWeight: 700, marginBottom: 6, color: '#4ade80' }}>
                  <Check size={14} style={{ verticalAlign: -2 }} /> Готово
                </div>
                <div style={{ fontSize: 12, color: 'var(--text2)' }}>
                  Створено: <b>{result.created || 0}</b> · Оновлено: <b>{result.updated || 0}</b> · Пропущено: <b>{result.skipped || 0}</b>
                </div>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <Btn variant="ghost" onClick={() => { setStep(2); setResult(null); setAggregated([]) }}>
                <ArrowLeft size={13} /> Ще аркуші
              </Btn>
              <Btn onClick={onClose}>Закрити</Btn>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

function SheetCard({ sheet, onOpen, onDelete, onRename, onBind }) {
  const isGoogle = sheet.kind === 'google'
  const isLocked = sheet.is_encrypted

  const iconBg = isGoogle ? 'var(--green-dim)' : isLocked ? 'var(--accent-dim)' : 'rgba(255,159,10,0.15)'
  const iconColor = isGoogle ? 'var(--green)' : isLocked ? 'var(--accent)' : '#ff9f0a'
  const IconComp = isGoogle ? Globe : isLocked ? Lock : FileSpreadsheet

  return (
    <div onClick={onOpen} style={{
      background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 12,
      padding: 14, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 10,
      transition: 'all 0.15s',
    }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border2)'; e.currentTarget.style.transform = 'translateY(-1px)' }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.transform = 'none' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ width: 36, height: 36, borderRadius: 8, background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <IconComp size={17} style={{ color: iconColor }} />
        </div>
        <div style={{ display: 'flex', gap: 4 }} onClick={e => e.stopPropagation()}>
          <button onClick={onRename} title="Перейменувати"
            style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 4, borderRadius: 4 }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--accent)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
          ><FileSpreadsheet size={13} /></button>
          {onBind && (
            <button onClick={onBind} title="Прив'язати до сутності"
              style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 4, borderRadius: 4 }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--green)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
            ><Link2 size={13} /></button>
          )}
          <button onClick={onDelete} title="Видалити"
            style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 4, borderRadius: 4 }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--red)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
          ><Trash2 size={13} /></button>
        </div>
      </div>
      <div style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {sheet.name}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>
          {sheet.updated_at ? new Date(sheet.updated_at).toLocaleString('uk-UA') : '—'}
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          {isGoogle && <Badge color="green"><Globe size={9} /> Google</Badge>}
          {isLocked && <Badge color="blue"><Lock size={9} /> Пароль</Badge>}
        </div>
      </div>
    </div>
  )
}

// ── Modals ──────────────────────────────────────────────────────────────

function NewSheetModal({ open, onClose, onCreate, loading }) {
  const [name, setName] = useState('')
  const [withPwd, setWithPwd] = useState(false)
  const [pwd, setPwd] = useState('')
  const [pwd2, setPwd2] = useState('')
  useEffect(() => { if (open) { setName(''); setWithPwd(false); setPwd(''); setPwd2('') } }, [open])

  function submit() {
    if (!name.trim()) return
    if (withPwd) {
      if (pwd.length < 4) return toast.error('Пароль мінімум 4 символи')
      if (pwd !== pwd2) return toast.error('Паролі не співпадають')
      onCreate(name.trim(), pwd)
    } else {
      onCreate(name.trim(), null)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Нова таблиця">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Назва">
          <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Витрати квітень" />
        </Field>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={withPwd} onChange={e => setWithPwd(e.target.checked)} style={{ width: 'auto' }} />
          <Lock size={13} style={{ color: 'var(--text2)' }} /> Захистити паролем
        </label>
        {withPwd && (
          <>
            <Field label="Пароль">
              <input type="password" value={pwd} onChange={e => setPwd(e.target.value)} />
            </Field>
            <Field label="Повторіть пароль">
              <input type="password" value={pwd2} onChange={e => setPwd2(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && submit()} />
            </Field>
          </>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>Скасувати</Btn>
          <Btn loading={loading} disabled={!name.trim()} onClick={submit}>
            <Plus size={14} /> Створити
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

function GoogleSheetModal({ open, onClose, onCreate, loading }) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  useEffect(() => { if (open) { setName(''); setUrl('') } }, [open])

  function submit() {
    const cleanUrl = url.trim()
    if (!name.trim() || !cleanUrl) return
    if (!/^https?:\/\/(docs\.google\.com|sheets\.google\.com)/i.test(cleanUrl)) {
      if (!window.confirm('URL не виглядає як Google Sheets — додати все одно?')) return
    }
    onCreate(name.trim(), cleanUrl)
  }

  return (
    <Modal open={open} onClose={onClose} title="Додати Google Sheet" width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Назва (підпис у вкладці)">
          <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Бюджет Q2" />
        </Field>
        <Field label="URL Google Sheet">
          <input value={url} onChange={e => setUrl(e.target.value)}
            placeholder="https://docs.google.com/spreadsheets/d/.../edit" />
        </Field>
        <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.55 }}>
          Вставте звичайний URL з адресного рядка Google Sheets. У вас має бути доступ до цього файлу у браузері (через ваш Google акаунт).
          Якщо файл публічний — буде працювати у будь-кого.
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>Скасувати</Btn>
          <Btn loading={loading} disabled={!name.trim() || !url.trim()} onClick={submit}>
            <Plus size={14} /> Додати
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

function UnlockSheetModal({ sheet, onClose, onUnlocked }) {
  const [pwd, setPwd] = useState('')
  const [loading, setLoading] = useState(false)
  useEffect(() => { if (sheet) setPwd('') }, [sheet])

  async function submit() {
    if (!pwd) return
    setLoading(true)
    try {
      const r = await getSheet(sheet.id)
      await decryptData(r.data.data, pwd)
      onUnlocked(sheet.id, pwd)
    } catch (e) {
      toast.error(e.message || 'Невірний пароль')
    } finally { setLoading(false) }
  }

  return (
    <Modal open={!!sheet} onClose={onClose} title={sheet ? `Відкрити: ${sheet.name}` : ''}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ fontSize: 12, color: 'var(--text3)', margin: 0 }}>
          Таблиця зашифрована. Введіть пароль для відкриття.
        </p>
        <Field label="Пароль">
          <input autoFocus type="password" value={pwd} onChange={e => setPwd(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()} />
        </Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>Скасувати</Btn>
          <Btn loading={loading} disabled={!pwd} onClick={submit}><Unlock size={13} /> Відкрити</Btn>
        </div>
      </div>
    </Modal>
  )
}

// ── Local sheet editor (fortune-sheet) ───────────────────────────────────

function LocalSheetEditor({ id, password, onClose }) {
  const qc = useQueryClient()
  const [dirty, setDirty] = useState(false)
  const [plainData, setPlainData] = useState(null)
  const [decryptError, setDecryptError] = useState(null)
  const dataRef = useRef(null)
  const isEncryptedSheet = !!password

  const { data: sheet, isLoading } = useQuery({
    queryKey: ['sheet', id],
    queryFn: () => getSheet(id).then(r => r.data),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })

  useEffect(() => {
    if (!sheet?.data) return
    if (!isEncrypted(sheet.data)) { setPlainData(sheet.data); return }
    if (!password) { setDecryptError('Потрібен пароль'); return }
    decryptData(sheet.data, password).then(setPlainData)
      .catch(e => setDecryptError(e.message || 'Помилка розшифровки'))
  }, [sheet?.id])

  const saveMut = useMutation({
    mutationFn: async (data) => {
      const plain = JSON.stringify(data)
      const payload = isEncryptedSheet ? await encryptData(plain, password) : plain
      return updateSheet(id, { data: payload })
    },
    onSuccess: () => { setDirty(false); toast.success('Збережено'); qc.invalidateQueries(['sheets']) },
    onError: () => toast.error('Помилка збереження'),
  })

  const renameMut = useMutation({
    mutationFn: (name) => renameSheet(id, name),
    onSuccess: () => qc.invalidateQueries(['sheets']),
  })

  const initialData = useMemo(() => {
    if (!plainData) return BLANK_SHEET
    try {
      const parsed = JSON.parse(plainData)
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : BLANK_SHEET
    } catch { return BLANK_SHEET }
  }, [plainData])

  useEffect(() => {
    const h = e => { if (dirty) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  useEffect(() => {
    const h = e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        if (dataRef.current) saveMut.mutate(dataRef.current)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [saveMut])

  function downloadXlsx() {
    const data = dataRef.current || initialData
    const wb = XLSX.utils.book_new()
    data.forEach(s => {
      const grid = []
      ;(s.celldata || []).forEach(c => {
        if (!grid[c.r]) grid[c.r] = []
        grid[c.r][c.c] = c.v?.v ?? c.v?.m ?? ''
      })
      const ws = XLSX.utils.aoa_to_sheet(grid)
      XLSX.utils.book_append_sheet(wb, ws, (s.name || 'Sheet').slice(0, 31))
    })
    const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
    saveAs(new Blob([out], { type: 'application/octet-stream' }), `${sheet.name}.xlsx`)
  }

  if (isLoading || (!plainData && !decryptError)) return <div style={{ display: 'flex', justifyContent: 'center', padding: 64, flex: 1 }}><Spinner /></div>
  if (decryptError) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 16 }}>
      <Lock size={32} style={{ color: 'var(--red)' }} />
      <span style={{ color: 'var(--red)' }}>{decryptError}</span>
      <Btn onClick={onClose}><X size={13} /> Закрити вкладку</Btn>
    </div>
  )

  return (
    <>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px',
        borderBottom: '1px solid var(--border)', background: 'var(--bg2)', flexShrink: 0,
      }}>
        {isEncryptedSheet && <Badge color="blue"><Lock size={9} /> Зашифровано</Badge>}
        <input
          defaultValue={sheet.name}
          onBlur={e => { if (e.target.value !== sheet.name) renameMut.mutate(e.target.value) }}
          style={{ flex: 1, maxWidth: 320, background: 'transparent', border: '1px solid transparent',
            fontSize: 14, fontWeight: 700, padding: '4px 8px', borderRadius: 6 }}
          onFocus={e => e.target.style.borderColor = 'var(--border)'}
          onBlurCapture={e => e.target.style.borderColor = 'transparent'}
        />
        {dirty && <span style={{ fontSize: 11, color: 'var(--yellow)' }}>● незбережено</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Btn size="sm" variant="ghost" onClick={downloadXlsx}><Download size={13} /> XLSX</Btn>
          <Btn size="sm" loading={saveMut.isPending} onClick={() => dataRef.current && saveMut.mutate(dataRef.current)}>
            <Save size={13} /> Зберегти
          </Btn>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative', background: '#fff' }}>
        <Workbook
          data={initialData}
          onChange={(d) => { dataRef.current = d; setDirty(true) }}
          lang="en"
        />
      </div>
    </>
  )
}

// ── Google Sheet view ────────────────────────────────────────────────────

function GoogleSheetView({ meta, onClose }) {
  const qc = useQueryClient()
  const [reloadKey, setReloadKey] = useState(0)
  const [importPanel, setImportPanel] = useState(false)
  const renameMut = useMutation({
    mutationFn: (name) => renameSheet(meta.id, name),
    onSuccess: () => qc.invalidateQueries(['sheets']),
  })

  return (
    <>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px',
        borderBottom: '1px solid var(--border)', background: 'var(--bg2)', flexShrink: 0,
      }}>
        <Badge color="green"><Globe size={9} /> Google</Badge>
        <input
          defaultValue={meta.name}
          onBlur={e => { if (e.target.value !== meta.name) renameMut.mutate(e.target.value) }}
          style={{ flex: 1, maxWidth: 320, background: 'transparent', border: '1px solid transparent',
            fontSize: 14, fontWeight: 700, padding: '4px 8px', borderRadius: 6 }}
          onFocus={e => e.target.style.borderColor = 'var(--border)'}
          onBlurCapture={e => e.target.style.borderColor = 'transparent'}
        />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Btn size="sm" onClick={() => setImportPanel(true)}>
            <Download size={13} /> Імпорт у Domain Manager
          </Btn>
          <Btn size="sm" variant="ghost" onClick={() => setReloadKey(k => k + 1)} title="Перезавантажити">
            <RefreshCw size={13} />
          </Btn>
          <Btn size="sm" variant="ghost" onClick={() => window.open(meta.external_url, '_blank')}>
            <ExternalLink size={13} /> Open
          </Btn>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, background: '#fff', position: 'relative' }}>
        <iframe
          key={meta.id + ':' + reloadKey}
          src={meta.external_url}
          title={meta.name}
          style={{ width: '100%', height: '100%', border: 'none' }}
          referrerPolicy="no-referrer-when-downgrade"
        />
      </div>

      {importPanel && (
        <BatchImportPanel url={meta.external_url} sheetName={meta.name}
          onClose={() => setImportPanel(false)} />
      )}
    </>
  )
}


// ─── Batch import panel (deep analysis + checkbox per tab + per-tab mapping) ───

function BatchImportPanel({ url, sheetName, onClose }) {
  const [stage, setStage] = useState('loading') // loading | configure | running | done
  const [data, setData] = useState(null)        // { sheet_id, title, tabs: [...] }
  const [config, setConfig] = useState({})      // { [gid]: { include, target, column_map } }
  const [expanded, setExpanded] = useState(null) // gid currently shown in detail
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    let cancelled = false
    api.post('/sheet-import/batch-discover', { url, preview_limit: 5 })
      .then(r => {
        if (cancelled) return
        setData(r.data)
        const init = {}
        for (const t of r.data.tabs) {
          const initialTarget = t.suggested_target
          // Pre-select tabs that confidently map to a real entity (servers or mail).
          // Tabs that fell back to 'notes' are off by default to avoid noise.
          init[t.gid] = {
            include: initialTarget !== 'notes' && !t.error,
            target: initialTarget,
            column_map: t.guess?.[initialTarget] || {},
            category: guessPaymentCategory(t.name),
          }
        }
        setConfig(init)
        setStage('configure')
      })
      .catch(e => {
        toast.error(e?.response?.data?.detail || 'Помилка аналізу таблиці')
        onClose()
      })
    return () => { cancelled = true }
  }, [url])

  function patch(gid, p) {
    setConfig(c => ({ ...c, [gid]: { ...c[gid], ...p } }))
  }
  function setTarget(gid, target) {
    const tab = data.tabs.find(t => t.gid === gid)
    patch(gid, { target, column_map: tab.guess?.[target] || {} })
  }
  function toggleAll(on) {
    if (!data) return
    const next = {}
    for (const t of data.tabs) {
      next[t.gid] = { ...config[t.gid], include: on && !t.error }
    }
    setConfig(next)
  }
  function selectByTarget(target) {
    if (!data) return
    const next = { ...config }
    for (const t of data.tabs) {
      if (t.error) continue
      const matches = target === 'servers'  ? t.can_servers
                   : target === 'mail'      ? t.can_mail
                   : target === 'payments'  ? t.can_payments
                   : true
      if (matches) next[t.gid] = { ...next[t.gid], include: true, target, column_map: t.guess?.[target] || next[t.gid]?.column_map || {} }
    }
    setConfig(next)
  }

  const selectedCount = useMemo(
    () => Object.values(config).filter(c => c?.include).length,
    [config],
  )
  const selectedRows = useMemo(() => {
    if (!data) return 0
    return data.tabs.reduce((s, t) => s + (config[t.gid]?.include ? t.total_rows : 0), 0)
  }, [data, config])

  // Predicted creation counts across all selected tabs
  const predicted = useMemo(() => {
    if (!data) return { servers: 0, mail: 0, notes: 0, payments: 0 }
    let s = 0, m = 0, n = 0, p = 0
    for (const t of data.tabs) {
      const c = config[t.gid]
      if (!c?.include || t.error) continue
      if (c.target === 'servers')      s += t.total_rows
      else if (c.target === 'mail')    m += t.total_rows
      else if (c.target === 'payments') p += t.total_rows
      else if (c.target === 'notes')   n += 1
      else if (c.target === 'auto')   { s += t.route_counts?.servers || 0; m += t.route_counts?.mail || 0 }
    }
    return { servers: s, mail: m, notes: n, payments: p }
  }, [data, config])

  const visibleTabs = useMemo(() => {
    if (!data) return []
    const f = filter.trim().toLowerCase()
    return f ? data.tabs.filter(t => t.name.toLowerCase().includes(f)) : data.tabs
  }, [data, filter])

  async function runImport() {
    const items = data.tabs
      .filter(t => config[t.gid]?.include && !t.error)
      .map(t => ({
        gid: t.gid,
        target: config[t.gid].target,
        column_map: config[t.gid].column_map,
        tab_name: t.name,
        category: config[t.gid].target === 'payments' ? (config[t.gid].category || 'other') : undefined,
      }))
    if (!items.length) { toast.error('Не обрано жодного аркуша'); return }
    setRunning(true); setStage('running')
    try {
      const r = await api.post('/sheet-import/batch-run', { url, items })
      setResult(r.data)
      setStage('done')
      const { created, updated, skipped, errors } = r.data.totals
      toast.success(`Готово · ${created} створено · ${updated} оновлено · ${skipped} пропущено${errors ? ` · ${errors} помилок` : ''}`)
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Помилка імпорту')
      setStage('configure')
    } finally { setRunning(false) }
  }

  return (
    <div style={{
      position: 'absolute', top: 0, right: 0, bottom: 0, width: '62%', minWidth: 520,
      background: 'var(--bg)', borderLeft: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', boxShadow: '-12px 0 24px rgba(0,0,0,0.3)', zIndex: 5,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
        <Download size={14} color="var(--accent)" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Імпорт у Domain Manager</div>
          <div style={{ fontSize: 11, color: 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sheetName}</div>
        </div>
        <button onClick={onClose} style={{
          background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 6,
        }}><X size={16} /></button>
      </div>

      {stage === 'loading' && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, color: 'var(--text3)', fontSize: 13 }}>
          <Spinner /> <span>Аналізую вкладки…</span>
        </div>
      )}

      {stage === 'configure' && data && (
        <>
          {/* Warning if only fallback gid=0 was found */}
          {data.tabs.length === 1 && data.tabs[0].gid === '0' && (
            <div style={{
              margin: 12, padding: 10, background: 'rgba(255,214,10,0.08)',
              border: '1px solid rgba(255,214,10,0.3)', borderRadius: 8, fontSize: 11, color: '#fde68a',
              display: 'flex', alignItems: 'flex-start', gap: 8,
            }}>
              <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>Не вдалось зчитати список аркушів. Переконайтесь, що таблиця розшарена «Anyone with link → Viewer». Доступний лише перший аркуш.</span>
            </div>
          )}

          {/* Toolbar: stats + search + bulk actions */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px',
            background: 'var(--bg2)', borderBottom: '1px solid var(--border)', fontSize: 11,
            flexWrap: 'wrap',
          }}>
            <span style={{ color: 'var(--text3)' }}>
              <b style={{ color: 'var(--text)' }}>{data.tabs.length}</b> вкладок ·
              обрано <b style={{ color: 'var(--accent)' }}>{selectedCount}</b> ·
              <b style={{ color: 'var(--text)' }}> {selectedRows}</b> рядків
            </span>
            <div style={{ flex: 1 }} />
            <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="фільтр…"
              style={{
                background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
                padding: '3px 8px', fontSize: 11, color: 'var(--text)', width: 120,
              }} />
            <button onClick={() => selectByTarget('servers')} style={pillBtnStyle} title="Обрати вкладки придатні для серверів">
              <Server size={10} /> Сервери
            </button>
            <button onClick={() => selectByTarget('mail')} style={pillBtnStyle} title="Обрати вкладки придатні для пошти">
              <MailIcon size={10} /> Пошта
            </button>
            <button onClick={() => selectByTarget('payments')} style={pillBtnStyle} title="Обрати вкладки придатні для оплат">
              <Wallet size={10} /> Оплати
            </button>
            <button onClick={() => toggleAll(true)} style={pillBtnStyle}><Check size={10} /> Усе</button>
            <button onClick={() => toggleAll(false)} style={pillBtnStyle}><X size={10} /> Зняти</button>
          </div>

          {/* Tab grid */}
          <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {visibleTabs.length === 0 && (
              <div style={{ padding: 30, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
                Нічого не знайдено за фільтром
              </div>
            )}
            {visibleTabs.map(t => (
              <CompactTabRow key={t.gid}
                tab={t} cfg={config[t.gid]}
                isExpanded={expanded === t.gid}
                onToggle={() => patch(t.gid, { include: !config[t.gid]?.include })}
                onSetTarget={(v) => setTarget(t.gid, v)}
                onExpand={() => setExpanded(expanded === t.gid ? null : t.gid)}
                onMapChange={(field, header) => patch(t.gid, { column_map: { ...config[t.gid].column_map, [field]: header } })}
                onCategoryChange={(category) => patch(t.gid, { category })}
              />
            ))}
          </div>

          {/* Footer — predicted creation summary + actions */}
          <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', background: 'var(--bg2)', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(predicted.servers > 0 || predicted.mail > 0 || predicted.notes > 0 || predicted.payments > 0) && (
              <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text2)', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.5px', fontSize: 10 }}>буде створено:</span>
                {predicted.servers > 0 && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#7da3ff' }}>
                    <Server size={12} /> <b>{predicted.servers}</b> сервер{predicted.servers === 1 ? '' : 'ів'}
                  </span>
                )}
                {predicted.mail > 0 && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#4ade80' }}>
                    <MailIcon size={12} /> <b>{predicted.mail}</b> пошт{predicted.mail === 1 ? 'а' : 'и'}
                  </span>
                )}
                {predicted.payments > 0 && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#f59e0b' }}>
                    <Wallet size={12} /> <b>{predicted.payments}</b> оплат{predicted.payments === 1 ? 'а' : ''}
                  </span>
                )}
                {predicted.notes > 0 && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--text3)' }}>
                    <FileText size={12} /> <b>{predicted.notes}</b> нотат{predicted.notes === 1 ? 'ка' : 'ок'}
                  </span>
                )}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <Btn variant="ghost" onClick={onClose}>Скасувати</Btn>
              <Btn onClick={runImport} disabled={running || selectedCount === 0}>
                {running ? <Spinner size={12} /> : <Check size={13} />} Імпортувати {selectedCount}
              </Btn>
            </div>
          </div>
        </>
      )}

      {stage === 'running' && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, color: 'var(--text3)', fontSize: 13 }}>
          <Spinner /> <span>Імпортую дані…</span>
        </div>
      )}

      {stage === 'done' && result && (
        <>
          <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{
              padding: 12, background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.3)',
              borderRadius: 8, color: 'var(--text)',
            }}>
              <div style={{ fontWeight: 700, color: '#4ade80', marginBottom: 6 }}>
                <Check size={14} style={{ verticalAlign: -2 }} /> Імпорт завершено
              </div>
              <div style={{ fontSize: 12, color: 'var(--text2)' }}>
                Створено: <b>{result.totals.created}</b> · Оновлено: <b>{result.totals.updated}</b> ·
                Пропущено: <b>{result.totals.skipped}</b>{result.totals.errors ? ` · Помилок: ${result.totals.errors}` : ''}
              </div>
            </div>
            {result.items.map((it, i) => (
              <div key={i} style={{
                padding: 10, background: 'var(--bg2)', border: '1px solid var(--border)',
                borderRadius: 8, fontSize: 12,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontWeight: 600 }}>{it.tab_name}</span>
                  <span style={{ fontSize: 11, color: it.ok ? '#4ade80' : '#f87171', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {it.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                    <ArrowRight size={10} style={{ opacity: 0.6 }} />
                    {it.target}
                  </span>
                </div>
                {it.ok ? (
                  <div style={{ color: 'var(--text3)', fontSize: 11, display: 'flex', gap: 12 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      <Check size={10} color="#4ade80" /> {it.result?.created || 0} створено
                    </span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      <RotateCw size={10} color="#fbbf24" /> {it.result?.updated || 0} оновлено
                    </span>
                    <span>{it.result?.skipped || 0} пропущено</span>
                  </div>
                ) : (
                  <div style={{ color: '#fca5a5', fontSize: 11, fontFamily: 'var(--mono)' }}>{it.error}</div>
                )}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '12px 16px', borderTop: '1px solid var(--border)', background: 'var(--bg2)' }}>
            <Btn onClick={onClose}>Закрити</Btn>
          </div>
        </>
      )}
    </div>
  )
}

const pillBtnStyle = {
  background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 99,
  color: 'var(--text2)', cursor: 'pointer', fontSize: 10, padding: '3px 8px',
  display: 'inline-flex', alignItems: 'center', gap: 4,
}

// Custom-styled checkbox — visually richer than the native control.
function NiceCheckbox({ checked, disabled, onChange, size = 16 }) {
  return (
    <span
      role="checkbox"
      aria-checked={checked}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onClick={(e) => { if (disabled) return; e.stopPropagation(); onChange?.() }}
      onKeyDown={(e) => { if (disabled) return; if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onChange?.() } }}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: size, height: size, borderRadius: 4, flexShrink: 0,
        background: checked ? 'var(--accent)' : 'transparent',
        border: '1.5px solid ' + (checked ? 'var(--accent)' : 'var(--border2, var(--border))'),
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        transition: 'all 0.12s',
      }}>
      {checked && <Check size={Math.round(size * 0.72)} color="#fff" strokeWidth={3} />}
    </span>
  )
}

const TARGET_OPTIONS = [
  { v: 'auto',     label: 'Авто-розділення', icon: Sparkles, needs: 'can_auto' },
  { v: 'servers',  label: 'Сервери',         icon: Server,   needs: 'can_servers' },
  { v: 'mail',     label: 'Пошта',           icon: MailIcon, needs: 'can_mail' },
  { v: 'payments', label: 'Оплати',          icon: Wallet,   needs: 'can_payments' },
  { v: 'notes',    label: 'Нотатка',         icon: FileText, needs: null },
]

const PAYMENT_CATEGORIES = [
  { v: 'license', label: 'Ліцензії' },
  { v: 'klo',      label: 'КЛО' },
  { v: 'server',   label: 'Сервери' },
  { v: 'ai',       label: 'Підписки AI' },
  { v: 'vds',      label: 'ВДС' },
  { v: 'other',    label: 'Інше' },
]

// Best-effort default category from the tab name — just a starting point,
// the admin picks the real one in the dropdown before importing.
function guessPaymentCategory(name) {
  const lc = (name || '').toLowerCase()
  if (/ліценз|лицен/.test(lc)) return 'license'
  if (/вдс|vds/.test(lc)) return 'vds'
  if (/vps|server|сервер/.test(lc)) return 'server'
  if (/ai\b|штучн/.test(lc)) return 'ai'
  if (/кло/.test(lc)) return 'klo'
  return 'other'
}

const COL_TYPE_BADGES = {
  email:    { label: 'email',    color: '#4ade80' },
  ip:       { label: 'IP',       color: '#7da3ff' },
  domain:   { label: 'domain',   color: '#7da3ff' },
  url:      { label: 'URL',      color: '#c084fc' },
  password: { label: 'password', color: '#fbbf24' },
  phone:    { label: 'phone',    color: '#94a3b8' },
  text:     { label: 'text',     color: 'var(--text3)' },
  empty:    { label: '∅',         color: 'var(--text3)' },
}

function ColTypeBadge({ type }) {
  const b = COL_TYPE_BADGES[type] || COL_TYPE_BADGES.text
  return (
    <span style={{
      display: 'inline-block', padding: '1px 6px', borderRadius: 99,
      fontSize: 9, fontFamily: 'var(--mono)', textTransform: 'uppercase',
      background: 'rgba(255,255,255,0.04)', color: b.color, border: `1px solid ${b.color}33`,
      lineHeight: 1.4, letterSpacing: '0.3px',
    }}>{b.label}</span>
  )
}

function CompactTabRow({ tab, cfg, isExpanded, onToggle, onSetTarget, onExpand, onMapChange, onCategoryChange }) {
  if (!cfg) return null
  const disabled = !!tab.error
  const TargetIcon = TARGET_OPTIONS.find(o => o.v === cfg.target)?.icon || FileText
  const active = cfg.include && !disabled

  const fields = cfg.target === 'servers'
    ? ['host', 'label', 'username', 'password', 'web_url', 'tags', 'notes']
    : cfg.target === 'mail'
      ? ['email', 'password', 'label', 'tags', 'notes']
      : cfg.target === 'payments'
        ? ['label', 'provider', 'login', 'password', 'next_due_at', 'notes']
        : []

  return (
    <div style={{
      background: 'var(--bg2)',
      border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border)'),
      borderRadius: 8,
      opacity: disabled ? 0.55 : 1,
      transition: 'border-color 0.12s',
    }}>
      {/* Main row — single flex line, never wraps */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
        cursor: disabled ? 'default' : 'pointer',
      }}
        onClick={(e) => {
          if (disabled) return
          if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON') return
          onToggle()
        }}>
        <NiceCheckbox checked={!!cfg.include} disabled={disabled} onChange={onToggle} />

        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          <div style={{
            fontWeight: 600, fontSize: 13, color: 'var(--text)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {tab.name}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: 6 }}>
            {tab.error
              ? <span style={{ color: '#f87171' }}>помилка: {tab.error}</span>
              : <>
                  <span>{tab.total_rows} рядків · {tab.headers.length} колонок</span>
                  {tab.headerless && (
                    <span style={{
                      padding: '0 5px', borderRadius: 99, fontSize: 9,
                      background: 'rgba(251,191,36,0.12)', color: '#fbbf24',
                      border: '1px solid rgba(251,191,36,0.3)', letterSpacing: '0.3px',
                    }}>без заголовків</span>
                  )}
                  {tab.route_counts && (tab.route_counts.servers > 0 || tab.route_counts.mail > 0) && (
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      {tab.route_counts.servers > 0 && (
                        <span style={{ color: '#7da3ff', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                          <Server size={9} /> {tab.route_counts.servers}
                        </span>
                      )}
                      {tab.route_counts.mail > 0 && (
                        <span style={{ color: '#4ade80', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                          <MailIcon size={9} /> {tab.route_counts.mail}
                        </span>
                      )}
                      {tab.route_counts.skip > 0 && (
                        <span style={{ opacity: 0.6 }}>skip {tab.route_counts.skip}</span>
                      )}
                    </span>
                  )}
                </>}
          </div>
        </div>

        {!disabled && active && (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '3px 6px', borderRadius: 4,
            background: cfg.target === 'servers' ? 'rgba(125,163,255,0.15)'
              : cfg.target === 'mail' ? 'rgba(74,222,128,0.15)'
              : cfg.target === 'payments' ? 'rgba(245,158,11,0.15)'
              : 'var(--bg)',
            color: cfg.target === 'servers' ? '#7da3ff'
              : cfg.target === 'mail' ? '#4ade80'
              : cfg.target === 'payments' ? '#f59e0b'
              : 'var(--text3)',
            fontSize: 10, fontWeight: 600, flexShrink: 0,
          }}>
            <TargetIcon size={10} />
            {TARGET_OPTIONS.find(o => o.v === cfg.target)?.label}
          </div>
        )}

        {!disabled && (
          <button onClick={(e) => { e.stopPropagation(); onExpand() }}
            style={{
              background: 'none', border: '1px solid var(--border)', borderRadius: 6,
              color: isExpanded ? 'var(--accent)' : 'var(--text3)',
              cursor: 'pointer', padding: '4px 6px', flexShrink: 0,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}>
            {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        )}
      </div>

      {/* Expanded details */}
      {isExpanded && !disabled && (
        <div style={{ borderTop: '1px solid var(--border)', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Target switcher */}
          <div>
            <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>Куди імпортувати</div>
            <div style={{ display: 'flex', gap: 4 }}>
              {TARGET_OPTIONS.map(o => {
                const ok = !o.needs || tab[o.needs]
                const sel = cfg.target === o.v
                const Ic = o.icon
                const tipMap = {
                  auto:     'Не виявлено рядків з email чи host',
                  servers:  'Не знайдено колонку host/ip',
                  mail:     'Не знайдено колонку email',
                  payments: 'Не знайдено колонку з назвою',
                }
                return (
                  <button key={o.v} disabled={!ok} onClick={() => onSetTarget(o.v)}
                    title={!ok ? tipMap[o.v] : ''}
                    style={{
                      flex: 1, padding: '6px 8px', borderRadius: 6,
                      background: sel ? 'var(--accent-dim)' : 'var(--bg)',
                      color: sel ? 'var(--accent)' : ok ? 'var(--text2)' : 'var(--text3)',
                      border: '1px solid ' + (sel ? 'var(--accent)' : 'var(--border)'),
                      cursor: ok ? 'pointer' : 'not-allowed',
                      fontSize: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                      opacity: ok ? 1 : 0.5,
                    }}>
                    <Ic size={11} /> {o.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Payments — which category these rows become */}
          {cfg.target === 'payments' && (
            <div>
              <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>Категорія оплат</div>
              <select value={cfg.category || 'other'} onChange={e => onCategoryChange(e.target.value)}
                style={{
                  width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
                  padding: '5px 8px', color: 'var(--text)', fontSize: 11,
                }}>
                {PAYMENT_CATEGORIES.map(c => <option key={c.v} value={c.v}>{c.label}</option>)}
              </select>
            </div>
          )}

          {/* Auto mode — summary of what will be split */}
          {cfg.target === 'auto' && tab.route_counts && (
            <div style={{
              padding: 10, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
              fontSize: 11, display: 'flex', flexDirection: 'column', gap: 4,
            }}>
              <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Авто-розділення: що буде створено
              </div>
              <div style={{ display: 'flex', gap: 14, fontFamily: 'var(--mono)' }}>
                <span style={{ color: '#7da3ff', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Server size={11} /> <b>{tab.route_counts.servers}</b> сервер{tab.route_counts.servers === 1 ? '' : 'ів'}
                </span>
                <span style={{ color: '#4ade80', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <MailIcon size={11} /> <b>{tab.route_counts.mail}</b> поштов{tab.route_counts.mail === 1 ? 'а скринька' : 'их скриньок'}
                </span>
                {tab.route_counts.skip > 0 && (
                  <span style={{ color: 'var(--text3)' }}>
                    <b>{tab.route_counts.skip}</b> пропущено
                  </span>
                )}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>
                Кожен рядок аналізується окремо; маппінг колонок підбирається автоматично.
              </div>
            </div>
          )}

          {/* Column mapping */}
          {cfg.target !== 'auto' && fields.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>Маппінг колонок</div>
              <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 4, fontSize: 11 }}>
                {fields.map(field => {
                  const required = (cfg.target === 'servers' && field === 'host') || (cfg.target === 'mail' && field === 'email') || (cfg.target === 'payments' && field === 'label')
                  const filled = !!cfg.column_map[field]
                  return (
                    <div key={field} style={{ display: 'contents' }}>
                      <div style={{
                        padding: '3px 8px',
                        background: filled ? 'var(--bg)' : 'rgba(248,113,113,0.06)',
                        borderRadius: 4, fontFamily: 'var(--mono)', fontSize: 10,
                        color: required && !filled ? '#fca5a5' : 'var(--text2)',
                        display: 'flex', alignItems: 'center',
                      }}>
                        {field}{required && <span style={{ color: '#f87171', marginLeft: 4 }}>*</span>}
                      </div>
                      <select value={cfg.column_map[field] || ''} onChange={e => onMapChange(field, e.target.value)}
                        style={{
                          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4,
                          padding: '3px 8px', color: 'var(--text)', fontSize: 11,
                        }}>
                        <option value="">— не імпортувати —</option>
                        {tab.headers.map(h => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Preview */}
          {tab.rows_sample.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
                Перші {tab.rows_sample.length} рядків
              </div>
              <div style={{ maxHeight: 160, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 4 }}>
                <table style={{ borderCollapse: 'collapse', fontSize: 10, fontFamily: 'var(--mono)' }}>
                  <thead style={{ position: 'sticky', top: 0, background: 'var(--bg)', zIndex: 1 }}>
                    <tr>{tab.headers.map(h => (
                      <th key={h} style={{ padding: '3px 6px', borderBottom: '1px solid var(--border)', textAlign: 'left', whiteSpace: 'nowrap', color: 'var(--text3)' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <span>{h}</span>
                          {tab.column_types?.[h] && tab.column_types[h] !== 'empty' && (
                            <ColTypeBadge type={tab.column_types[h]} />
                          )}
                        </div>
                      </th>
                    ))}</tr>
                  </thead>
                  <tbody>{tab.rows_sample.map((r, i) => (
                    <tr key={i}>{tab.headers.map(h => (
                      <td key={h} style={{ padding: '2px 6px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text3)' }}>
                        {r[h] || ''}
                      </td>
                    ))}</tr>
                  ))}</tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}


// ── Two-way binding modal ──────────────────────────────────────────────

function BindingModal({ sheet, onClose }) {
  const qc = useQueryClient()
  const [entities, setEntities] = useState([])
  const [entity, setEntity] = useState('')
  const [direction, setDirection] = useState('both')
  const [colMap, setColMap] = useState([])   // [{ header, field }]
  const [existing, setExisting] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!sheet) return
    setLoading(true)
    Promise.all([
      api.get('/sheet-sync/entities').then(r => r.data).catch(() => []),
      api.get(`/sheet-sync/${sheet.id}`).then(r => r.data).catch(() => null),
    ]).then(([ents, b]) => {
      setEntities(ents || [])
      if (b) {
        setExisting(b)
        setEntity(b.entity)
        setDirection(b.direction)
        setColMap(Object.entries(b.column_map).map(([header, field]) => ({ header, field })))
      } else {
        setExisting(null); setEntity(ents[0]?.key || '')
        setColMap([])
      }
      setLoading(false)
    })
  }, [sheet?.id])

  const fields = entities.find(e => e.key === entity)?.fields || []

  function addRow() { setColMap(m => [...m, { header: '', field: fields[0] || '' }]) }
  function removeRow(i) { setColMap(m => m.filter((_, idx) => idx !== i)) }
  function defaultMap() {
    setColMap(fields.map(f => ({ header: f, field: f })))
  }

  async function save() {
    const map = {}
    for (const r of colMap) if (r.header && r.field) map[r.header] = r.field
    if (!Object.keys(map).length) { toast.error('Додайте хоча б одну колонку'); return }
    try {
      await api.post(`/sheet-sync/${sheet.id}`, {
        entity, direction, column_map: map,
      })
      toast.success('Прив\'язано')
      qc.invalidateQueries(['sheets'])
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Помилка')
    }
  }
  async function pull() {
    try {
      const r = await api.post(`/sheet-sync/${sheet.id}/pull`)
      toast.success(`Завантажено ${r.data.rows} рядків з платформи`)
      qc.invalidateQueries(['sheets'])
      qc.invalidateQueries(['sheet', sheet.id])
    } catch (e) { toast.error(e?.response?.data?.detail || 'Помилка') }
  }
  async function push() {
    try {
      const r = await api.post(`/sheet-sync/${sheet.id}/push`)
      toast.success(`Створено: ${r.data.created}, оновлено: ${r.data.updated}, пропущено: ${r.data.skipped}`)
    } catch (e) { toast.error(e?.response?.data?.detail || 'Помилка') }
  }
  async function unbind() {
    if (!confirm('Видалити прив\'язку?')) return
    await api.delete(`/sheet-sync/${sheet.id}`)
    toast.success('Прив\'язка знята')
    setExisting(null); setColMap([])
  }

  if (!sheet) return null
  return (
    <Modal open={!!sheet} onClose={onClose} title={`Прив'язка таблиці «${sheet.name}»`}>
      {loading ? <Spinner /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>
            Прив'язана таблиця стає живим дзеркалом сутності платформи. Зміни на сторінці (Пошта/Сервери/Проксі/Особистості) — миттєво потрапляють у цей аркуш. Зміни в таблиці — застосовуються до сутності кнопкою «Записати в платформу».
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Сутність">
              <select value={entity} onChange={e => { setEntity(e.target.value); setColMap([]) }}>
                {entities.map(e => <option key={e.key} value={e.key}>{e.key}</option>)}
              </select>
            </Field>
            <Field label="Напрямок">
              <select value={direction} onChange={e => setDirection(e.target.value)}>
                <option value="both">↔ обидва</option>
                <option value="pull">← з платформи в таблицю</option>
                <option value="push">→ з таблиці в платформу</option>
              </select>
            </Field>
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Карта колонок</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <Btn variant="ghost" onClick={defaultMap}>Авто</Btn>
                <Btn variant="ghost" onClick={addRow}><Plus size={12} /> Додати</Btn>
              </div>
            </div>
            {colMap.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text3)', padding: 10, border: '1px dashed var(--border)', borderRadius: 6 }}>
                Натисніть «Авто» — заповнить всі поля сутності або «Додати» вручну.
              </div>
            )}
            {colMap.map((row, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                <input value={row.header} onChange={e => setColMap(m => m.map((r, idx) => idx === i ? { ...r, header: e.target.value } : r))}
                  placeholder="Заголовок у таблиці" style={{ flex: 1 }} />
                <select value={row.field} onChange={e => setColMap(m => m.map((r, idx) => idx === i ? { ...r, field: e.target.value } : r))}
                  style={{ flex: 1 }}>
                  <option value="">— поле сутності —</option>
                  {fields.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
                <button onClick={() => removeRow(i)} style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer' }}>
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>

          {existing && (
            <div style={{ fontSize: 11, color: 'var(--text3)' }}>
              Прив'язка вже існує: {existing.entity} · {existing.direction} · оновлено {existing.last_sync_at ? new Date(existing.last_sync_at).toLocaleString('uk-UA') : '—'}
              {existing.last_error && <div style={{ color: 'var(--red)' }}>Помилка: {existing.last_error}</div>}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            {existing && <Btn variant="danger" onClick={unbind}>Зняти прив'язку</Btn>}
            <Btn variant="ghost" onClick={pull} disabled={!existing}>← Підтягнути з платформи</Btn>
            <Btn variant="ghost" onClick={push} disabled={!existing}>→ Записати в платформу</Btn>
            <Btn variant="primary" onClick={save}>Зберегти</Btn>
          </div>
        </div>
      )}
    </Modal>
  )
}
