import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  Plus, Trash2, Pencil, Check, X, Wallet, KeyRound, Server, Sparkles,
  HardDrive, ShieldCheck, Clock, AlertTriangle, Eye, EyeOff, Copy,
} from 'lucide-react'
import {
  getPayments, createPayment, updatePayment, deletePayment, markPaymentPaid, getTeams,
} from '../api/client'
import { Btn, Badge, Modal, Spinner, Field } from '../components/ui/index'
import { useAuthStore } from '../store/auth'
import { useDeleteOtp } from '../context/DeleteOtpContext'

const CATEGORIES = [
  { key: 'license', label: 'Ліцензії',     icon: KeyRound,     color: '#a855f7' },
  { key: 'klo',      label: 'КЛО',          icon: ShieldCheck,  color: '#2e9cee' },
  { key: 'server',   label: 'Сервери',      icon: Server,       color: '#22c55e' },
  { key: 'ai',       label: 'Підписки AI',  icon: Sparkles,     color: '#f59e0b' },
  { key: 'vds',      label: 'ВДС',          icon: HardDrive,    color: '#f48120' },
  { key: 'other',    label: 'Інше',         icon: Wallet,       color: 'var(--text3)' },
]
const CAT_MAP = Object.fromEntries(CATEGORIES.map(c => [c.key, c]))
const WARN_DAYS = 5

function daysLeft(dueAt) {
  if (!dueAt) return null
  return Math.floor((new Date(dueAt).getTime() - Date.now()) / 86400000)
}

function urgency(dueAt) {
  const d = daysLeft(dueAt)
  if (d === null) return { color: 'default', label: '— без дати —' }
  if (d < 0) return { color: 'red', label: `Прострочено ${-d}д` }
  if (d === 0) return { color: 'red', label: 'Сьогодні' }
  if (d === 1) return { color: 'yellow', label: 'Завтра' }
  if (d <= WARN_DAYS) return { color: 'yellow', label: `За ${d}д` }
  return { color: 'green', label: `За ${d}д` }
}

export default function PaymentsPage() {
  const { user } = useAuthStore()
  const isAdmin = user?.role === 'admin'
  const qc = useQueryClient()
  const { gateDelete } = useDeleteOtp()
  const [catFilter, setCatFilter] = useState('')
  const [formModal, setFormModal] = useState(null) // null | 'new' | payment object

  const { data: payments = [], isLoading } = useQuery({
    queryKey: ['payments'],
    queryFn: () => getPayments().then(r => r.data),
  })
  const { data: teams = [] } = useQuery({
    queryKey: ['teams'],
    queryFn: () => getTeams().then(r => r.data),
  })
  const teamName = (id) => teams.find(t => t.id === id)?.name

  const markPaidMut = useMutation({
    mutationFn: (id) => markPaymentPaid(id),
    onSuccess: () => { toast.success('Позначено оплаченим, дату перенесено'); qc.invalidateQueries({ queryKey: ['payments'] }) },
    onError: () => toast.error('Помилка'),
  })
  const delMut = useMutation({
    mutationFn: (id) => deletePayment(id),
    onSuccess: () => { toast.success('Видалено'); qc.invalidateQueries({ queryKey: ['payments'] }) },
  })

  const dueSoon = useMemo(() => payments.filter(p => {
    const d = daysLeft(p.next_due_at)
    return d !== null && d <= WARN_DAYS
  }), [payments])

  const filtered = catFilter ? payments.filter(p => p.category === catFilter) : payments
  const counts = useMemo(() => {
    const m = {}
    payments.forEach(p => { m[p.category] = (m[p.category] || 0) + 1 })
    return m
  }, [payments])

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontWeight: 800, fontSize: 22, display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <Wallet size={22} style={{ color: 'var(--accent)' }} /> Оплати
          </h1>
          <p style={{ color: 'var(--text3)', fontSize: 12, marginTop: 2 }}>
            Ліцензії, КЛО, сервери, підписки AI, ВДС — все, що треба регулярно оплачувати. За {WARN_DAYS}д до дати адмінам приходить нагадування в Telegram.
          </p>
        </div>
        {isAdmin && (
          <Btn onClick={() => setFormModal('new')}><Plus size={14} /> Додати оплату</Btn>
        )}
      </div>

      {dueSoon.length > 0 && (
        <div style={{
          background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)',
          borderRadius: 10, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <AlertTriangle size={16} style={{ color: 'var(--red)', flexShrink: 0 }} />
          <span style={{ fontSize: 13 }}>
            <strong style={{ color: 'var(--red)' }}>{dueSoon.length}</strong> оплат{dueSoon.length === 1 ? 'а' : ''} треба зробити найближчим часом (≤{WARN_DAYS}д або прострочено)
          </span>
        </div>
      )}

      {/* Category filter */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button onClick={() => setCatFilter('')}
          style={{
            padding: '6px 12px', borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: 'pointer',
            background: !catFilter ? 'var(--accent)' : 'var(--bg2)', color: !catFilter ? '#fff' : 'var(--text3)',
            border: '1px solid var(--border)',
          }}>Всі ({payments.length})</button>
        {CATEGORIES.map(c => (
          <button key={c.key} onClick={() => setCatFilter(c.key === catFilter ? '' : c.key)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '6px 12px', borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: 'pointer',
              background: catFilter === c.key ? c.color : 'var(--bg2)',
              color: catFilter === c.key ? '#fff' : 'var(--text3)',
              border: '1px solid var(--border)',
            }}>
            <c.icon size={12} /> {c.label} ({counts[c.key] || 0})
          </button>
        ))}
      </div>

      {isLoading ? <Spinner /> : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 48, color: 'var(--text3)' }}>
          {catFilter ? 'Немає оплат у цій категорії' : 'Ще немає жодної оплати — додай першу.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map(p => (
            <PaymentRow key={p.id} payment={p} team={teamName(p.team_id)}
              isAdmin={isAdmin}
              onMarkPaid={() => markPaidMut.mutate(p.id)}
              onEdit={() => setFormModal(p)}
              onDelete={() => gateDelete(() => delMut.mutateAsync(p.id)).catch(() => {})}
            />
          ))}
        </div>
      )}

      <PaymentFormModal
        open={!!formModal}
        payment={formModal === 'new' ? null : formModal}
        teams={teams}
        onClose={() => setFormModal(null)}
        onSuccess={() => { qc.invalidateQueries({ queryKey: ['payments'] }); setFormModal(null) }}
      />
    </div>
  )
}

function PaymentRow({ payment: p, team, isAdmin, onMarkPaid, onEdit, onDelete }) {
  const [showPass, setShowPass] = useState(false)
  const cat = CAT_MAP[p.category] || CAT_MAP.other
  const u = urgency(p.next_due_at)

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px',
    }}>
      <div style={{
        width: 34, height: 34, borderRadius: 8, flexShrink: 0,
        background: `color-mix(in srgb, ${cat.color} 18%, transparent)`, color: cat.color,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <cat.icon size={15} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>{p.label}</span>
          {p.provider && <span style={{ fontSize: 11, color: 'var(--text3)' }}>· {p.provider}</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text3)', marginTop: 2, flexWrap: 'wrap' }}>
          {team && <Badge color="blue">{team}</Badge>}
          {p.login && <span style={{ fontFamily: 'var(--mono)' }}>{p.login}</span>}
          {p.password && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--mono)' }}>
              {showPass ? p.password : '••••••••'}
              <button onClick={() => setShowPass(s => !s)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 0 }}>
                {showPass ? <EyeOff size={11} /> : <Eye size={11} />}
              </button>
              <button onClick={() => { navigator.clipboard.writeText(p.password); toast.success('Скопійовано') }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 0 }}>
                <Copy size={11} />
              </button>
            </span>
          )}
        </div>
      </div>

      {p.cost_amount && (
        <div style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text2)', whiteSpace: 'nowrap' }}>
          {p.cost_amount} {p.cost_currency}
          <div style={{ fontSize: 10, color: 'var(--text3)' }}>кожні {p.billing_period_months} міс</div>
        </div>
      )}

      <div style={{ textAlign: 'right', minWidth: 110 }}>
        <Badge color={u.color}><Clock size={10} /> {u.label}</Badge>
        {p.next_due_at && (
          <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>
            {new Date(p.next_due_at).toLocaleDateString('uk-UA')}
          </div>
        )}
      </div>

      {isAdmin && (
        <div style={{ display: 'flex', gap: 4 }}>
          <Btn size="sm" variant="success" onClick={onMarkPaid} title="Позначити оплаченим — перенесе дату вперед">
            <Check size={12} /> Оплачено
          </Btn>
          <Btn size="sm" variant="ghost" onClick={onEdit} title="Редагувати"><Pencil size={12} /></Btn>
          <Btn size="sm" variant="danger" onClick={onDelete}><Trash2 size={12} /></Btn>
        </div>
      )}
    </div>
  )
}

function PaymentFormModal({ open, payment, teams, onClose, onSuccess }) {
  const isEdit = !!payment
  const [form, setForm] = useState(() => emptyForm(payment))
  const [loading, setLoading] = useState(false)

  useMemo(() => { if (open) setForm(emptyForm(payment)) }, [open, payment?.id])

  function emptyForm(p) {
    return {
      category: p?.category || 'license',
      label: p?.label || '',
      provider: p?.provider || '',
      team_id: p?.team_id || '',
      login: p?.login || '',
      password: p?.password || '',
      cost_amount: p?.cost_amount || '',
      cost_currency: p?.cost_currency || 'USD',
      billing_period_months: p?.billing_period_months || 1,
      next_due_at: p?.next_due_at ? new Date(p.next_due_at).toISOString().slice(0, 10) : '',
      notes: p?.notes || '',
    }
  }

  async function submit() {
    if (!form.label.trim()) return
    setLoading(true)
    try {
      const payload = {
        ...form,
        team_id: form.team_id ? parseInt(form.team_id) : null,
        billing_period_months: parseInt(form.billing_period_months) || 1,
        next_due_at: form.next_due_at ? `${form.next_due_at}T00:00:00Z` : null,
      }
      if (isEdit) await updatePayment(payment.id, payload)
      else await createPayment(payload)
      toast.success(isEdit ? 'Оновлено' : 'Додано')
      onSuccess()
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Помилка збереження')
    } finally { setLoading(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? `Редагувати: ${payment.label}` : 'Нова оплата'} width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Категорія">
          <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
            {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </Field>
        <Field label="Назва"><input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} placeholder="напр. Binom license fb1" /></Field>
        <div style={{ display: 'flex', gap: 10 }}>
          <Field label="Провайдер / сервіс" style={{ flex: 1 }}>
            <input value={form.provider} onChange={e => setForm(f => ({ ...f, provider: e.target.value }))} placeholder="binom.org" />
          </Field>
          <Field label="Команда" style={{ flex: 1 }}>
            <select value={form.team_id} onChange={e => setForm(f => ({ ...f, team_id: e.target.value }))}>
              <option value="">— без команди —</option>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <Field label="Логін / email" style={{ flex: 1 }}>
            <input value={form.login} onChange={e => setForm(f => ({ ...f, login: e.target.value }))} autoComplete="off" />
          </Field>
          <Field label="Пароль" style={{ flex: 1 }}>
            <input value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              autoComplete="off" data-lpignore="true" data-1p-ignore style={{ fontFamily: 'var(--mono)' }} />
          </Field>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <Field label="Сума" style={{ flex: 1 }}>
            <input value={form.cost_amount} onChange={e => setForm(f => ({ ...f, cost_amount: e.target.value }))} placeholder="19.99" />
          </Field>
          <Field label="Валюта" style={{ flex: 1 }}>
            <input value={form.cost_currency} onChange={e => setForm(f => ({ ...f, cost_currency: e.target.value }))} placeholder="USD" />
          </Field>
          <Field label="Період (міс)" style={{ flex: 1 }}>
            <input type="number" min="1" value={form.billing_period_months}
              onChange={e => setForm(f => ({ ...f, billing_period_months: e.target.value }))} />
          </Field>
        </div>
        <Field label="Наступна дата оплати">
          <input type="date" value={form.next_due_at} onChange={e => setForm(f => ({ ...f, next_due_at: e.target.value }))} />
        </Field>
        <Field label="Нотатки">
          <textarea rows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={{ resize: 'vertical' }} />
        </Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>Скасувати</Btn>
          <Btn loading={loading} disabled={!form.label.trim()} onClick={submit}>
            <Check size={13} /> Зберегти
          </Btn>
        </div>
      </div>
    </Modal>
  )
}
