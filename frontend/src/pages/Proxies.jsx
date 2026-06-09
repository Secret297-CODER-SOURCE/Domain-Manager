import { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  Plus, Trash2, RefreshCw, Upload, Copy, Search, Zap, X,
  Network, CheckCircle2, AlertTriangle, Edit3, Globe,
} from 'lucide-react'

import {
  getProxies, createProxy, updateProxy, deleteProxy,
  bulkDeleteProxies, importProxies, testProxy, bulkTestProxies,
} from '../api/client'
import { Btn, Modal, Spinner, Field, Badge, Table } from '../components/ui/index'
import { useDeleteOtp } from '../context/DeleteOtpContext'

export default function ProxiesPage() {
  const qc = useQueryClient()
  const { gateDelete } = useDeleteOtp()
  const [selected, setSelected] = useState([])
  const [search, setSearch] = useState('')
  const [filterType, setFilterType] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [addModal, setAddModal] = useState(false)
  const [editProxy, setEditProxy] = useState(null)
  const [importModal, setImportModal] = useState(false)
  const [testingId, setTestingId] = useState(null)
  const [bulkTesting, setBulkTesting] = useState(false)

  const { data: proxies = [], isLoading } = useQuery({
    queryKey: ['proxies'],
    queryFn: () => getProxies().then(r => r.data),
    refetchOnWindowFocus: false,
  })

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return proxies.filter(p => {
      if (filterType && p.type !== filterType) return false
      if (filterStatus === 'ok' && p.last_check_ok !== true) return false
      if (filterStatus === 'fail' && p.last_check_ok !== false) return false
      if (filterStatus === 'unchecked' && p.last_check_at) return false
      if (q) {
        const haystack = [p.label, p.host, p.country, p.tags, p.notes, p.username, p.last_check_ip].filter(Boolean).join(' ').toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
  }, [proxies, search, filterType, filterStatus])

  const delMut = useMutation({
    mutationFn: deleteProxy,
    onSuccess: () => { toast.success('Видалено'); qc.invalidateQueries(['proxies']) },
  })

  async function testOne(p) {
    setTestingId(p.id)
    try {
      await testProxy(p.id)
      qc.invalidateQueries(['proxies'])
    } catch { toast.error('Помилка тесту') }
    finally { setTestingId(null) }
  }

  async function testSelected() {
    if (selected.length === 0) return
    setBulkTesting(true)
    try {
      const r = await bulkTestProxies(selected)
      const { ok, fail } = r.data
      toast.success(`Готово: ${ok} ✓ / ${fail} ✗`)
      qc.invalidateQueries(['proxies'])
    } catch { toast.error('Помилка масового тесту') }
    finally { setBulkTesting(false) }
  }

  async function deleteSelected() {
    if (selected.length === 0) return
    try {
      await gateDelete(() => bulkDeleteProxies(selected))
      toast.success(`Видалено ${selected.length}`)
      setSelected([])
      qc.invalidateQueries(['proxies'])
    } catch {}
  }

  function copySelected() {
    const lines = proxies.filter(p => selected.includes(p.id)).map(formatProxyLine)
    navigator.clipboard.writeText(lines.join('\n'))
    toast.success(`Скопійовано ${lines.length}`)
  }

  // Stats
  const stats = useMemo(() => ({
    total: proxies.length,
    ok: proxies.filter(p => p.last_check_ok === true).length,
    fail: proxies.filter(p => p.last_check_ok === false).length,
    unchecked: proxies.filter(p => !p.last_check_at).length,
  }), [proxies])

  const columns = [
    {
      key: 'label', label: 'Назва',
      render: (v, p) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
          <span style={{ fontWeight: 600 }}>{v || <span style={{ color: 'var(--text3)' }}>—</span>}</span>
          {p.tags && (
            <span style={{ fontSize: 10, color: 'var(--text3)' }}>{p.tags}</span>
          )}
        </div>
      ),
    },
    { key: 'type', label: 'Тип', render: v => <Badge color={v === 'socks5' ? 'blue' : 'default'}>{v.toUpperCase()}</Badge> },
    {
      key: 'host', label: 'Адреса',
      render: (v, p) => (
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)' }}>
          {v}:{p.port}
        </span>
      ),
    },
    {
      key: 'username', label: 'Auth',
      render: (v) => v
        ? <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)' }}>{v}:•••</span>
        : <span style={{ color: 'var(--text3)' }}>—</span>,
    },
    {
      key: 'country', label: 'Гео',
      render: v => v ? <Badge color="default">{v.toUpperCase()}</Badge> : <span style={{ color: 'var(--text3)' }}>—</span>,
    },
    {
      key: 'last_check_ok', label: 'Статус',
      render: (_, p) => <StatusBadge p={p} />,
    },
    {
      key: 'last_check_latency_ms', label: 'Latency',
      render: (v, p) => p.last_check_at
        ? <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: latencyColor(v) }}>{v}ms</span>
        : <span style={{ color: 'var(--text3)', fontSize: 11 }}>—</span>,
    },
    {
      key: 'id', label: '', render: (id, p) => (
        <div style={{ display: 'flex', gap: 4 }} onClick={e => e.stopPropagation()}>
          <Btn size="sm" variant="ghost" loading={testingId === id} onClick={() => testOne(p)} title="Тестувати">
            <Zap size={11} />
          </Btn>
          <Btn size="sm" variant="ghost" onClick={() => setEditProxy(p)} title="Редагувати">
            <Edit3 size={11} />
          </Btn>
          <Btn size="sm" variant="ghost" onClick={() => { navigator.clipboard.writeText(formatProxyLine(p)); toast.success('Скопійовано') }} title="Копіювати">
            <Copy size={11} />
          </Btn>
          <Btn size="sm" variant="danger" onClick={() => gateDelete(() => delMut.mutateAsync(id)).catch(() => {})}>
            <Trash2 size={11} />
          </Btn>
        </div>
      ),
    },
  ]

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontWeight: 800, fontSize: 22, display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <Network size={22} style={{ color: 'var(--accent)' }} /> Проксі
          </h1>
          <p style={{ color: 'var(--text3)', fontSize: 12, marginTop: 2 }}>
            HTTP/SOCKS5 проксі. Тест через httpx → ipify, перевіряється latency і вихідний IP.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn variant="ghost" onClick={() => setImportModal(true)}><Upload size={14} /> Імпорт списком</Btn>
          <Btn onClick={() => setAddModal(true)}><Plus size={14} /> Додати</Btn>
        </div>
      </div>

      {/* Stat strip */}
      <div style={{ display: 'flex', gap: 10 }}>
        <StatBox label="Всього" value={stats.total} color="var(--text)" />
        <StatBox label="Робочі" value={stats.ok} color="var(--green)" />
        <StatBox label="Биті" value={stats.fail} color="var(--red)" />
        <StatBox label="Не перевірені" value={stats.unchecked} color="var(--text3)" />
      </div>

      {/* Filters */}
      <div style={{
        display: 'flex', gap: 10, flexWrap: 'wrap',
        background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: 12,
      }}>
        <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 180 }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text3)', pointerEvents: 'none' }} />
          <input placeholder="Пошук host / тег / IP…" value={search} onChange={e => setSearch(e.target.value)} style={{ paddingLeft: 30 }} />
        </div>
        <select value={filterType} onChange={e => setFilterType(e.target.value)} style={{ flex: '0 1 130px' }}>
          <option value="">Всі типи</option>
          <option value="http">HTTP</option>
          <option value="socks5">SOCKS5</option>
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ flex: '0 1 160px' }}>
          <option value="">Всі статуси</option>
          <option value="ok">Робочі</option>
          <option value="fail">Биті</option>
          <option value="unchecked">Не перевірені</option>
        </select>
        {(search || filterType || filterStatus) && (
          <Btn size="sm" variant="ghost" onClick={() => { setSearch(''); setFilterType(''); setFilterStatus('') }}>
            <X size={12} /> Очистити
          </Btn>
        )}
        {selected.length > 0 && (
          <>
            <div style={{ flex: 1 }} />
            <Btn size="sm" variant="ghost" onClick={copySelected}><Copy size={12} /> Копіювати ({selected.length})</Btn>
            <Btn size="sm" variant="success" loading={bulkTesting} onClick={testSelected}><Zap size={12} /> Тест ({selected.length})</Btn>
            <Btn size="sm" variant="danger" onClick={deleteSelected}><Trash2 size={12} /> Видалити ({selected.length})</Btn>
          </>
        )}
      </div>

      {/* Table */}
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'auto', flex: 1 }}>
        {isLoading
          ? <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spinner /></div>
          : <Table columns={columns} data={filtered} selected={selected} onSelect={setSelected} />
        }
      </div>

      <ProxyFormModal open={addModal} onClose={() => setAddModal(false)} onDone={() => qc.invalidateQueries(['proxies'])} />
      <ProxyFormModal open={!!editProxy} proxy={editProxy} onClose={() => setEditProxy(null)} onDone={() => qc.invalidateQueries(['proxies'])} />
      <ImportModal open={importModal} onClose={() => setImportModal(false)} onDone={() => qc.invalidateQueries(['proxies'])} />
    </div>
  )
}

function StatBox({ label, value, color }) {
  return (
    <div style={{
      flex: 1, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10,
      padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 2,
    }}>
      <span style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
      <span style={{ fontSize: 20, fontWeight: 700, color }}>{value}</span>
    </div>
  )
}

function StatusBadge({ p }) {
  if (!p.last_check_at) return <Badge color="default">—</Badge>
  if (p.last_check_ok) return <Badge color="green"><CheckCircle2 size={10} /> OK</Badge>
  return (
    <span title={p.last_check_error || ''}>
      <Badge color="red"><AlertTriangle size={10} /> Fail</Badge>
    </span>
  )
}

function latencyColor(ms) {
  if (ms == null) return 'var(--text3)'
  if (ms < 300) return 'var(--green)'
  if (ms < 1000) return 'var(--yellow)'
  return 'var(--red)'
}

function formatProxyLine(p) {
  const scheme = p.type === 'socks5' ? 'socks5' : 'http'
  if (p.username) return `${scheme}://${p.username}:${p.password || ''}@${p.host}:${p.port}`
  return `${scheme}://${p.host}:${p.port}`
}

// ── Forms ───────────────────────────────────────────────────────────────

function ProxyFormModal({ open, proxy, onClose, onDone }) {
  const isEdit = !!proxy
  const [form, setForm] = useState(blankForm())
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open) {
      setForm(proxy ? {
        label: proxy.label || '', type: proxy.type, host: proxy.host, port: String(proxy.port),
        username: proxy.username || '', password: proxy.password || '',
        country: proxy.country || '', tags: proxy.tags || '', notes: proxy.notes || '',
        is_active: proxy.is_active,
      } : blankForm())
    }
  }, [open, proxy?.id])

  async function submit() {
    if (!form.host || !form.port) return toast.error('Host і port обов\'язкові')
    setLoading(true)
    try {
      const payload = { ...form, port: parseInt(form.port) }
      if (isEdit) await updateProxy(proxy.id, payload)
      else await createProxy(payload)
      toast.success(isEdit ? 'Оновлено' : 'Додано')
      onDone(); onClose()
    } catch (e) {
      toast.error('Помилка: ' + (e.response?.data?.detail || e.message))
    } finally { setLoading(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Редагувати проксі' : 'Новий проксі'} width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Назва (опційно)">
          <input autoFocus value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} placeholder="us-east-residential-1" />
        </Field>
        <div style={{ display: 'flex', gap: 10 }}>
          <Field label="Тип">
            <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
              <option value="http">HTTP</option>
              <option value="socks5">SOCKS5</option>
            </select>
          </Field>
          <Field label="Гео (опц.)">
            <input value={form.country} onChange={e => setForm(f => ({ ...f, country: e.target.value }))} placeholder="UA / US / DE" maxLength={4} />
          </Field>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 2 }}>
            <Field label="Host">
              <input value={form.host} onChange={e => setForm(f => ({ ...f, host: e.target.value }))} placeholder="1.2.3.4 або gw.smartproxy.com" />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Port">
              <input type="number" value={form.port} onChange={e => setForm(f => ({ ...f, port: e.target.value }))} placeholder="8080" />
            </Field>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <Field label="Username (опц.)">
            <input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} />
          </Field>
          <Field label="Password (опц.)">
            <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
          </Field>
        </div>
        <Field label="Теги (через кому)">
          <input value={form.tags} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))} placeholder="warmup, scraping, mobile" />
        </Field>
        <Field label="Нотатки">
          <textarea rows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={{ resize: 'vertical' }} />
        </Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>Скасувати</Btn>
          <Btn loading={loading} onClick={submit}>{isEdit ? 'Зберегти' : 'Додати'}</Btn>
        </div>
      </div>
    </Modal>
  )
}

function blankForm() {
  return { label: '', type: 'http', host: '', port: '', username: '', password: '', country: '', tags: '', notes: '', is_active: true }
}

function ImportModal({ open, onClose, onDone }) {
  const [text, setText] = useState('')
  const [defaultType, setDefaultType] = useState('http')
  const [tags, setTags] = useState('')
  const [loading, setLoading] = useState(false)
  useEffect(() => { if (open) { setText(''); setTags(''); setDefaultType('http') } }, [open])

  async function submit() {
    setLoading(true)
    try {
      const r = await importProxies({ text, default_type: defaultType, tags: tags || null })
      toast.success(`Додано ${r.data.created}, пропущено ${r.data.skipped}`)
      onDone(); onClose()
    } catch { toast.error('Помилка імпорту') }
    finally { setLoading(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title="Імпорт проксі" width={560}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Список (по одному на рядок)">
          <textarea rows={10} value={text} onChange={e => setText(e.target.value)}
            placeholder={`host:port\nhost:port:user:pass\nuser:pass@host:port\nhttp://user:pass@host:port\nsocks5://host:port`}
            style={{ resize: 'vertical', fontFamily: 'var(--mono)', fontSize: 12 }} />
        </Field>
        <div style={{ display: 'flex', gap: 10 }}>
          <Field label="Тип за замовчуванням">
            <select value={defaultType} onChange={e => setDefaultType(e.target.value)}>
              <option value="http">HTTP</option>
              <option value="socks5">SOCKS5</option>
            </select>
          </Field>
          <Field label="Теги (опц.)">
            <input value={tags} onChange={e => setTags(e.target.value)} placeholder="scraping, batch-jun" />
          </Field>
        </div>
        <p style={{ fontSize: 11, color: 'var(--text3)', margin: 0 }}>
          Дублікати (host:port) пропускаються. Рядки з URI-схемою (http://, socks5://) перевизначають тип за замовчуванням.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>Скасувати</Btn>
          <Btn loading={loading} disabled={!text.trim()} onClick={submit}><Upload size={14} /> Імпортувати</Btn>
        </div>
      </div>
    </Modal>
  )
}
