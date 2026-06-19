import { useState, useEffect, useMemo, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  Plus, Trash2, Edit3, Copy, Eye, EyeOff, Search, X,
  User as UserIcon, Server, Globe, Package, Box, ShoppingBag,
  Calendar, AlertTriangle, CheckCircle2, ExternalLink, Clock,
  LayoutGrid, Tag, FileText, Wallet, MapPin,
} from 'lucide-react'

import {
  getPurchases, createPurchase, updatePurchase, deletePurchase,
} from '../api/client'
import { Btn, Modal, Spinner, Field, Badge } from '../components/ui/index'
import { useDeleteOtp } from '../context/DeleteOtpContext'

const CATEGORIES = [
  { key: 'account',  label: 'Акаунти',   single: 'Акаунт',  icon: UserIcon, color: 'var(--accent)' },
  { key: 'server',   label: 'Сервери',   single: 'Сервер',  icon: Server,   color: 'var(--green)' },
  { key: 'domain',   label: 'Домени',    single: 'Домен',   icon: Globe,    color: 'var(--yellow)' },
  { key: 'software', label: 'Софт',      single: 'Софт',    icon: Box,      color: '#bf5af2' },
  { key: 'other',    label: 'Інше',      single: 'Інше',    icon: Package,  color: 'var(--text2)' },
]
const CAT_MAP = Object.fromEntries(CATEGORIES.map(c => [c.key, c]))

// Proxies aren't in the Purchase model directly — but user thinks of them as a category.
// We treat tag "proxy" / category "other" with provider mention as proxy.
// For the overview we map purchases tagged as proxies to a virtual category.
const VIRTUAL_PROXY = { key: 'proxy', label: 'Проксі', single: 'Проксі', icon: ({ size }) => <Server size={size} />, color: '#ff9f0a' }

const STATUS = {
  active:    { label: 'Активна',     color: 'green',   icon: CheckCircle2 },
  expired:   { label: 'Прострочено', color: 'red',     icon: AlertTriangle },
  cancelled: { label: 'Скасовано',   color: 'default', icon: X },
}

const OPEN_TABS_KEY = 'dm.purchases.openTabs.v1'

// ── Page with tabs ───────────────────────────────────────────────────────

export default function PurchasesPage() {
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

  useEffect(() => {
    try { localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(tabs.map(t => ({ id: t.id })))) } catch {}
  }, [tabs])

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['purchases'],
    queryFn: () => getPurchases().then(r => r.data),
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

  // Prune deleted
  useEffect(() => {
    setTabs(prev => prev.filter(t => items.find(p => p.id === t.id)))
  }, [items])

  const tabMetas = tabs.map(t => ({ ...t, meta: items.find(p => p.id === t.id) })).filter(t => t.meta)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Tab bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4,
        padding: '8px 12px 0', background: 'var(--bg2)', borderBottom: '1px solid var(--border)',
        overflowX: 'auto', flexShrink: 0,
      }}>
        <TabPill
          icon={<LayoutGrid size={13} />} label="Всі закупки"
          active={active === 'list'} onClick={() => setActive('list')}
        />
        {tabMetas.map(t => {
          const cat = CAT_MAP[t.meta.category] || CAT_MAP.other
          return (
            <TabPill key={t.id}
              icon={<cat.icon size={13} />}
              label={t.meta.label}
              active={active === t.id}
              onClick={() => setActive(t.id)}
              onClose={() => closeTab(t.id)}
              color={cat.color}
            />
          )
        })}
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex' }}>
        <div style={{ display: active === 'list' ? 'flex' : 'none', flex: 1, minWidth: 0 }}>
          <PurchaseList items={items} isLoading={isLoading} onOpen={openTab} />
        </div>
        {tabMetas.map(t => (
          <div key={t.id} style={{ display: active === t.id ? 'flex' : 'none', flex: 1, minWidth: 0, flexDirection: 'column' }}>
            <PurchaseDetail item={t.meta} onClose={() => closeTab(t.id)} />
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
        cursor: 'pointer', flexShrink: 0, maxWidth: 240, fontSize: 12, fontWeight: 600,
        color: active ? 'var(--text)' : 'var(--text2)', marginBottom: -1, transition: 'background 0.12s',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--bg3)' }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
    >
      {icon}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>{label}</span>
      {onClose && (
        <button onClick={e => { e.stopPropagation(); onClose() }}
          style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 0, display: 'inline-flex' }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--red)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
        ><X size={13} /></button>
      )}
    </div>
  )
}

// ── List view (overview by category) ────────────────────────────────────

function PurchaseList({ items, isLoading, onOpen }) {
  const qc = useQueryClient()
  const { gateDelete } = useDeleteOtp()
  const [editing, setEditing] = useState(null)
  const [adding, setAdding] = useState(false)
  const [search, setSearch] = useState('')
  const [filterCat, setFilterCat] = useState('')
  const [filterStatus, setFilterStatus] = useState('')

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return items.filter(p => {
      if (filterCat && p.category !== filterCat) return false
      if (filterStatus && p.status !== filterStatus) return false
      if (q) {
        const hay = [p.label, p.provider, p.login, p.notes, p.tags, p.url].filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [items, search, filterCat, filterStatus])

  // Group filtered items by category for display
  const byCategory = useMemo(() => {
    const buckets = {}
    CATEGORIES.forEach(c => buckets[c.key] = [])
    filtered.forEach(p => {
      const key = CAT_MAP[p.category] ? p.category : 'other'
      buckets[key].push(p)
    })
    return buckets
  }, [filtered])

  const stats = useMemo(() => {
    const out = { total: items.length, byCat: {}, expired: 0, totalCost: {} }
    items.forEach(p => {
      out.byCat[p.category] = (out.byCat[p.category] || 0) + 1
      if (p.status === 'expired') out.expired++
      const amount = parseFloat(p.cost_amount)
      if (!isNaN(amount) && p.cost_currency) {
        out.totalCost[p.cost_currency] = (out.totalCost[p.cost_currency] || 0) + amount
      }
    })
    return out
  }, [items])

  const delMut = useMutation({
    mutationFn: deletePurchase,
    onSuccess: () => { toast.success('Видалено'); qc.invalidateQueries(['purchases']) },
  })

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, flex: 1, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontWeight: 800, fontSize: 22, display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <ShoppingBag size={22} style={{ color: 'var(--accent)' }} /> Закупки
          </h1>
          <p style={{ color: 'var(--text3)', fontSize: 12, marginTop: 2 }}>
            Що, де і за скільки купуєш — акаунти, сервери, домени, софт. Клік на картку відкриває її як вкладку.
          </p>
        </div>
        <Btn onClick={() => setAdding(true)}><Plus size={14} /> Нова закупка</Btn>
      </div>

      {/* Category stat tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
        <SummaryTile label="Всього" value={stats.total} color="var(--text)" icon={<ShoppingBag size={14} />} />
        {CATEGORIES.map(c => (
          <SummaryTile key={c.key} label={c.label} value={stats.byCat[c.key] || 0}
            color={c.color} icon={<c.icon size={14} />}
            highlight={filterCat === c.key}
            onClick={() => setFilterCat(filterCat === c.key ? '' : c.key)} />
        ))}
        {stats.expired > 0 && <SummaryTile label="Прострочено" value={stats.expired} color="var(--red)" icon={<AlertTriangle size={14} />} />}
      </div>

      {/* Total spending */}
      {Object.keys(stats.totalCost).length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, color: 'var(--text3)' }}>
          <Wallet size={13} /> <span>Загальні витрати:</span>
          {Object.entries(stats.totalCost).map(([cur, amt]) => (
            <Badge key={cur} color="default">{amt.toFixed(2)} {cur}</Badge>
          ))}
        </div>
      )}

      {/* Filters */}
      <div style={{
        display: 'flex', gap: 10, flexWrap: 'wrap',
        background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: 12, flexShrink: 0,
      }}>
        <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 180 }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text3)', pointerEvents: 'none' }} />
          <input placeholder="Пошук провайдер / логін / нотатка…" value={search} onChange={e => setSearch(e.target.value)} style={{ paddingLeft: 30 }} />
        </div>
        <select value={filterCat} onChange={e => setFilterCat(e.target.value)} style={{ flex: '0 1 150px' }}>
          <option value="">Всі категорії</option>
          {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ flex: '0 1 150px' }}>
          <option value="">Всі статуси</option>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        {(search || filterCat || filterStatus) && (
          <Btn size="sm" variant="ghost" onClick={() => { setSearch(''); setFilterCat(''); setFilterStatus('') }}>
            <X size={12} /> Очистити
          </Btn>
        )}
      </div>

      {/* Grouped grid */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18, paddingBottom: 16 }}>
        {isLoading ? <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spinner /></div>
          : filtered.length === 0 ? (
            <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14, padding: 48, textAlign: 'center', color: 'var(--text3)' }}>
              Немає закупок за поточними фільтрами
            </div>
          ) : CATEGORIES.map(cat => {
            const list = byCategory[cat.key]
            if (!list || list.length === 0) return null
            return (
              <div key={cat.key}>
                <CategoryHeader cat={cat} count={list.length} />
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
                  {list.map(p => (
                    <PurchaseCard key={p.id} item={p}
                      onOpen={() => onOpen(p.id)}
                      onEdit={() => setEditing(p)}
                      onDelete={() => gateDelete(() => delMut.mutateAsync(p.id)).catch(() => {})}
                    />
                  ))}
                </div>
              </div>
            )
          })
        }
      </div>

      <PurchaseFormModal open={adding || !!editing} item={editing} onClose={() => { setAdding(false); setEditing(null) }}
        onSaved={() => qc.invalidateQueries(['purchases'])} />
    </div>
  )
}

function SummaryTile({ label, value, color, icon, highlight, onClick }) {
  return (
    <div onClick={onClick}
      style={{
        background: 'var(--bg2)', border: '1px solid', borderColor: highlight ? color : 'var(--border)', borderRadius: 12,
        padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 4,
        cursor: onClick ? 'pointer' : 'default', transition: 'all 0.12s',
      }}
      onMouseEnter={e => { if (onClick) e.currentTarget.style.borderColor = highlight ? color : 'var(--border2)' }}
      onMouseLeave={e => { if (onClick) e.currentTarget.style.borderColor = highlight ? color : 'var(--border)' }}
    >
      <span style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span style={{ color }}>{icon}</span> {label}
      </span>
      <span style={{ fontSize: 22, fontWeight: 700, color }}>{value}</span>
    </div>
  )
}

function CategoryHeader({ cat, count }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
      <div style={{
        width: 26, height: 26, borderRadius: 7,
        background: `color-mix(in srgb, ${cat.color} 18%, transparent)`,
        color: cat.color, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <cat.icon size={14} />
      </div>
      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{cat.label}</span>
      <span style={{ fontSize: 11, color: 'var(--text3)' }}>{count}</span>
      <div style={{ flex: 1, borderTop: '1px solid var(--border)', marginLeft: 6 }} />
    </div>
  )
}

function PurchaseCard({ item, onOpen, onEdit, onDelete }) {
  const cat = CAT_MAP[item.category] || CAT_MAP.other
  const st = STATUS[item.status] || STATUS.active
  const StIcon = st.icon
  const daysLeft = item.expires_at ? Math.ceil((new Date(item.expires_at) - Date.now()) / 86400000) : null
  const expSoon = daysLeft != null && daysLeft >= 0 && daysLeft <= 14

  return (
    <div onClick={onOpen} style={{
      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12,
      padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
      cursor: 'pointer', transition: 'all 0.15s',
    }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border2)'; e.currentTarget.style.transform = 'translateY(-1px)' }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.transform = 'none' }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 8,
          background: `color-mix(in srgb, ${cat.color} 18%, transparent)`,
          color: cat.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <cat.icon size={17} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</div>
          {item.provider && <div style={{ fontSize: 11, color: 'var(--text3)' }}>{item.provider}</div>}
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

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', fontSize: 11 }}>
        <Badge color={st.color}><StIcon size={10} /> {st.label}</Badge>
        {item.cost_amount && <Badge color="default">{item.cost_amount} {item.cost_currency || ''}</Badge>}
        {item.expires_at && (
          <Badge color={daysLeft != null && daysLeft < 0 ? 'red' : expSoon ? 'yellow' : 'default'}>
            <Clock size={10} />
            {daysLeft != null && daysLeft < 0
              ? `Прострочено ${Math.abs(daysLeft)}д`
              : daysLeft != null ? `${daysLeft}д лишилось` : new Date(item.expires_at).toLocaleDateString('uk-UA')}
          </Badge>
        )}
        {item.tags && <span style={{ color: 'var(--text3)', fontSize: 10 }}>· {item.tags}</span>}
      </div>
    </div>
  )
}

// ── Detail view (tab content) ───────────────────────────────────────────

function PurchaseDetail({ item, onClose }) {
  const qc = useQueryClient()
  const { gateDelete } = useDeleteOtp()
  const [editing, setEditing] = useState(false)
  const [showPwd, setShowPwd] = useState(false)
  const cat = CAT_MAP[item.category] || CAT_MAP.other
  const st = STATUS[item.status] || STATUS.active
  const StIcon = st.icon

  const delMut = useMutation({
    mutationFn: () => deletePurchase(item.id),
    onSuccess: () => { toast.success('Видалено'); qc.invalidateQueries(['purchases']); onClose() },
  })

  function copy(text, label) {
    if (!text) return
    navigator.clipboard.writeText(text)
    toast.success(`${label} скопійовано`)
  }

  function copyAll() {
    const text = [
      `${item.label}`,
      item.provider && `Провайдер: ${item.provider}`,
      item.url && `URL: ${item.url}`,
      item.login && `Логін: ${item.login}`,
      item.password && `Пароль: ${item.password}`,
      item.cost_amount && `Вартість: ${item.cost_amount} ${item.cost_currency || ''}`,
      item.purchased_at && `Куплено: ${new Date(item.purchased_at).toLocaleDateString('uk-UA')}`,
      item.expires_at && `До: ${new Date(item.expires_at).toLocaleDateString('uk-UA')}`,
      item.tags && `Теги: ${item.tags}`,
      item.notes && `Нотатки:\n${item.notes}`,
    ].filter(Boolean).join('\n')
    navigator.clipboard.writeText(text)
    toast.success('Скопійовано')
  }

  const daysLeft = item.expires_at ? Math.ceil((new Date(item.expires_at) - Date.now()) / 86400000) : null

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Header */}
      <div style={{
        padding: '14px 24px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)',
        display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
      }}>
        <div style={{
          width: 40, height: 40, borderRadius: 10,
          background: `color-mix(in srgb, ${cat.color} 22%, transparent)`,
          color: cat.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <cat.icon size={19} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</div>
          <div style={{ fontSize: 11, color: 'var(--text3)' }}>
            {cat.single} {item.provider && `· ${item.provider}`}
          </div>
        </div>
        <Badge color={st.color}><StIcon size={10} /> {st.label}</Badge>
        <Btn size="sm" variant="ghost" onClick={copyAll}><Copy size={13} /> Все</Btn>
        <Btn size="sm" variant="ghost" onClick={() => setEditing(true)}><Edit3 size={13} /> Редагувати</Btn>
        <Btn size="sm" variant="danger" onClick={() => gateDelete(() => delMut.mutateAsync()).catch(() => {})}>
          <Trash2 size={13} />
        </Btn>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        <div style={{ maxWidth: 820, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Credentials */}
          {(item.login || item.password || item.url) && (
            <Section title="Доступи" icon={<UserIcon size={14} />} color={cat.color}>
              {item.url && (
                <DetailRow label="URL" value={item.url} mono
                  onCopy={() => copy(item.url, 'URL')}
                  extra={
                    <button onClick={() => window.open(item.url, '_blank')} title="Відкрити"
                      style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer' }}
                      onMouseEnter={e => e.currentTarget.style.color = 'var(--accent)'}
                      onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
                    ><ExternalLink size={13} /></button>
                  }
                />
              )}
              {item.login && <DetailRow label="Логін" value={item.login} mono onCopy={() => copy(item.login, 'Логін')} />}
              {item.password && (
                <DetailRow label="Пароль" mono value={showPwd ? item.password : '•'.repeat(Math.min(item.password.length, 16))}
                  onCopy={() => copy(item.password, 'Пароль')}
                  extra={
                    <button onClick={() => setShowPwd(s => !s)}
                      style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer' }}>
                      {showPwd ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  }
                />
              )}
            </Section>
          )}

          {/* Cost & dates */}
          <Section title="Вартість і дати" icon={<Wallet size={14} />} color="var(--green)">
            {item.cost_amount && <DetailRow label="Вартість" value={`${item.cost_amount} ${item.cost_currency || ''}`} mono onCopy={() => copy(item.cost_amount, 'Вартість')} />}
            {item.purchased_at && <DetailRow label="Куплено" value={new Date(item.purchased_at).toLocaleDateString('uk-UA')} />}
            {item.expires_at && (
              <DetailRow label="Закінчується"
                value={`${new Date(item.expires_at).toLocaleDateString('uk-UA')}${daysLeft != null ? (daysLeft < 0 ? ` (прострочено ${Math.abs(daysLeft)}д)` : ` (через ${daysLeft}д)`) : ''}`}
              />
            )}
            {!item.cost_amount && !item.purchased_at && !item.expires_at && (
              <span style={{ color: 'var(--text3)', fontSize: 12 }}>Дати не вказані</span>
            )}
          </Section>

          {/* Tags */}
          {item.tags && (
            <Section title="Теги" icon={<Tag size={14} />} color="var(--accent)">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {item.tags.split(',').map(t => t.trim()).filter(Boolean).map(t => (
                  <Badge key={t} color="default">{t}</Badge>
                ))}
              </div>
            </Section>
          )}

          {/* Notes */}
          {item.notes && (
            <Section title="Нотатки" icon={<FileText size={14} />} color="#ff9f0a">
              <div style={{
                background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8,
                padding: 12, fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.55,
              }}>{item.notes}</div>
            </Section>
          )}

          {/* Meta footer */}
          <div style={{ fontSize: 11, color: 'var(--text3)', display: 'flex', gap: 12, flexWrap: 'wrap', padding: '8px 4px' }}>
            <span>Створено: {new Date(item.created_at).toLocaleString('uk-UA')}</span>
            {item.updated_at && <span>· Оновлено: {new Date(item.updated_at).toLocaleString('uk-UA')}</span>}
            <span>· ID: {item.id}</span>
          </div>
        </div>
      </div>

      <PurchaseFormModal open={editing} item={item} onClose={() => setEditing(false)}
        onSaved={() => qc.invalidateQueries(['purchases'])} />
    </div>
  )
}

function Section({ title, icon, color, children }) {
  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ color }}>{icon}</span>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text2)' }}>{title}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {children}
      </div>
    </div>
  )
}

function DetailRow({ label, value, mono, onCopy, extra }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', minWidth: 100 }}>{label}</span>
      <div style={{
        flex: 1, background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8,
        padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ flex: 1, fontFamily: mono ? 'var(--mono)' : 'var(--font)', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {value}
        </span>
        {extra}
        {onCopy && (
          <button onClick={onCopy} title="Копіювати"
            style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer' }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--accent)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
          ><Copy size={12} /></button>
        )}
      </div>
    </div>
  )
}

// ── Add/edit form modal ─────────────────────────────────────────────────

function PurchaseFormModal({ open, item, onClose, onSaved }) {
  const [form, setForm] = useState(blank())
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setForm(item ? fromItem(item) : blank())
  }, [open, item?.id])

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  async function submit() {
    if (!form.label.trim()) return toast.error('Назва обовʼязкова')
    setLoading(true)
    try {
      const payload = {
        ...form,
        purchased_at: form.purchased_at || null,
        expires_at: form.expires_at || null,
      }
      if (item) await updatePurchase(item.id, payload)
      else await createPurchase(payload)
      toast.success(item ? 'Оновлено' : 'Додано')
      onSaved(); onClose()
    } catch (e) {
      toast.error('Помилка: ' + (e.response?.data?.detail || e.message))
    } finally { setLoading(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title={item ? 'Редагувати закупку' : 'Нова закупка'} width={560}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 10 }}>
          <Field label="Категорія">
            <select value={form.category} onChange={e => set('category', e.target.value)}>
              {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </Field>
          <Field label="Статус">
            <select value={form.status} onChange={e => set('status', e.target.value)}>
              {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Назва *">
          <input autoFocus value={form.label} onChange={e => set('label', e.target.value)} placeholder="Hetzner CCX13 #2" />
        </Field>
        <Field label="Провайдер / продавець">
          <input value={form.provider} onChange={e => set('provider', e.target.value)} placeholder="Hetzner / Namecheap / @seller" />
        </Field>
        <div style={{ display: 'flex', gap: 10 }}>
          <Field label="Логін">
            <input value={form.login} onChange={e => set('login', e.target.value)} />
          </Field>
          <Field label="Пароль">
            <input type="password" value={form.password} onChange={e => set('password', e.target.value)} />
          </Field>
        </div>
        <Field label="URL">
          <input value={form.url} onChange={e => set('url', e.target.value)} placeholder="https://" />
        </Field>
        <div style={{ display: 'flex', gap: 10 }}>
          <Field label="Вартість">
            <input value={form.cost_amount} onChange={e => set('cost_amount', e.target.value)} placeholder="12.99" />
          </Field>
          <Field label="Валюта">
            <select value={form.cost_currency} onChange={e => set('cost_currency', e.target.value)}>
              {['USD','EUR','UAH','PLN','GBP'].map(c => <option key={c}>{c}</option>)}
            </select>
          </Field>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <Field label="Куплено">
            <input type="date" value={form.purchased_at?.slice(0,10) || ''} onChange={e => set('purchased_at', e.target.value ? e.target.value + 'T00:00:00Z' : '')} />
          </Field>
          <Field label="Закінчується">
            <input type="date" value={form.expires_at?.slice(0,10) || ''} onChange={e => set('expires_at', e.target.value ? e.target.value + 'T00:00:00Z' : '')} />
          </Field>
        </div>
        <Field label="Теги (через кому)">
          <input value={form.tags} onChange={e => set('tags', e.target.value)} placeholder="prod, hetzner-de" />
        </Field>
        <Field label="Нотатки">
          <textarea rows={3} value={form.notes} onChange={e => set('notes', e.target.value)} style={{ resize: 'vertical' }} />
        </Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>Скасувати</Btn>
          <Btn loading={loading} onClick={submit}>{item ? 'Зберегти' : 'Додати'}</Btn>
        </div>
      </div>
    </Modal>
  )
}

function blank() {
  return {
    category: 'account', label: '', provider: '',
    login: '', password: '', url: '',
    cost_amount: '', cost_currency: 'USD',
    purchased_at: '', expires_at: '',
    status: 'active', tags: '', notes: '',
  }
}
function fromItem(p) {
  return {
    category: p.category, label: p.label, provider: p.provider || '',
    login: p.login || '', password: p.password || '', url: p.url || '',
    cost_amount: p.cost_amount || '', cost_currency: p.cost_currency || 'USD',
    purchased_at: p.purchased_at || '', expires_at: p.expires_at || '',
    status: p.status || 'active', tags: p.tags || '', notes: p.notes || '',
  }
}
