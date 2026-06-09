import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { saveAs } from 'file-saver'
import {
  Save, Download, Upload, Send, Server, Lock, Clock, ShieldCheck, AlertTriangle,
  RefreshCw, Trash2, CheckCircle2, Database, Archive, History, ArrowDownToLine,
  FileUp, FolderDown,
} from 'lucide-react'

import {
  getBackupConfig, saveBackupConfig, listBackupRuns, deleteBackupRun,
  runBackup, previewBackupRestore, doBackupRestore,
  listSftpBackups, previewSftpBackup, restoreFromSftp,
} from '../api/client'
import { Btn, Modal, Spinner, Field, Badge } from '../components/ui/index'
import { useDeleteOtp } from '../context/DeleteOtpContext'

export default function BackupPage() {
  const qc = useQueryClient()
  const { gateDelete } = useDeleteOtp()
  const [restoreModal, setRestoreModal] = useState(false)
  const [runBusy, setRunBusy] = useState(null) // 'download' | 'send' | 'both'

  const { data: cfg, isLoading: cfgLoading } = useQuery({
    queryKey: ['backup-config'],
    queryFn: () => getBackupConfig().then(r => r.data),
  })

  const { data: runs = [], isLoading: runsLoading } = useQuery({
    queryKey: ['backup-runs'],
    queryFn: () => listBackupRuns().then(r => r.data),
    refetchInterval: 15000,
  })

  async function runNow(targets) {
    setRunBusy(targets.join('+'))
    try {
      const r = await runBackup(targets)
      if (targets.includes('download') && r.data instanceof Blob) {
        const cd = r.headers['content-disposition'] || ''
        const m = cd.match(/filename="?([^";]+)"?/i)
        const filename = m?.[1] || `dm-backup-${Date.now()}.zip`
        saveAs(r.data, filename)
        toast.success('Бекап завантажено')
      } else {
        const sent = r.data.sent_to?.join(', ') || '—'
        toast.success(`Бекап надіслано: ${sent}`)
      }
      qc.invalidateQueries(['backup-runs'])
    } catch (e) {
      const detail = e.response?.data?.detail
      toast.error(typeof detail === 'string' ? detail : (e.message || 'Помилка бекапу'))
    } finally { setRunBusy(null) }
  }

  if (cfgLoading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}><Spinner /></div>

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontWeight: 800, fontSize: 22, display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <Archive size={22} style={{ color: 'var(--accent)' }} /> Бекапи
          </h1>
          <p style={{ color: 'var(--text3)', fontSize: 12, marginTop: 2 }}>
            Повний дамп платформи (БД, .kdbx, таблиці, проксі, логи) → AES-zip → Telegram-канал та/або SFTP-сервер.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn variant="ghost" onClick={() => setRestoreModal(true)}><Upload size={14} /> Відновити з файлу</Btn>
          <Btn variant="ghost" loading={runBusy === 'download'} onClick={() => runNow(['download'])}>
            <Download size={14} /> Завантажити зараз
          </Btn>
          <Btn loading={runBusy && runBusy !== 'download'}
            disabled={!cfg.tg_enabled && !cfg.sftp_enabled}
            onClick={() => {
              const t = []
              if (cfg.tg_enabled) t.push('tg')
              if (cfg.sftp_enabled) t.push('sftp')
              runNow(t)
            }}>
            <Send size={14} /> Запустити і надіслати
          </Btn>
        </div>
      </div>

      <ConfigCard cfg={cfg} onSaved={() => qc.invalidateQueries(['backup-config'])} />

      <RunsCard runs={runs} isLoading={runsLoading}
        onDelete={(id) => gateDelete(() => deleteBackupRun(id))
          .then(() => { toast.success('Видалено'); qc.invalidateQueries(['backup-runs']) })
          .catch(() => {})}
      />

      <RestoreModal open={restoreModal} onClose={() => setRestoreModal(false)} />
    </div>
  )
}

// ── Config card ──────────────────────────────────────────────────────────

function ConfigCard({ cfg, onSaved }) {
  const [form, setForm] = useState(() => fromCfg(cfg))
  const [saving, setSaving] = useState(false)
  useEffect(() => { setForm(fromCfg(cfg)) }, [cfg])

  async function save() {
    setSaving(true)
    try {
      await saveBackupConfig(form)
      toast.success('Налаштування збережено')
      onSaved()
    } catch (e) {
      toast.error('Помилка: ' + (e.response?.data?.detail || e.message))
    } finally { setSaving(false) }
  }

  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14, padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <ShieldCheck size={18} style={{ color: 'var(--accent)' }} />
        <h2 style={{ fontSize: 15, fontWeight: 700 }}>Налаштування</h2>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        {/* General */}
        <Section title="Загальне" icon={<Database size={14} />}>
          <Field label="Назва інстансу (у назві файлу і caption)">
            <input value={form.instance_name} onChange={e => set(form, setForm, 'instance_name', e.target.value)} placeholder="prod-team-a" />
          </Field>
          <Field label="Розклад (UTC година, або порожньо = вимкнено)">
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="number" min="0" max="23" placeholder="—"
                value={form.schedule_cron_hour ?? ''}
                onChange={e => set(form, setForm, 'schedule_cron_hour', e.target.value === '' ? null : Math.max(0, Math.min(23, +e.target.value)))}
                style={{ flex: 1 }} />
              <input type="number" min="0" max="59"
                value={form.schedule_cron_minute}
                onChange={e => set(form, setForm, 'schedule_cron_minute', Math.max(0, Math.min(59, +e.target.value || 0)))}
                style={{ flex: 1 }} />
            </div>
          </Field>
          <Field label="Зберігати N останніх успішних бекапів">
            <input type="number" min="1" max="365"
              value={form.retention_count}
              onChange={e => set(form, setForm, 'retention_count', +e.target.value || 14)} />
          </Field>
        </Section>

        {/* Encryption */}
        <Section title="Шифрування архіву" icon={<Lock size={14} />}
          subtitle={cfg.encryption_enabled
            ? <Badge color="green"><Lock size={9} /> AES-256 увімкнено</Badge>
            : <Badge color="yellow"><AlertTriangle size={9} /> Без шифрування</Badge>}>
          <Field label={cfg.encryption_enabled ? 'Новий пароль (порожньо = не змінювати)' : 'Пароль шифрування'}>
            <input type="password"
              value={form.encryption_password || ''}
              onChange={e => set(form, setForm, 'encryption_password', e.target.value)}
              placeholder="мінімум 8 символів" />
          </Field>
          {cfg.encryption_enabled && (
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, cursor: 'pointer', color: 'var(--red)' }}>
              <input type="checkbox" checked={form.clear_encryption} onChange={e => set(form, setForm, 'clear_encryption', e.target.checked)} style={{ width: 'auto' }} />
              Вимкнути шифрування (НЕ рекомендовано)
            </label>
          )}
        </Section>

        {/* Telegram */}
        <Section title="Telegram канал" icon={<Send size={14} />}
          subtitle={cfg.tg_uses_env_token ? <Badge color="default">токен з ENV</Badge> : null}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.tg_enabled} onChange={e => set(form, setForm, 'tg_enabled', e.target.checked)} style={{ width: 'auto' }} />
            Увімкнути
          </label>
          <Field label="Chat ID (канал / група / приватний)">
            <input value={form.tg_chat_id || ''} onChange={e => set(form, setForm, 'tg_chat_id', e.target.value)}
              placeholder="-1001234567890" />
          </Field>
          <Field label="Bot token (порожньо = з ENV)">
            <input type="password" value={form.tg_bot_token || ''} onChange={e => set(form, setForm, 'tg_bot_token', e.target.value)}
              placeholder="123456:ABC..." />
          </Field>
          <p style={{ fontSize: 11, color: 'var(--text3)', margin: 0 }}>
            Бот має бути доданий у канал як адмін з правом надсилати повідомлення. Ліміт файлу: 50 MB.
          </p>
        </Section>

        {/* SFTP */}
        <Section title="SFTP сервер" icon={<Server size={14} />}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.sftp_enabled} onChange={e => set(form, setForm, 'sftp_enabled', e.target.checked)} style={{ width: 'auto' }} />
            Увімкнути
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 2 }}>
              <Field label="Host">
                <input value={form.sftp_host || ''} onChange={e => set(form, setForm, 'sftp_host', e.target.value)} placeholder="backup.example.com" />
              </Field>
            </div>
            <div style={{ flex: 1 }}>
              <Field label="Port">
                <input type="number" value={form.sftp_port || 22} onChange={e => set(form, setForm, 'sftp_port', +e.target.value || 22)} />
              </Field>
            </div>
          </div>
          <Field label="Username">
            <input value={form.sftp_username || ''} onChange={e => set(form, setForm, 'sftp_username', e.target.value)} />
          </Field>
          <Field label={cfg.sftp_enabled ? 'Password (порожньо = не змінювати)' : 'Password'}>
            <input type="password" value={form.sftp_password || ''} onChange={e => set(form, setForm, 'sftp_password', e.target.value)} />
          </Field>
          <Field label="Шлях на сервері">
            <input value={form.sftp_path || '/'} onChange={e => set(form, setForm, 'sftp_path', e.target.value)} placeholder="/var/backups/dm" />
          </Field>
        </Section>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Btn loading={saving} onClick={save}><Save size={14} /> Зберегти налаштування</Btn>
      </div>
    </div>
  )
}

function fromCfg(c) {
  if (!c) return {}
  return {
    instance_name: c.instance_name,
    encryption_password: '',
    clear_encryption: false,
    schedule_cron_hour: c.schedule_cron_hour,
    schedule_cron_minute: c.schedule_cron_minute,
    retention_count: c.retention_count,
    tg_enabled: c.tg_enabled,
    tg_chat_id: c.tg_chat_id,
    tg_bot_token: '',
    clear_tg_token: false,
    sftp_enabled: c.sftp_enabled,
    sftp_host: c.sftp_host,
    sftp_port: c.sftp_port,
    sftp_username: c.sftp_username,
    sftp_password: '',
    clear_sftp_password: false,
    sftp_path: c.sftp_path,
  }
}

const set = (form, setForm, key, val) => setForm({ ...form, [key]: val })

function Section({ title, icon, subtitle, children }) {
  return (
    <div style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
        <span style={{ color: 'var(--accent)' }}>{icon}</span>
        <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text2)' }}>{title}</span>
        <div style={{ flex: 1 }} />
        {subtitle}
      </div>
      {children}
    </div>
  )
}

// ── Runs history ─────────────────────────────────────────────────────────

function RunsCard({ runs, isLoading, onDelete }) {
  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <History size={18} style={{ color: 'var(--accent)' }} />
        <h2 style={{ fontSize: 15, fontWeight: 700 }}>Історія</h2>
        <span style={{ fontSize: 12, color: 'var(--text3)' }}>{runs.length}</span>
      </div>
      {isLoading ? <Spinner /> : runs.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>Ще не було бекапів</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {runs.map(r => <RunRow key={r.id} run={r} onDelete={() => onDelete(r.id)} />)}
        </div>
      )}
    </div>
  )
}

function RunRow({ run, onDelete }) {
  const okIcon = run.status === 'ok'
    ? <CheckCircle2 size={14} style={{ color: 'var(--green)' }} />
    : run.status === 'error'
      ? <AlertTriangle size={14} style={{ color: 'var(--red)' }} />
      : <Clock size={14} style={{ color: 'var(--yellow)' }} />

  const totalItems = run.counts ? Object.values(run.counts).reduce((s, n) => s + n, 0) : null

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px',
    }}>
      {okIcon}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {run.filename || `run #${run.id}`}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text3)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span>{run.started_at ? new Date(run.started_at).toLocaleString('uk-UA') : '—'}</span>
          {run.triggered_by && <span>· {run.triggered_by}</span>}
          {run.trigger && <span>· {run.trigger}</span>}
          {run.size_bytes != null && <span>· {(run.size_bytes / 1024).toFixed(1)} KB</span>}
          {totalItems != null && <span>· {totalItems} записів</span>}
          {run.error && <span style={{ color: 'var(--red)' }}>· {run.error}</span>}
        </div>
      </div>
      {run.destinations && <Badge color="default">{run.destinations}</Badge>}
      <Btn size="sm" variant="danger" onClick={onDelete}><Trash2 size={11} /></Btn>
    </div>
  )
}

// ── Restore modal ────────────────────────────────────────────────────────

function RestoreModal({ open, onClose }) {
  const qc = useQueryClient()
  const [source, setSource] = useState('file') // 'file' | 'sftp'
  const [file, setFile] = useState(null)
  const [sftpFile, setSftpFile] = useState(null) // selected SFTP filename
  const [password, setPassword] = useState('')
  const [preview, setPreview] = useState(null)
  const [mode, setMode] = useState('merge')
  const [loading, setLoading] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [sftpList, setSftpList] = useState(null)
  const [sftpLoading, setSftpLoading] = useState(false)
  const [sftpError, setSftpError] = useState(null)

  useEffect(() => {
    if (!open) return
    setSource('file'); setFile(null); setSftpFile(null); setPassword('')
    setPreview(null); setMode('merge'); setSftpList(null); setSftpError(null)
  }, [open])

  async function loadSftpList() {
    setSftpLoading(true); setSftpError(null)
    try {
      const r = await listSftpBackups()
      setSftpList(r.data)
    } catch (e) {
      setSftpError(e.response?.data?.detail || e.message || 'Помилка SFTP')
    } finally { setSftpLoading(false) }
  }

  // Auto-load list when switching to SFTP tab
  useEffect(() => {
    if (open && source === 'sftp' && !sftpList && !sftpLoading) loadSftpList()
    // eslint-disable-next-line
  }, [open, source])

  async function doPreview() {
    setLoading(true)
    try {
      if (source === 'file') {
        if (!file) return
        const r = await previewBackupRestore(file, password)
        setPreview(r.data.manifest)
      } else {
        if (!sftpFile) return
        const r = await previewSftpBackup(sftpFile, password)
        setPreview(r.data.manifest)
      }
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Помилка читання архіву')
    } finally { setLoading(false) }
  }

  async function doRestore() {
    if (mode === 'replace' && !window.confirm('УВАГА: режим "replace" видалить ВСЕ існуюче і замінить даними з архіву. Точно продовжити?')) return
    setRestoring(true)
    try {
      let r
      if (source === 'file') r = await doBackupRestore(file, password, mode)
      else                    r = await restoreFromSftp(sftpFile, password, mode)
      const stats = r.data.stats || {}
      const total = Object.values(stats).reduce((s, x) => s + (x.inserted || 0) + (x.updated || 0), 0)
      toast.success(`Відновлено: ${total} записів`)
      qc.invalidateQueries()
      onClose()
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Помилка відновлення')
    } finally { setRestoring(false) }
  }

  const canPreview = source === 'file' ? !!file : !!sftpFile

  return (
    <Modal open={open} onClose={onClose} title="Відновлення з бекапу" width={620}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Source switcher */}
        <div style={{ display: 'flex', gap: 4, background: 'var(--bg3)', borderRadius: 8, padding: 3 }}>
          <SourceTab active={source === 'file'} onClick={() => { setSource('file'); setPreview(null) }} icon={<FileUp size={13} />}>
            З файлу
          </SourceTab>
          <SourceTab active={source === 'sftp'} onClick={() => { setSource('sftp'); setPreview(null) }} icon={<Server size={13} />}>
            З SFTP-сервера
          </SourceTab>
        </div>

        {source === 'file' ? (
          <Field label=".zip файл бекапу">
            <input type="file" accept=".zip" onChange={e => { setFile(e.target.files?.[0] || null); setPreview(null) }} />
          </Field>
        ) : (
          <SftpPicker
            data={sftpList} loading={sftpLoading} error={sftpError}
            selected={sftpFile} onSelect={(name) => { setSftpFile(name); setPreview(null) }}
            onRefresh={loadSftpList}
          />
        )}

        <Field label="Пароль (якщо архів зашифрований)">
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} />
        </Field>

        {!preview ? (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn variant="ghost" onClick={onClose}>Скасувати</Btn>
            <Btn loading={loading} disabled={!canPreview} onClick={doPreview}>
              <ArrowDownToLine size={13} /> Перевірити архів
            </Btn>
          </div>
        ) : (
          <>
            <div style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, fontSize: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Превʼю</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, color: 'var(--text2)' }}>
                <span>Інстанс: <b>{preview.instance}</b></span>
                <span>Створено: {preview.created_at}</span>
                <span>Шифрування: {preview.encrypted ? 'AES-256' : 'plain'}</span>
                <span>Файлів у архіві: {preview.total_files}</span>
              </div>
              <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 4 }}>
                {Object.entries(preview.counts || {}).map(([k, v]) => (
                  <div key={k} style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text3)' }}>
                    {k}: <span style={{ color: 'var(--text)' }}>{v}</span>
                  </div>
                ))}
              </div>
            </div>

            <Field label="Режим">
              <select value={mode} onChange={e => setMode(e.target.value)}>
                <option value="merge">Merge — upsert по ID (безпечно)</option>
                <option value="replace">Replace — видалити все і замінити (НЕБЕЗПЕЧНО)</option>
              </select>
            </Field>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn variant="ghost" onClick={() => setPreview(null)}>Назад</Btn>
              <Btn variant={mode === 'replace' ? 'danger' : 'primary'} loading={restoring} onClick={doRestore}>
                <Upload size={13} /> Відновити
              </Btn>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

function SourceTab({ active, onClick, icon, children }) {
  return (
    <button onClick={onClick} style={{
      flex: 1, padding: '8px 12px', borderRadius: 6, border: 'none',
      background: active ? 'var(--bg2)' : 'transparent',
      color: active ? 'var(--text)' : 'var(--text3)',
      fontSize: 12, fontWeight: 600, cursor: 'pointer',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
      boxShadow: active ? '0 1px 2px rgba(0,0,0,0.2)' : 'none',
      transition: 'all 0.15s',
    }}>
      {icon} {children}
    </button>
  )
}

function SftpPicker({ data, loading, error, selected, onSelect, onRefresh }) {
  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}><Spinner /></div>
  if (error) return (
    <div style={{
      background: 'var(--red-dim)', border: '1px solid rgba(255,69,58,0.3)', borderRadius: 8,
      padding: 14, fontSize: 12, color: 'var(--red)', display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <AlertTriangle size={14} /> {error}
      </div>
      <Btn size="sm" variant="ghost" onClick={onRefresh}><RefreshCw size={12} /> Повторити</Btn>
    </div>
  )
  if (!data) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text3)' }}>
        <FolderDown size={12} />
        <span style={{ fontFamily: 'var(--mono)' }}>{data.path}</span>
        <span>·</span>
        <span>{data.files.length} файлів</span>
        <button onClick={onRefresh} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 2 }} title="Оновити">
          <RefreshCw size={12} />
        </button>
      </div>
      {data.files.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 12, background: 'var(--bg3)', borderRadius: 8 }}>
          У вказаному каталозі немає файлів dm-backup-*.zip
        </div>
      ) : (
        <div style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
          {data.files.map(f => {
            const active = selected === f.name
            return (
              <div key={f.name} onClick={() => onSelect(f.name)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 12px', borderRadius: 8, cursor: 'pointer',
                  background: active ? 'var(--accent-dim)' : 'var(--bg3)',
                  border: '1px solid', borderColor: active ? 'rgba(10,132,255,0.4)' : 'var(--border)',
                }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.borderColor = 'var(--border2)' }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.borderColor = 'var(--border)' }}
              >
                <Archive size={13} style={{ color: active ? 'var(--accent)' : 'var(--text3)' }} />
                <span style={{ flex: 1, fontFamily: 'var(--mono)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {f.name}
                </span>
                {f.size != null && (
                  <span style={{ fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' }}>
                    {(f.size / 1024).toFixed(1)} KB
                  </span>
                )}
                {f.mtime != null && (
                  <span style={{ fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' }}>
                    {new Date(f.mtime * 1000).toLocaleDateString('uk-UA')}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
