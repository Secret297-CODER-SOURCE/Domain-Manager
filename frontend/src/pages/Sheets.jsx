import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Workbook } from '@fortune-sheet/react'
import '@fortune-sheet/react/dist/index.css'
import toast from 'react-hot-toast'
import {
  Plus, Trash2, Download, Upload, FileSpreadsheet, Save,
  Lock, Unlock, X, LayoutGrid, Globe, ExternalLink, RefreshCw,
} from 'lucide-react'
import { saveAs } from 'file-saver'
import * as XLSX from 'xlsx'

import {
  getSheets, createSheet, getSheet, updateSheet, deleteSheet, renameSheet,
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
  const [unlockSheet, setUnlockSheet] = useState(null)
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
    </div>
  )
}

function SheetCard({ sheet, onOpen, onDelete, onRename }) {
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
          <Btn size="sm" variant="ghost" onClick={() => setReloadKey(k => k + 1)} title="Перезавантажити">
            <RefreshCw size={13} />
          </Btn>
          <Btn size="sm" variant="ghost" onClick={() => window.open(meta.external_url, '_blank')}>
            <ExternalLink size={13} /> Open
          </Btn>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, background: '#fff' }}>
        <iframe
          key={meta.id + ':' + reloadKey}
          src={meta.external_url}
          title={meta.name}
          style={{ width: '100%', height: '100%', border: 'none' }}
          referrerPolicy="no-referrer-when-downgrade"
        />
      </div>
    </>
  )
}
