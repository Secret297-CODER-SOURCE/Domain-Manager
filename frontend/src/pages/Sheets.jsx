import { useState, useRef, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Workbook } from '@fortune-sheet/react'
import '@fortune-sheet/react/dist/index.css'
import toast from 'react-hot-toast'
import { Plus, Trash2, Download, Upload, FileSpreadsheet, ArrowLeft, Save, Lock, Unlock } from 'lucide-react'
import { saveAs } from 'file-saver'
import * as XLSX from 'xlsx'

import { getSheets, createSheet, getSheet, updateSheet, deleteSheet } from '../api/client'
import { Btn, Spinner, Modal, Field, Badge } from '../components/ui/index'
import { useDeleteOtp } from '../context/DeleteOtpContext'
import { isEncrypted, encryptData, decryptData } from '../services/cryptoSheet'

const BLANK_SHEET = [{ name: 'Аркуш 1', celldata: [], row: 84, column: 60 }]

export default function SheetsPage() {
  // openSheet = { id, password?: string }
  const [openSheet, setOpenSheet] = useState(null)
  if (openSheet) return <SheetEditor id={openSheet.id} password={openSheet.password} onClose={() => setOpenSheet(null)} />
  return <SheetList onOpen={(id, password) => setOpenSheet({ id, password })} />
}

function SheetList({ onOpen }) {
  const qc = useQueryClient()
  const { gateDelete } = useDeleteOtp()
  const [newModal, setNewModal] = useState(false)
  const [unlockSheet, setUnlockSheet] = useState(null)
  const fileRef = useRef(null)

  const { data: sheets = [], isLoading } = useQuery({
    queryKey: ['sheets'],
    queryFn: () => getSheets().then(r => r.data),
  })

  const createMut = useMutation({
    mutationFn: async ({ name, password }) => {
      const plain = JSON.stringify(BLANK_SHEET)
      const data = password ? await encryptData(plain, password) : plain
      const r = await createSheet({ name, data })
      return { sheet: r.data, password }
    },
    onSuccess: ({ sheet, password }) => {
      qc.invalidateQueries(['sheets'])
      onOpen(sheet.id, password)
    },
  })

  function handleCardOpen(sheet) {
    if (sheet.is_encrypted) setUnlockSheet(sheet)
    else onOpen(sheet.id, null)
  }

  const delMut = useMutation({
    mutationFn: deleteSheet,
    onSuccess: () => { toast.success('Таблицю видалено'); qc.invalidateQueries(['sheets']) },
  })

  async function importXlsx(file) {
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const sheets = wb.SheetNames.map((name, idx) => {
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
      const r = await createSheet({ name: file.name.replace(/\.[^.]+$/, ''), data: JSON.stringify(sheets) })
      qc.invalidateQueries(['sheets'])
      onOpen(r.data.id)
      toast.success('Імпортовано')
    } catch (e) {
      toast.error('Помилка імпорту: ' + (e.message || e))
    }
  }

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, height: '100%', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontWeight: 800, fontSize: 22 }}>Таблиці</h1>
          <p style={{ color: 'var(--text3)', fontSize: 12, marginTop: 2 }}>
            {sheets.length} {sheets.length === 1 ? 'таблиця' : 'таблиць'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={e => e.target.files?.[0] && importXlsx(e.target.files[0])} />
          <Btn variant="ghost" onClick={() => fileRef.current?.click()}>
            <Upload size={14} /> Імпорт XLSX/CSV
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
        {isLoading ? <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spinner /></div>
          : sheets.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 48, color: 'var(--text3)', fontSize: 13 }}>
              Немає таблиць. Створіть першу або імпортуйте XLSX.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, padding: 8 }}>
              {sheets.map(s => (
                <SheetCard key={s.id} sheet={s}
                  onOpen={() => handleCardOpen(s)}
                  onDelete={() => gateDelete(() => delMut.mutateAsync(s.id)).catch(() => {})}
                />
              ))}
            </div>
          )
        }
      </div>

      <NewSheetModal open={newModal} onClose={() => setNewModal(false)}
        onCreate={(name, password) => { createMut.mutate({ name, password }); setNewModal(false) }}
        loading={createMut.isPending} />
      <UnlockSheetModal sheet={unlockSheet} onClose={() => setUnlockSheet(null)}
        onUnlocked={(id, password) => { setUnlockSheet(null); onOpen(id, password) }} />
    </div>
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
      await decryptData(r.data.data, pwd) // verify password works
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

function SheetCard({ sheet, onOpen, onDelete }) {
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
        <div style={{
          width: 36, height: 36, borderRadius: 8,
          background: sheet.is_encrypted ? 'var(--accent-dim)' : 'var(--green-dim)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {sheet.is_encrypted
            ? <Lock size={17} style={{ color: 'var(--accent)' }} />
            : <FileSpreadsheet size={18} style={{ color: 'var(--green)' }} />}
        </div>
        <button onClick={e => { e.stopPropagation(); onDelete() }} title="Видалити"
          style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 4, borderRadius: 4 }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--red)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
        ><Trash2 size={13} /></button>
      </div>
      <div style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {sheet.name}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>
          {sheet.updated_at ? new Date(sheet.updated_at).toLocaleString('uk-UA') : '—'}
        </span>
        {sheet.is_encrypted && <Badge color="blue"><Lock size={9} /> Пароль</Badge>}
      </div>
    </div>
  )
}

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
          <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Напр. Витрати квітень" />
        </Field>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={withPwd} onChange={e => setWithPwd(e.target.checked)} style={{ width: 'auto' }} />
          <Lock size={13} style={{ color: 'var(--text2)' }} />
          Захистити паролем
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
            <p style={{ fontSize: 11, color: 'var(--text3)', margin: 0 }}>
              Пароль не відновлюється. Шифрування AES-GCM у браузері — сервер бачить лише шифротекст.
            </p>
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

function SheetEditor({ id, password, onClose }) {
  const qc = useQueryClient()
  const [dirty, setDirty] = useState(false)
  const [plainData, setPlainData] = useState(null) // decrypted JSON string
  const [decryptError, setDecryptError] = useState(null)
  const dataRef = useRef(null)
  const isEncryptedSheet = !!password

  const { data: sheet, isLoading } = useQuery({
    queryKey: ['sheet', id],
    queryFn: () => getSheet(id).then(r => r.data),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })

  // Decrypt once when sheet loads
  useEffect(() => {
    if (!sheet?.data) return
    if (!isEncrypted(sheet.data)) { setPlainData(sheet.data); return }
    if (!password) { setDecryptError('Потрібен пароль'); return }
    decryptData(sheet.data, password)
      .then(setPlainData)
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
    mutationFn: (name) => updateSheet(id, { name }),
    onSuccess: () => qc.invalidateQueries(['sheets']),
  })

  const initialData = useMemo(() => {
    if (!plainData) return BLANK_SHEET
    try {
      const parsed = JSON.parse(plainData)
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : BLANK_SHEET
    } catch { return BLANK_SHEET }
  }, [plainData])

  // Warn before leaving with unsaved changes
  useEffect(() => {
    const h = e => { if (dirty) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  // Cmd/Ctrl+S to save
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

  function handleClose() {
    if (dirty && !window.confirm('Є незбережені зміни. Точно вийти?')) return
    onClose()
  }

  if (isLoading || (!plainData && !decryptError)) return <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}><Spinner /></div>
  if (decryptError) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 16 }}>
      <Lock size={32} style={{ color: 'var(--red)' }} />
      <span style={{ color: 'var(--red)' }}>{decryptError}</span>
      <Btn onClick={onClose}><ArrowLeft size={13} /> Назад</Btn>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '12px 20px',
        borderBottom: '1px solid var(--border)', background: 'var(--bg2)', flexShrink: 0,
      }}>
        <Btn size="sm" variant="ghost" onClick={handleClose}><ArrowLeft size={13} /> Назад</Btn>
        {isEncryptedSheet && <Badge color="blue"><Lock size={9} /> Зашифровано</Badge>}
        <input
          defaultValue={sheet.name}
          onBlur={e => { if (e.target.value !== sheet.name) renameMut.mutate(e.target.value) }}
          style={{ flex: 1, maxWidth: 320, background: 'transparent', border: '1px solid transparent', fontSize: 15, fontWeight: 700, padding: '4px 8px', borderRadius: 6 }}
          onFocus={e => e.target.style.borderColor = 'var(--border)'}
          onBlurCapture={e => e.target.style.borderColor = 'transparent'}
        />
        {dirty && <span style={{ fontSize: 11, color: 'var(--yellow)' }}>● незбережено</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Btn size="sm" variant="ghost" onClick={downloadXlsx}><Download size={13} /> Завантажити XLSX</Btn>
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
    </div>
  )
}
