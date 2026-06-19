import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  Plus, Trash2, Edit3, ExternalLink, RefreshCw, Globe, Cloud, Server,
  ShieldCheck, Code, AlertTriangle, ShieldAlert, X, LayoutGrid, CheckCircle2,
  Network, Sparkles,
} from 'lucide-react'

import {
  getServicePresets, getServices, createService, updateService, deleteService,
  probeService, grantServiceProxy, getProxies,
} from '../api/client'
import { Btn, Modal, Spinner, Field, Badge } from '../components/ui/index'
import { useDeleteOtp } from '../context/DeleteOtpContext'
import { useWebmailStore } from '../store/webmail'

const ICONS = { Cloud, Globe, Server, ShieldCheck, Code, Network, Sparkles }

const OPEN_TABS_KEY = 'dm.services.openTabs.v1'

// ── Page with tabs ───────────────────────────────────────────────────────

export default function ServicesPage() {
  const [tabs, setTabs] = useState(() => {
    try {
      const raw = localStorage.getItem(OPEN_TABS_KEY)
      if (raw) {
        const p = JSON.parse(raw)
        if (Array.isArray(p)) return p
      }
    } catch {}
    return []
  })
  const [active, setActive] = useState('list')

  useEffect(() => {
    try { localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(tabs.map(t => ({ id: t.id })))) } catch {}
  }, [tabs])

  const { data: services = [], isLoading } = useQuery({
    queryKey: ['services'],
    queryFn: () => getServices().then(r => r.data),
  })

  const openTab = useCallback((id) => {
    setTabs(prev => prev.find(t => t.id === id) ? prev : [...prev, { id }])
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

  useEffect(() => {
    setTabs(prev => prev.filter(t => services.find(s => s.id === t.id)))
  }, [services])

  const tabMetas = tabs.map(t => ({ ...t, meta: services.find(s => s.id === t.id) })).filter(t => t.meta)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4,
        padding: '8px 12px 0', background: 'var(--bg2)', borderBottom: '1px solid var(--border)',
        overflowX: 'auto', flexShrink: 0,
      }}>
        <TabPill icon={<LayoutGrid size={13} />} label="Всі сервіси"
          active={active === 'list'} onClick={() => setActive('list')} />
        {tabMetas.map(t => {
          const Icon = ICONS[t.meta.icon] || Globe
          return (
            <TabPill key={t.id}
              icon={<Icon size={13} />}
              label={t.meta.label}
              active={active === t.id}
              onClick={() => setActive(t.id)}
              onClose={() => closeTab(t.id)}
              color={t.meta.color}
            />
          )
        })}
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex' }}>
        <div style={{ display: active === 'list' ? 'flex' : 'none', flex: 1, minWidth: 0 }}>
          <ServiceList services={services} isLoading={isLoading} onOpen={openTab} />
        </div>
        {tabMetas.map(t => (
          <div key={t.id} style={{ display: active === t.id ? 'flex' : 'none', flex: 1, minWidth: 0, flexDirection: 'column' }}>
            <ServiceFrame service={t.meta} onClose={() => closeTab(t.id)} />
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
        borderTop: '1px solid', borderTopColor: active ? (color || 'var(--accent)') : 'transparent',
        borderLeft: '1px solid', borderRight: '1px solid',
        borderLeftColor: active ? 'var(--border)' : 'transparent',
        borderRightColor: active ? 'var(--border)' : 'transparent',
        cursor: 'pointer', flexShrink: 0, maxWidth: 220, fontSize: 12, fontWeight: 600,
        color: active ? 'var(--text)' : 'var(--text2)', marginBottom: -1,
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--bg3)' }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
    >
      {icon}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>{label}</span>
      {onClose && (
        <button onClick={e => { e.stopPropagation(); onClose() }}
          style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 0 }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--red)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
        ><X size={13} /></button>
      )}
    </div>
  )
}

// ── List view ───────────────────────────────────────────────────────────

function ServiceList({ services, isLoading, onOpen }) {
  const qc = useQueryClient()
  const { gateDelete } = useDeleteOtp()
  const [editing, setEditing] = useState(null)
  const [adding, setAdding] = useState(false)
  const [showPresets, setShowPresets] = useState(false)

  const { data: presets = {} } = useQuery({
    queryKey: ['service-presets'],
    queryFn: () => getServicePresets().then(r => r.data),
    staleTime: Infinity,
  })

  const delMut = useMutation({
    mutationFn: deleteService,
    onSuccess: () => { toast.success('Сервіс видалено'); qc.invalidateQueries(['services']) },
  })

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, flex: 1, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontWeight: 800, fontSize: 22, display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <Network size={22} style={{ color: 'var(--accent)' }} /> Сервіси
          </h1>
          <p style={{ color: 'var(--text3)', fontSize: 12, marginTop: 2 }}>
            Cloudflare, реєстратори, хостинги — все інлайн через ваш проксі. Купуйте домени, керуйте DNS, працюйте з акаунтами не виходячи з платформи.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn variant="ghost" onClick={() => setShowPresets(s => !s)}>
            <Sparkles size={14} /> Швидкий старт
          </Btn>
          <Btn onClick={() => setAdding(true)}><Plus size={14} /> Свій URL</Btn>
        </div>
      </div>

      {showPresets && (
        <div style={{
          background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12,
          padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Готові пресети — клік додає у ваш список
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 }}>
            {Object.entries(presets).map(([k, p]) => {
              const Icon = ICONS[p.icon] || Globe
              const exists = services.find(s => s.url === p.url)
              return (
                <button key={k} disabled={exists}
                  onClick={async () => {
                    try {
                      await createService(p)
                      toast.success(`${p.label} додано`)
                      qc.invalidateQueries(['services'])
                    } catch (e) { toast.error('Помилка') }
                  }}
                  style={{
                    background: exists ? 'var(--bg3)' : 'var(--bg3)',
                    border: '1px solid var(--border)', borderRadius: 10,
                    padding: '10px 12px', cursor: exists ? 'default' : 'pointer',
                    display: 'flex', alignItems: 'center', gap: 10,
                    opacity: exists ? 0.5 : 1, transition: 'all 0.12s',
                    textAlign: 'left',
                  }}
                  onMouseEnter={e => { if (!exists) e.currentTarget.style.borderColor = p.color || 'var(--border2)' }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
                >
                  <div style={{
                    width: 28, height: 28, borderRadius: 7, flexShrink: 0,
                    background: `color-mix(in srgb, ${p.color} 18%, transparent)`,
                    color: p.color,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Icon size={14} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</div>
                    {exists && <div style={{ fontSize: 10, color: 'var(--text3)' }}>вже додано</div>}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14,
        flex: 1, overflowY: 'auto', padding: 8 }}>
        {isLoading ? <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spinner /></div>
          : services.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 64, color: 'var(--text3)', fontSize: 13 }}>
              <Network size={36} style={{ opacity: 0.4, marginBottom: 12 }} />
              <div>Немає підключених сервісів</div>
              <div style={{ fontSize: 11, marginTop: 6 }}>Натисніть «Швидкий старт» — додайте Cloudflare, реєстратор або хостинг одним кліком.</div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, padding: 8 }}>
              {services.map(s => (
                <ServiceCard key={s.id} service={s}
                  onOpen={() => onOpen(s.id)}
                  onEdit={() => setEditing(s)}
                  onDelete={() => gateDelete(() => delMut.mutateAsync(s.id)).catch(() => {})}
                />
              ))}
            </div>
          )}
      </div>

      <ServiceFormModal open={adding || !!editing} service={editing}
        onClose={() => { setAdding(false); setEditing(null) }}
        onSaved={() => qc.invalidateQueries(['services'])}
      />
    </div>
  )
}

function ServiceCard({ service, onOpen, onEdit, onDelete }) {
  const Icon = ICONS[service.icon] || Globe
  const color = service.color || 'var(--accent)'

  return (
    <div onClick={onOpen} style={{
      background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 12,
      padding: 14, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 10,
      transition: 'all 0.15s',
    }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = color; e.currentTarget.style.transform = 'translateY(-1px)' }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.transform = 'none' }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 8,
          background: `color-mix(in srgb, ${color} 18%, transparent)`, color,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <Icon size={17} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{service.label}</div>
          <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {service.url}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4 }} onClick={e => e.stopPropagation()}>
          <button onClick={onEdit} title="Редагувати"
            style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 4 }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--accent)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
          ><Edit3 size={13} /></button>
          <button onClick={onDelete} title="Видалити"
            style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 4 }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--red)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
          ><Trash2 size={13} /></button>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {service.proxy_label && <Badge color="blue">via {service.proxy_label}</Badge>}
        {service.embed_mode === 'popup' && <Badge color="yellow">popup</Badge>}
      </div>
    </div>
  )
}

// ── Edit/add modal ──────────────────────────────────────────────────────

function ServiceFormModal({ open, service, onClose, onSaved }) {
  const isEdit = !!service
  const [form, setForm] = useState(blank())
  const [loading, setLoading] = useState(false)

  const { data: proxies = [] } = useQuery({
    queryKey: ['proxies'], queryFn: () => getProxies().then(r => r.data),
    enabled: open, staleTime: 60000,
  })

  useEffect(() => {
    if (!open) return
    if (service) setForm({
      label: service.label, url: service.url, kind: service.kind,
      color: service.color || '', icon: service.icon || '',
      proxy_id: service.proxy_id || '', sort_order: service.sort_order,
      embed_mode: service.embed_mode, notes: service.notes || '',
    })
    else setForm(blank())
  }, [open, service?.id])

  async function submit() {
    if (!form.label.trim() || !form.url.trim()) return toast.error('Назва і URL обовʼязкові')
    setLoading(true)
    try {
      const payload = { ...form, proxy_id: form.proxy_id || null }
      if (isEdit) await updateService(service.id, payload)
      else await createService(payload)
      toast.success(isEdit ? 'Збережено' : 'Додано')
      onSaved(); onClose()
    } catch (e) {
      toast.error('Помилка: ' + (e.response?.data?.detail || e.message))
    } finally { setLoading(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Редагувати сервіс' : 'Новий сервіс'} width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Назва">
          <input autoFocus value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} placeholder="Cloudflare" />
        </Field>
        <Field label="URL">
          <input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
            placeholder="https://dash.cloudflare.com" style={{ fontFamily: 'var(--mono)' }} />
        </Field>
        <div style={{ display: 'flex', gap: 10 }}>
          <Field label="Іконка (Lucide)">
            <select value={form.icon} onChange={e => setForm(f => ({ ...f, icon: e.target.value }))}>
              <option value="">— Без іконки —</option>
              {Object.keys(ICONS).map(k => <option key={k} value={k}>{k}</option>)}
            </select>
          </Field>
          <Field label="Колір">
            <input type="color" value={form.color || '#0a84ff'}
              onChange={e => setForm(f => ({ ...f, color: e.target.value }))}
              style={{ height: 36, padding: 2 }} />
          </Field>
        </div>
        <Field label="Через проксі (опційно — для residential IP)">
          <select value={form.proxy_id} onChange={e => setForm(f => ({ ...f, proxy_id: e.target.value }))}>
            <option value="">— Без проксі (з IP сервера) —</option>
            {proxies.filter(p => p.is_active !== false).map(p => (
              <option key={p.id} value={p.id}>
                {(p.label || `${p.host}:${p.port}`)} · {p.type.toUpperCase()}
                {p.country ? ` · ${p.country.toUpperCase()}` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Спосіб вбудовування">
          <select value={form.embed_mode} onChange={e => setForm(f => ({ ...f, embed_mode: e.target.value }))}>
            <option value="inline">Inline iframe (рекомендовано)</option>
            <option value="popup">Окреме вікно (для Proton, складних 2FA)</option>
          </select>
        </Field>
        <Field label="Нотатки">
          <textarea rows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            style={{ resize: 'vertical' }} />
        </Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>Скасувати</Btn>
          <Btn loading={loading} onClick={submit}>{isEdit ? 'Зберегти' : 'Додати'}</Btn>
        </div>
      </div>
    </Modal>
  )
}

function blank() {
  return { label: '', url: '', kind: 'generic', color: '#0a84ff', icon: 'Globe',
           proxy_id: '', sort_order: 0, embed_mode: 'inline', notes: '' }
}

// ── Service frame (iframe with proxy, or popup) ──────────────────────────

function ServiceFrame({ service, onClose }) {
  const wm = useWebmailStore()
  const winIsOpen = wm.windows[`svc-${service.id}`] && !wm.windows[`svc-${service.id}`].win.closed
  const [state, setState] = useState('idle')   // idle | granting | ready | error
  const [error, setError] = useState(null)
  const [probe, setProbe] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [forcePopup, setForcePopup] = useState(false)
  const stuckTimerRef = useRef(null)
  const [stuck, setStuck] = useState(false)

  useEffect(() => {
    if (service.embed_mode === 'popup') {
      setState('idle')
      return
    }
    setState('granting'); setError(null); setStuck(false); setForcePopup(false)
    Promise.all([grantServiceProxy(service.id), probeService(service.id)])
      .then(([_g, pr]) => { setProbe(pr.data); setState('ready') })
      .catch(e => { setError(e.response?.data?.detail || 'Помилка'); setState('error') })
  }, [service.id, reloadKey])

  // If iframe is still in "ready" state but never actually rendered useful content (e.g. CF challenge loop),
  // give user a clear escape hatch after 20s.
  useEffect(() => {
    if (state !== 'ready') return
    if (stuckTimerRef.current) clearTimeout(stuckTimerRef.current)
    stuckTimerRef.current = setTimeout(() => setStuck(true), 20000)
    return () => { if (stuckTimerRef.current) clearTimeout(stuckTimerRef.current) }
  }, [state, reloadKey])

  // Auto-detect "this site really doesn't like iframes" from probe headers
  const xfo = (probe?.x_frame_options || '').toLowerCase()
  const csp = (probe?.csp_frame_ancestors || '').toLowerCase()
  const hardBlocked = xfo === 'deny' || (xfo === 'sameorigin' && state === 'ready' && stuck) ||
                      (csp && !csp.includes('*') && !csp.includes('localhost'))

  const iframeSrc = `/api/services/${service.id}/proxy/`

  function openInWindow() {
    const win = wm.open(`svc-${service.id}`, service.url)
    if (!win) toast.error('Браузер заблокував попап — дозвольте попапи')
    setForcePopup(true)
  }

  // Popup mode — either explicitly set, hard-blocked headers, or user forced after stuck
  const useWindowMode = service.embed_mode === 'popup' || forcePopup
  if (useWindowMode) {
    return <WindowOnlyPane service={service} winIsOpen={winIsOpen}
      onOpen={openInWindow} onFocus={() => wm.focus(`svc-${service.id}`)}
      onClose={() => wm.close(`svc-${service.id}`)}
    />
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      {/* Toolbar */}
      <div style={{
        padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)',
        display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{service.label}</div>
          <div style={{ fontSize: 11, color: 'var(--text3)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontFamily: 'var(--mono)' }}>{service.url}</span>
            {service.proxy_label && <Badge color="blue">via {service.proxy_label}</Badge>}
          </div>
        </div>
        <Btn size="sm" variant="ghost" onClick={() => setReloadKey(k => k + 1)}>
          <RefreshCw size={13} />
        </Btn>
        <Btn size="sm" variant="ghost" onClick={() => window.open(service.url, '_blank', 'noopener')}>
          <ExternalLink size={13} /> Open
        </Btn>
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', background: '#fff' }}>
        {state === 'granting' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, color: 'var(--text3)' }}>
            <Spinner /> <span style={{ fontSize: 12 }}>Підготовка проксі…</span>
          </div>
        )}
        {state === 'error' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, color: 'var(--text2)', padding: 32, textAlign: 'center' }}>
            <AlertTriangle size={28} style={{ color: 'var(--red)' }} />
            <div style={{ color: 'var(--red)' }}>{error}</div>
          </div>
        )}
        {state === 'ready' && (
          <>
            <iframe key={reloadKey} src={iframeSrc} title={service.label}
              style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
              allow="clipboard-read; clipboard-write; encrypted-media; geolocation; microphone; camera; payment"
              referrerPolicy="no-referrer-when-downgrade" />

            {/* "Stuck" overlay — appears if iframe doesn't finish loading useful content */}
            {(stuck || hardBlocked) && (
              <div style={{
                position: 'absolute', inset: 0,
                background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(4px)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, zIndex: 10,
              }}>
                <div style={{
                  background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14,
                  padding: 28, maxWidth: 520, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 14,
                }}>
                  <ShieldAlert size={36} style={{ color: 'var(--yellow)', margin: '0 auto' }} />
                  <div style={{ fontSize: 15, fontWeight: 700 }}>
                    {hardBlocked ? 'Сервіс не пускає у iframe' : 'Завантаження зависло'}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text3)', lineHeight: 1.6 }}>
                    {service.kind === 'cloudflare' || service.url.includes('cloudflare')
                      ? 'Cloudflare використовує власну anti-bot перевірку (Turnstile), яка не проходить через iframe-проксі. Відкрийте у окремому вікні — там нативна cookie-сесія, перевірка пройде нормально.'
                      : 'Сайт або шле X-Frame-Options/CSP, або має складний anti-bot захист. Окреме вікно — найнадійніший варіант, сесія залишиться відкритою доки відкрита платформа.'}
                  </div>
                  <Btn variant="primary" onClick={openInWindow}>
                    <ExternalLink size={14} /> Відкрити у вікні
                  </Btn>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                    <Btn size="sm" variant="ghost" onClick={() => { setStuck(false); setReloadKey(k => k + 1) }}>
                      <RefreshCw size={12} /> Спробувати ще раз
                    </Btn>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function WindowOnlyPane({ service, winIsOpen, onOpen, onFocus, onClose }) {
  const Icon = ICONS[service.icon] || Globe
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      <div style={{
        padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)',
        display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{service.label}</div>
          <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{service.url}</div>
        </div>
        <Badge color={winIsOpen ? 'green' : 'blue'}>{winIsOpen ? 'Активне вікно' : 'Готове'}</Badge>
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
        <div style={{
          maxWidth: 480, background: 'var(--bg2)', border: '1px solid var(--border)',
          borderRadius: 16, padding: 32, display: 'flex', flexDirection: 'column', gap: 18, textAlign: 'center', alignItems: 'center',
        }}>
          <div style={{
            width: 72, height: 72, borderRadius: 18,
            background: `color-mix(in srgb, ${service.color || 'var(--accent)'} 18%, transparent)`,
            color: service.color || 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            position: 'relative',
          }}>
            <Icon size={32} />
            {winIsOpen && (
              <span style={{
                position: 'absolute', top: -3, right: -3, width: 16, height: 16, borderRadius: '50%',
                background: 'var(--green)', border: '3px solid var(--bg2)',
              }} />
            )}
          </div>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>
              {winIsOpen ? `${service.label} працює у вікні` : `Відкрити ${service.label}`}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 6, lineHeight: 1.55, maxWidth: 380, margin: '6px auto 0' }}>
              {winIsOpen
                ? 'Вікно живе доки відкрита платформа — переключайтесь між вкладками без втрати сесії.'
                : 'Для цього сервісу потрібне окреме вікно (E2E / anti-bot / SSO). Натисніть нижче — відкриється повноцінне вікно браузера, сесія збережеться.'}
            </div>
          </div>
          {winIsOpen ? (
            <div style={{ display: 'flex', gap: 10, width: '100%' }}>
              <Btn variant="primary" style={{ flex: 1, justifyContent: 'center' }} onClick={onFocus}>
                <ExternalLink size={14} /> Сфокусувати
              </Btn>
              <Btn variant="ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={onClose}>
                <X size={13} /> Закрити
              </Btn>
            </div>
          ) : (
            <Btn variant="primary" onClick={onOpen} style={{ width: '100%', justifyContent: 'center' }}>
              <ExternalLink size={14} /> Відкрити у вікні
            </Btn>
          )}
        </div>
      </div>
    </div>
  )
}
