import { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { Plus, Trash2, Edit3, ExternalLink, RefreshCw, Activity, AlertTriangle, Settings as SettingsIcon, ShieldAlert, CheckCircle2 } from 'lucide-react'

import {
  getKumaInstances, createKumaInstance, updateKumaInstance, deleteKumaInstance, probeKumaInstance, grantKumaProxy,
} from '../api/client'
import { Btn, Modal, Spinner, Field, Badge } from '../components/ui/index'
// Spinner used in KumaFrame during probe
import { useDeleteOtp } from '../context/DeleteOtpContext'

const DEFAULT_COLORS = ['#0a84ff', '#30d158', '#ffd60a', '#ff453a', '#bf5af2', '#ff9f0a', '#64d2ff']

export default function KumaPage() {
  const qc = useQueryClient()
  const { gateDelete } = useDeleteOtp()
  const [active, setActive] = useState(null)
  const [editModal, setEditModal] = useState(null) // 'new' | instance
  const [reloadKey, setReloadKey] = useState(0)

  const { data: instances = [], isLoading } = useQuery({
    queryKey: ['kuma'],
    queryFn: () => getKumaInstances().then(r => r.data),
  })

  // Default-select first instance when list loads / active gets removed
  useEffect(() => {
    if (instances.length === 0) { setActive(null); return }
    if (!active || !instances.find(i => i.id === active.id)) {
      setActive(instances[0])
    }
  }, [instances, active])

  const delMut = useMutation({
    mutationFn: deleteKumaInstance,
    onSuccess: () => { toast.success('Видалено'); qc.invalidateQueries(['kuma']) },
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '16px 24px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0, background: 'var(--bg2)',
      }}>
        <div style={{
          width: 34, height: 34, borderRadius: 8, background: 'var(--accent-dim)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Activity size={18} style={{ color: 'var(--accent)' }} />
        </div>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontWeight: 800, fontSize: 17 }}>Uptime Kuma</h1>
          <div style={{ fontSize: 11, color: 'var(--text3)' }}>
            {instances.length} інстансів — {active ? active.url : 'оберіть інстанс'}
          </div>
        </div>
        {active && (
          <>
            <Btn size="sm" variant="ghost" onClick={() => setReloadKey(k => k + 1)} title="Перезавантажити iframe">
              <RefreshCw size={13} />
            </Btn>
            <Btn size="sm" variant="ghost" onClick={() => window.open(active.url, '_blank')} title="Відкрити у новій вкладці">
              <ExternalLink size={13} /> Open
            </Btn>
            <Btn size="sm" variant="ghost" onClick={() => setEditModal(active)}>
              <Edit3 size={13} /> Редагувати
            </Btn>
          </>
        )}
        <Btn size="sm" onClick={() => setEditModal('new')}><Plus size={13} /> Інстанс</Btn>
      </div>

      {/* Pills row — instances switcher */}
      {instances.length > 0 && (
        <div style={{
          padding: '10px 24px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)',
          display: 'flex', gap: 6, flexShrink: 0, overflowX: 'auto',
        }}>
          {instances.map((k, i) => {
            const color = k.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]
            const isActive = active?.id === k.id
            return (
              <button key={k.id} onClick={() => setActive(k)}
                onContextMenu={e => { e.preventDefault(); setEditModal(k) }}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                  padding: '7px 14px', borderRadius: 999, cursor: 'pointer',
                  border: '1px solid',
                  borderColor: isActive ? color : 'var(--border)',
                  background: isActive ? `color-mix(in srgb, ${color} 18%, transparent)` : 'var(--bg3)',
                  color: isActive ? color : 'var(--text2)',
                  fontWeight: 600, fontSize: 12,
                  transition: 'all 0.15s', whiteSpace: 'nowrap',
                }}
                title="ПКМ — редагувати"
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
                {k.name}
              </button>
            )
          })}
        </div>
      )}

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', background: '#0a0a0f' }}>
        {isLoading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}><Spinner /></div>
        ) : instances.length === 0 ? (
          <EmptyState onAdd={() => setEditModal('new')} />
        ) : active ? (
          <KumaFrame key={active.id + ':' + reloadKey} instance={active} />
        ) : null}
      </div>

      <EditModal modal={editModal} onClose={() => setEditModal(null)}
        onSaved={() => qc.invalidateQueries(['kuma'])}
        onDelete={(id) => gateDelete(() => delMut.mutateAsync(id)).then(() => setEditModal(null)).catch(() => {})}
      />
    </div>
  )
}

function EmptyState({ onAdd }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 14, color: 'var(--text3)',
    }}>
      <Activity size={48} style={{ opacity: 0.4 }} />
      <div style={{ fontSize: 14 }}>Ще немає Uptime Kuma інстансів</div>
      <Btn onClick={onAdd}><Plus size={14} /> Додати перший</Btn>
    </div>
  )
}

function KumaFrame({ instance }) {
  const [probe, setProbe] = useState(null)
  const [probing, setProbing] = useState(true)
  // 'direct' = iframe loads instance.url; 'proxy' = via backend at /api/kuma/{id}/proxy/...
  const [mode, setMode] = useState('direct')
  const [proxyPath, setProxyPath] = useState('/')
  const [enablingProxy, setEnablingProxy] = useState(false)

  useEffect(() => {
    setProbing(true); setProbe(null); setMode('direct')
    probeKumaInstance(instance.id)
      .then(r => setProbe(r.data))
      .catch(() => setProbe({ reachable: false, error: 'probe failed' }))
      .finally(() => setProbing(false))
  }, [instance.id])

  async function enableProxy() {
    setEnablingProxy(true)
    try {
      await grantKumaProxy(instance.id)
      // Derive path from instance.url (everything after origin)
      try {
        const u = new URL(instance.url)
        setProxyPath((u.pathname || '/') + (u.search || ''))
      } catch { setProxyPath('/') }
      setMode('proxy')
      toast.success('Запит йде через вбудований проксі')
    } catch (e) {
      toast.error('Не вдалось активувати проксі')
    } finally { setEnablingProxy(false) }
  }

  if (probing) {
    return (
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: 'var(--text3)' }}>
        <Spinner /> <span style={{ fontSize: 12 }}>Перевірка доступності {instance.url}…</span>
      </div>
    )
  }

  const xfo = (probe?.x_frame_options || '').toLowerCase()
  const csp = (probe?.csp_frame_ancestors || '').toLowerCase()
  const frameBlocked = (xfo.includes('deny') || xfo.includes('sameorigin'))
                     || (csp && csp !== '*' && !csp.includes('localhost'))
  const showFallback = !!probe && (!probe.reachable || frameBlocked)

  if (mode === 'proxy') {
    const proxyUrl = `/api/kuma/${instance.id}/proxy${proxyPath.startsWith('/') ? proxyPath : '/' + proxyPath}`
    return (
      <>
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, padding: '6px 12px', background: 'var(--bg2)', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--text3)', display: 'flex', alignItems: 'center', gap: 10, zIndex: 5 }}>
          <ShieldAlert size={11} style={{ color: 'var(--green)' }} />
          <span>Через вбудований проксі — X-Frame-Options знято, live-оновлення через WebSocket можуть не працювати</span>
          <Btn size="sm" variant="ghost" onClick={() => setMode('direct')} style={{ marginLeft: 'auto' }}>Прямо</Btn>
        </div>
        <iframe
          src={proxyUrl}
          title={instance.name}
          style={{ width: '100%', height: 'calc(100% - 30px)', marginTop: 30, border: 'none', background: '#fff' }}
        />
      </>
    )
  }

  if (showFallback) return <KumaDiagnostic instance={instance} probe={probe}
    canProxy={probe?.reachable}
    enablingProxy={enablingProxy}
    onEnableProxy={enableProxy}
    onRetry={() => {
      setProbing(true); setProbe(null)
      probeKumaInstance(instance.id).then(r => setProbe(r.data)).finally(() => setProbing(false))
    }}
  />

  return (
    <iframe
      src={instance.url}
      title={instance.name}
      style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
      referrerPolicy="no-referrer-when-downgrade"
    />
  )
}

function KumaDiagnostic({ instance, probe, onRetry, canProxy, enablingProxy, onEnableProxy }) {
  let title, hint
  if (!probe.reachable) {
    title = 'Хост недоступний'
    hint = probe.error || `Сервер не відповідає на ${instance.url}. Перевірте чи Uptime Kuma запущений і порт відкритий.`
  } else if ((probe.x_frame_options || '').toLowerCase().includes('deny')) {
    title = 'X-Frame-Options: DENY'
    hint = 'Kuma забороняє вмонтування. У docker-compose Kuma додайте env UPTIME_KUMA_DISABLE_FRAME_SAMEORIGIN=1 або налаштуйте reverse-proxy, що знімає заголовок.'
  } else if ((probe.x_frame_options || '').toLowerCase().includes('sameorigin')) {
    title = 'X-Frame-Options: SAMEORIGIN'
    hint = 'Kuma дозволяє вмонтування тільки зі свого домену. Поставте reverse-proxy (nginx/caddy) на тому ж домені або зніміть заголовок.'
  } else if (probe.csp_frame_ancestors) {
    title = 'CSP frame-ancestors блокує'
    hint = `Сервер шле frame-ancestors: ${probe.csp_frame_ancestors}. Налаштуйте сервер щоб дозволити поточний origin.`
  } else {
    title = 'Сторінка не завантажується'
    hint = 'Браузер не зміг відкрити iframe. Можливо, mixed content (https→http) або інша політика.'
  }

  const StatusIcon = probe.reachable ? ShieldAlert : AlertTriangle
  const statusColor = probe.reachable ? 'var(--yellow)' : 'var(--red)'

  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 16, color: 'var(--text2)',
      background: 'var(--bg)', padding: 32, textAlign: 'center',
    }}>
      <StatusIcon size={42} style={{ color: statusColor }} />
      <div>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4, maxWidth: 520, lineHeight: 1.5 }}>{hint}</div>
      </div>

      {/* Probe details */}
      <div style={{
        background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10,
        padding: 12, fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text3)',
        display: 'flex', flexDirection: 'column', gap: 3, minWidth: 360,
      }}>
        <div>URL: <span style={{ color: 'var(--text2)' }}>{probe.url}</span></div>
        <div>Reachable from server: {probe.reachable ? <span style={{ color: 'var(--green)' }}><CheckCircle2 size={10} style={{ verticalAlign: -1 }} /> yes ({probe.status})</span> : <span style={{ color: 'var(--red)' }}>no</span>}</div>
        {probe.x_frame_options && <div>X-Frame-Options: <span style={{ color: 'var(--yellow)' }}>{probe.x_frame_options}</span></div>}
        {probe.csp_frame_ancestors && <div>CSP frame-ancestors: <span style={{ color: 'var(--yellow)' }}>{probe.csp_frame_ancestors}</span></div>}
        {probe.error && <div>Error: <span style={{ color: 'var(--red)' }}>{probe.error}</span></div>}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
        <Btn variant="ghost" onClick={onRetry}><RefreshCw size={13} /> Повторити</Btn>
        {canProxy && onEnableProxy && (
          <Btn variant="success" loading={enablingProxy} onClick={onEnableProxy}>
            <ShieldAlert size={13} /> Завантажити через вбудований проксі
          </Btn>
        )}
        <Btn onClick={() => window.open(instance.url, '_blank')}>
          <ExternalLink size={14} /> Відкрити у новій вкладці
        </Btn>
      </div>
    </div>
  )
}

function EditModal({ modal, onClose, onSaved, onDelete }) {
  const isNew = modal === 'new'
  const inst = !isNew && modal ? modal : null
  const [form, setForm] = useState(blank())
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!modal) return
    if (isNew) setForm(blank())
    else setForm({
      name: inst.name, url: inst.url,
      color: inst.color || DEFAULT_COLORS[0],
      sort_order: inst.sort_order, notes: inst.notes || '',
    })
  }, [modal])

  async function submit() {
    if (!form.name.trim() || !form.url.trim()) return toast.error('Назва і URL обовʼязкові')
    setLoading(true)
    try {
      if (isNew) await createKumaInstance(form)
      else await updateKumaInstance(inst.id, form)
      toast.success(isNew ? 'Додано' : 'Збережено')
      onSaved(); onClose()
    } catch (e) {
      toast.error('Помилка: ' + (e.response?.data?.detail || e.message))
    } finally { setLoading(false) }
  }

  return (
    <Modal open={!!modal} onClose={onClose} title={isNew ? 'Новий Uptime Kuma' : 'Редагувати інстанс'} width={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Назва">
          <input autoFocus value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Prod monitor" />
        </Field>
        <Field label="URL (включаючи https://)">
          <input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} placeholder="https://kuma.example.com" />
        </Field>
        <Field label="Колір">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {DEFAULT_COLORS.map(c => (
              <button key={c} onClick={() => setForm(f => ({ ...f, color: c }))}
                style={{
                  width: 26, height: 26, borderRadius: '50%', background: c,
                  border: '2px solid', borderColor: form.color === c ? 'var(--text)' : 'transparent',
                  cursor: 'pointer',
                }} />
            ))}
          </div>
        </Field>
        <Field label="Порядок (менше = вище)">
          <input type="number" value={form.sort_order} onChange={e => setForm(f => ({ ...f, sort_order: +e.target.value || 0 }))} />
        </Field>
        <Field label="Нотатки">
          <textarea rows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={{ resize: 'vertical' }} />
        </Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
          {!isNew && <Btn variant="danger" onClick={() => onDelete(inst.id)}><Trash2 size={13} /> Видалити</Btn>}
          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            <Btn variant="ghost" onClick={onClose}>Скасувати</Btn>
            <Btn loading={loading} onClick={submit}>{isNew ? 'Додати' : 'Зберегти'}</Btn>
          </div>
        </div>
      </div>
    </Modal>
  )
}

function blank() { return { name: '', url: '', color: DEFAULT_COLORS[0], sort_order: 0, notes: '' } }
