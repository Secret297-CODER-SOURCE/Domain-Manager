import { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  Plus, Trash2, Edit3, Copy, Eye, EyeOff, Search, X,
  User as UserIcon, Server, Globe, Package, Box, ShoppingBag,
  Calendar, AlertTriangle, CheckCircle2, ExternalLink, Clock,
} from 'lucide-react'

import {
  getPurchases, createPurchase, updatePurchase, deletePurchase,
} from '../api/client'
import { Btn, Modal, Spinner, Field, Badge } from '../components/ui/index'
import { useDeleteOtp } from '../context/DeleteOtpContext'

const CATEGORIES = [
  { key: 'account',  label: 'Акаунт',   icon: UserIcon, color: 'var(--accent)' },
  { key: 'server',   label: 'Сервер',   icon: Server,   color: 'var(--green)' },
  { key: 'domain',   label: 'Домен',    icon: Globe,    color: 'var(--yellow)' },
  { key: 'software', label: 'Софт',     icon: Box,      color: '#bf5af2' },
  { key: 'other',    label: 'Інше',     icon: Package,  color: 'var(--text2)' },
]

const STATUS = {
  active:    { label: 'Активна',   color: 'green',  icon: CheckCircle2 },
  expired:   { label: 'Прострочено', color: 'red',  icon: AlertTriangle },
  cancelled: { label: 'Скасовано', color: 'default', icon: X },
}

export default function PurchasesPage() {
  const qc = useQueryClient()
  const { gateDelete } = useDeleteOtp()
  const [editing, setEditing] = useState(null)
  const [adding, setAdding] = useState(false)
  const [search, setSearch] = useState('')
  const [filterCat, setFilterCat] = useState('')
  const [filterStatus, setFilterStatus] = useState('')

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['purchases'],
    queryFn: () => getPurchases().then(r => r.data),
  })

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

  const stats = useMemo(() => {
    const out = { total: items.length, byCat: {}, byStatus: { active: 0, expired: 0, cancelled: 0 } }
    items.forEach(p => {
      out.byCat[p.category] = (out.byCat[p.category] || 0) + 1
      out.byStatus[p.status] = (out.byStatus[p.status] || 0) + 1
    })
    return out
  }, [items])

  const delMut = useMutation({
    mutationFn: deletePurchase,
    onSuccess: () => { toast.success('Видалено'); qc.invalidateQueries(['purchases']) },
  })

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, height: '100%', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontWeight: 800, fontSize: 22, display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <ShoppingBag size={22} style={{ color: 'var(--accent)' }} /> Закупки
          </h1>
          <p style={{ color: 'var(--text3)', fontSize: 12, marginTop: 2 }}>
            Облік куплених акаунтів, серверів, доменів і ПЗ. Дати, вартість, доступи.
          </p>
        </div>
        <Btn onClick={() => setAdding(true)}><Plus size={14} /> Нова закупка</Btn>
      </div>

      {/* Stats strip */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <StatCell label="Всього" value={stats.total} color="var(--text)" />
        {CATEGORIES.map(c => (
          <StatCell key={c.key} label={c.label} value={stats.byCat[c.key] || 0} color={c.color} icon={<c.icon size={13} />} />
        ))}
        <StatCell label="Прострочено" value={stats.byStatus.expired} color="var(--red)" />
      </div>

      {/* Filters */}
      <div style={{
        display: 'flex', gap: 10, flexWrap: 'wrap',
        background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: 12,
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

      {/* Grid */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {isLoading ? <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spinner /></div>
          : filtered.length === 0 ? (
            <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14, padding: 48, textAlign: 'center', color: 'var(--text3)' }}>
              Закупок немає — додайте першу
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
              {filtered.map(p => (
                <PurchaseCard key={p.id} item={p}
                  onEdit={() => setEditing(p)}
                  onDelete={() => gateDelete(() => delMut.mutateAsync(p.id)).catch(() => {})}
                />
              ))}
            </div>
          )
        }
      </div>

      <PurchaseFormModal open={adding || !!editing} item={editing} onClose={() => { setAdding(false); setEditing(null) }}
        onSaved={() => qc.invalidateQueries(['purchases'])} />
    </div>
  )
}

function StatCell({ label, value, color, icon }) {
  return (
    <div style={{
      flex: '1 1 110px',
      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10,
      padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 2,
    }}>
      <span style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {icon} {label}
      </span>
      <span style={{ fontSize: 20, fontWeight: 700, color }}>{value}</span>
    </div>
  )
}

function PurchaseCard({ item, onEdit, onDelete }) {
  const cat = CATEGORIES.find(c => c.key === item.category) || CATEGORIES[CATEGORIES.length - 1]
  const st = STATUS[item.status] || STATUS.active
  const StIcon = st.icon
  const [showPwd, setShowPwd] = useState(false)
  const daysLeft = item.expires_at ? Math.ceil((new Date(item.expires_at) - Date.now()) / 86400000) : null
  const expSoon = daysLeft != null && daysLeft >= 0 && daysLeft <= 14

  function copy(text, label) {
    navigator.clipboard.writeText(text || '')
    toast.success(`${label} скопійовано`)
  }

  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12,
      padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
      transition: 'all 0.15s',
    }}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border2)'}
      onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}
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
        <div style={{ display: 'flex', gap: 4 }}>
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

      {/* Creds */}
      {(item.login || item.password) && (
        <div style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {item.login && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span style={{ color: 'var(--text3)', minWidth: 50 }}>Логін</span>
              <span style={{ flex: 1, fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.login}</span>
              <button onClick={() => copy(item.login, 'Логін')} style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer' }}><Copy size={11} /></button>
            </div>
          )}
          {item.password && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span style={{ color: 'var(--text3)', minWidth: 50 }}>Пароль</span>
              <span style={{ flex: 1, fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {showPwd ? item.password : '••••••••••'}
              </span>
              <button onClick={() => setShowPwd(s => !s)} style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer' }}>
                {showPwd ? <EyeOff size={11} /> : <Eye size={11} />}
              </button>
              <button onClick={() => copy(item.password, 'Пароль')} style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer' }}><Copy size={11} /></button>
            </div>
          )}
        </div>
      )}

      {/* Footer info */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', fontSize: 11 }}>
        <Badge color={st.color}><StIcon size={10} /> {st.label}</Badge>
        {item.cost_amount && (
          <Badge color="default">{item.cost_amount} {item.cost_currency || ''}</Badge>
        )}
        {item.expires_at && (
          <Badge color={daysLeft != null && daysLeft < 0 ? 'red' : expSoon ? 'yellow' : 'default'}>
            <Clock size={10} />
            {daysLeft != null && daysLeft < 0
              ? `Прострочено ${Math.abs(daysLeft)}д`
              : daysLeft != null ? `${daysLeft}д лишилось` : new Date(item.expires_at).toLocaleDateString('uk-UA')}
          </Badge>
        )}
        {item.url && (
          <a href={item.url} target="_blank" rel="noreferrer"
            style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <ExternalLink size={11} /> open
          </a>
        )}
      </div>

      {item.notes && (
        <div style={{ fontSize: 11, color: 'var(--text3)', whiteSpace: 'pre-wrap', lineHeight: 1.45, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          {item.notes.length > 140 ? item.notes.slice(0, 140) + '…' : item.notes}
        </div>
      )}
    </div>
  )
}

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
          <input value={form.url} onChange={e => set('url', e.target.value)} placeholder="https://console.hetzner.cloud/..." />
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
